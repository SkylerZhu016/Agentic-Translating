import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { BudgetLedger, acquireLock, digest, MODEL, DEFAULT_MAX_TOKENS, validateUsage } from './budget-ledger.mjs'

export const UPSTREAM = 'https://api.deepseek.com/chat/completions'
export const ALLOWED_PROXY = 'http://127.0.0.1:7892'
export const LOCAL_KEY = 'quality-eval-loopback-only'
// Product complete(): RETRY_DELAYS_MS [1000, 3000, 8000] + initial attempt.
export const MAX_PHYSICAL_ATTEMPTS_PER_HASH = 4

export function normalizeRequest(body, maxTokens = DEFAULT_MAX_TOKENS) {
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 256) throw new Error('invalid_messages')
  if (body.tools?.length || body.tool_choice || body.functions || body.function_call) throw new Error('tools_disabled')
  const messages = body.messages.map(message => {
    if (!['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') throw new Error('text_only_messages_required')
    return { role: message.role, content: message.content }
  })
  if (Buffer.byteLength(JSON.stringify(messages), 'utf8') > 500_000) throw new Error('prompt_too_large')
  if (body.response_format !== undefined
      && (body.response_format?.type !== 'json_object' || Object.keys(body.response_format).length !== 1)) throw new Error('unsupported_product_response_format')
  return {
    model: MODEL, messages, thinking: { type: 'enabled' }, reasoning_effort: 'high',
    max_tokens: maxTokens, stream: true, stream_options: { include_usage: true },
    ...(body.response_format ? { response_format: { type: 'json_object' } } : {}),
  }
}

function transportError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

// The key is carried only in the in-memory request. Errors never include request data.
export function sendProvider({ body, apiKey, proxy = null, signal }) {
  return new Promise((resolve, reject) => {
    let tunnel
    const send = socket => {
      const request = https.request(UPSTREAM, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        ...(socket ? { agent: false, createConnection: () => socket } : {}),
      }, resolve)
      request.on('error', error => reject(transportError(error.code === 'ABORT_ERR' ? 'upstream_timeout' : 'connection_failure')))
      request.end(JSON.stringify(body))
    }
    if (!proxy) { send(); return }
    if (proxy !== ALLOWED_PROXY) { reject(transportError('proxy_not_authorized')); return }
    tunnel = http.request(ALLOWED_PROXY, { method: 'CONNECT', path: 'api.deepseek.com:443', signal })
    tunnel.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) { socket.destroy(); reject(transportError('proxy_connection_failure')); return }
      if (head.length) socket.unshift(head)
      const secured = tls.connect({ socket, servername: 'api.deepseek.com' })
      secured.once('error', () => reject(transportError('proxy_connection_failure')))
      secured.once('secureConnect', () => send(secured))
    })
    tunnel.once('error', () => reject(transportError('proxy_connection_failure')))
    tunnel.end()
  })
}

async function collect(response, maxTokens) {
  let pending = ''
  let content = ''
  let reasoningCharacters = 0
  let usage = null
  let finishReason = null
  let providerModel = null
  let providerResponseId = null
  let done = false
  const decoder = new TextDecoder()
  const parse = line => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (data === '[DONE]') { done = true; return }
    if (!data) return
    const item = JSON.parse(data)
    if (typeof item.model === 'string' && /^[\w./:-]{1,160}$/.test(item.model)) providerModel = item.model
    if (typeof item.id === 'string' && /^[\w.:-]{1,256}$/.test(item.id)) providerResponseId = item.id
    const validUsage = validateUsage(item.usage, maxTokens)
    if (validUsage) usage = validUsage
    const choice = item.choices?.[0]
    if (choice?.delta?.tool_calls) throw transportError('unexpected_tool_calls')
    content += typeof choice?.delta?.content === 'string' ? choice.delta.content : ''
    reasoningCharacters += typeof choice?.delta?.reasoning_content === 'string' ? choice.delta.reasoning_content.length : 0
    if (choice?.finish_reason) finishReason = choice.finish_reason
    if (content.length > 2_000_000) throw transportError('response_too_large')
  }
  try {
    for await (const chunk of response) {
      pending += decoder.decode(chunk, { stream: true })
      if (pending.length > 2_000_000) throw transportError('response_line_too_large')
      let index
      while ((index = pending.indexOf('\n')) >= 0) {
        parse(pending.slice(0, index).replace(/\r$/, ''))
        pending = pending.slice(index + 1)
      }
    }
    pending += decoder.decode()
    if (pending.trim()) parse(pending.trim())
  } catch (error) {
    error.partial = { content, usage, reasoningCharacters, finishReason, providerModel, providerResponseId }
    throw error
  }
  if (!done || finishReason !== 'stop' || !content.trim()) {
    const error = transportError(finishReason === 'length' ? 'output_truncated' : 'incomplete_response')
    error.partial = { content, usage, reasoningCharacters, finishReason, providerModel, providerResponseId }
    throw error
  }
  return { content, usage, reasoningCharacters, finishReason, providerModel, providerResponseId }
}

async function errorResponseUsage(response) {
  const chunks = []
  let length = 0
  try {
    for await (const chunk of response) {
      length += chunk.length
      if (length > 262_144) { response.destroy(); return null }
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')).usage ?? null
  } catch { return null }
}

export async function createGateway({
  directory, capRmb, apiKey, port = 0, maxTokens = DEFAULT_MAX_TOKENS,
  fallbackProxy = null, transport = sendProvider, timeoutMs = 900_000,
}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('credential_missing')
  if (fallbackProxy !== null && fallbackProxy !== ALLOWED_PROXY) throw new Error('proxy_not_authorized')
  const release = await acquireLock(directory)
  let ledger
  try {
    ledger = await BudgetLedger.open(directory, capRmb)
    await ledger.reconcilePersistedUsage()
  } catch (error) { await release(); throw error }
  let tail = Promise.resolve()
  let stopping = false
  let context = null
  const queue = job => {
    const result = tail.then(job)
    tail = result.catch(() => {})
    return result
  }
  const execute = async (body, requestContext) => {
    const requestHash = digest(requestContext ? { body, context: requestContext } : body)
    if (stopping) throw new Error('gateway_stopping')
    const previous = ledger.state.attempts.filter(a => a.requestHash === requestHash)
    let retryOf = previous.at(-1)?.id ?? null
    for (const route of ['direct', ...(fallbackProxy ? ['proxy_fallback'] : [])]) {
      if (ledger.state.attempts.filter(a => a.requestHash === requestHash).length >= MAX_PHYSICAL_ATTEMPTS_PER_HASH) throw new Error('request_attempt_limit_reached')
      const attempt = await ledger.reserve(requestHash, maxTokens, route, retryOf, requestContext)
      attempt.providerPolicy = {
        model: body.model, thinking: body.thinking, reasoningEffort: body.reasoning_effort,
        maxTokens: body.max_tokens, stream: body.stream,
        responseFormat: body.response_format ?? null, responseFormatSource: 'product_supplied_only',
        adapterVersion: 'bounded-retry-v2', physicalAttemptsPerHashLimit: MAX_PHYSICAL_ATTEMPTS_PER_HASH,
      }
      await ledger.save()
      const started = Date.now()
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      let response
      try {
        response = await transport({ body, apiKey, proxy: route === 'direct' ? null : fallbackProxy, signal: controller.signal })
        if (response.statusCode !== 200) {
          const usage = await errorResponseUsage(response)
          response.destroy()
          await ledger.finish(attempt, { usage, status: 'http_error', httpStatus: response.statusCode, elapsedMs: Date.now() - started })
          if (route === 'direct' && response.statusCode === 502 && fallbackProxy) { retryOf = attempt.id; continue }
          throw transportError('upstream_http_error')
        }
        const result = await collect(response, maxTokens)
        await ledger.finish(attempt, { ...result, status: 'completed', httpStatus: 200, elapsedMs: Date.now() - started })
        if (attempt.status !== 'completed') throw transportError('usage_missing_or_invalid')
        return result
      } catch (error) {
        if (attempt.status === 'reserved') {
          await ledger.finish(attempt, { ...error.partial, status: error.code === 'output_truncated' ? 'output_truncated' : 'transport_error', httpStatus: response?.statusCode ?? null, elapsedMs: Date.now() - started })
        }
        if (route === 'direct' && error.code === 'connection_failure' && fallbackProxy) { retryOf = attempt.id; continue }
        throw transportError(['output_truncated', 'usage_missing_or_invalid'].includes(error.code) ? error.code : 'provider_attempt_failed')
      } finally {
        clearTimeout(timeout)
        response?.destroy()
      }
    }
    throw new Error('provider_attempt_failed')
  }
  const server = http.createServer(async (request, response) => {
    if (request.url === '/health' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ status: 'ready', model: MODEL, ...ledger.summary() }))
      return
    }
    if (request.method !== 'POST' || !['/v1/chat/completions', '/chat/completions'].includes(request.url)
      || request.headers.authorization !== `Bearer ${LOCAL_KEY}`) {
      response.writeHead(403); response.end(); return
    }
    let timer
    let body
    try {
      const parts = []
      let bytes = 0
      for await (const chunk of request) {
        bytes += chunk.length
        if (bytes > 1_000_000) throw new Error('request_too_large')
        parts.push(chunk)
      }
      const input = JSON.parse(Buffer.concat(parts).toString('utf8'))
      body = normalizeRequest(input, maxTokens)
      const requestContext = context ? { ...context } : null
      if (!input.stream) throw new Error('stream_required')
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      response.write(': queued\n\n')
      timer = setInterval(() => { if (!response.destroyed) response.write(': budget-gateway-active\n\n') }, 5000)
      const result = await queue(async () => {
        if (response.destroyed) throw new Error('client_disconnected_before_dispatch')
        return execute(body, requestContext)
      })
      const chunk = { id: `quality-${digest(body).slice(0, 12)}`, object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta: { content: result.content }, finish_reason: 'stop' }], usage: result.usage }
      response.write(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`)
      response.end()
    } catch (error) {
      // Empty completed stream is deliberately invalid to the product client.
      // Never return provider error text or exception.message (may include secrets).
      if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(response.headersSent && timer
        ? 'data: {"error":{"code":"quality_gateway_stopped"}}\n\n'
        : JSON.stringify({ error: { code: 'quality_gateway_rejected' } }))
    } finally { clearInterval(timer) }
  })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
  } catch (error) { await release(); throw error }
  return {
    ledger, url: `http://127.0.0.1:${server.address().port}`, maxTokens,
    setContext: value => {
      context = value ? Object.fromEntries(['planId', 'condition', 'split', 'sampleId', 'retryRound'].map(key => [key, String(value[key] ?? '')])) : null
    },
    drain: async () => { await tail },
    close: async () => {
      stopping = true
      await tail
      await new Promise(resolve => server.close(resolve))
      await release()
    },
  }
}
