import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptDirectory, '..')
const defaultKeyFile = path.join(
  repositoryRoot,
  '迭代文档',
  '第三轮迭代材料',
  '更换key.txt',
)
const privateReportDirectory = path.join(
  repositoryRoot,
  'FSBP_Test',
  'private',
  'provider-compat',
)

export const ALLOWED_PROVIDER_MODELS = Object.freeze([
  'DeepSeek V4 Flash: Go',
  'Qwen 3.7 Plus: Go',
  'MiniMax M3: Go',
  'Gemini 3.7 Flash: Antigravity',
])

const allowedModels = new Set(ALLOWED_PROVIDER_MODELS)
const allowedProtocols = new Set(['openai-chat', 'anthropic-messages'])
const modelProtocols = new Map([
  ['DeepSeek V4 Flash: Go', 'openai-chat'],
  ['Gemini 3.7 Flash: Antigravity', 'openai-chat'],
  ['Qwen 3.7 Plus: Go', 'anthropic-messages'],
  ['MiniMax M3: Go', 'anthropic-messages'],
])
const EXPECTED_NEWAPI_ORIGIN = 'https://newapi.wingsandasoul.vip'
const HARD_TIMEOUT_MS = 900_000
const PROBE_MAX_TOKENS = 4_096
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_SSE_LINES = 100_000
const PROBE_PROMPT = 'Return the single uppercase word OK and nothing else.'

const KNOWN_JSON_KEYS = new Set([
  'id',
  'object',
  'created',
  'model',
  'service_tier',
  'system_fingerprint',
  'type',
  'index',
  'role',
  'content',
  'text',
  'delta',
  'message',
  'choices',
  'reasoning_content',
  'reasoning_content_delta',
  'reasoning',
  'thinking',
  'analysis',
  'output_text',
  'refusal',
  'annotations',
  'audio',
  'tool_calls',
  'function_call',
  'input',
  'name',
  'finish_reason',
  'stop_reason',
  'stop_sequence',
  'logprobs',
  'usage',
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'input_tokens',
  'output_tokens',
  'prompt_tokens_details',
  'completion_tokens_details',
  'cached_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'audio_tokens',
  'reasoning_tokens',
  'accepted_prediction_tokens',
  'rejected_prediction_tokens',
  'error',
  'status',
  'code',
  'param',
])

const TEXT_VALUE_KEYS = new Set([
  'content',
  'text',
  'reasoning_content',
  'reasoning_content_delta',
  'reasoning',
  'thinking',
  'analysis',
  'output_text',
  'refusal',
  'message',
])

const KNOWN_FINISH_REASONS = new Set([
  'stop',
  'length',
  'content_filter',
  'tool_calls',
  'function_call',
])

const KNOWN_STOP_REASONS = new Set([
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
  'pause_turn',
  'refusal',
])

const KNOWN_SSE_EVENT_TYPES = new Set([
  'message_start',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'message_delta',
  'message_stop',
  'ping',
  'error',
  'completion',
])

export class ProviderCompatProbeError extends Error {
  constructor(code, type = 'probe_error', status = null) {
    super(code)
    this.name = 'ProviderCompatProbeError'
    this.code = code
    this.type = type
    this.status = Number.isInteger(status) ? status : null
  }
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function stringShape(value) {
  return {
    type: 'string',
    characters: Array.from(value).length,
    bytes: Buffer.byteLength(value, 'utf8'),
    sha256: digest(value),
  }
}

function safeKeySegment(value) {
  if (KNOWN_JSON_KEYS.has(value)) return value
  return `$key_sha256_${digest(value).slice(0, 16)}`
}

function reasonCategory(value, known) {
  if (value === null) return 'null'
  if (typeof value !== 'string') return `type_${typeof value}`
  return known.has(value) ? value : `other_sha256_${digest(value).slice(0, 16)}`
}

function eventTypeCategory(value) {
  if (value === null) return null
  if (KNOWN_SSE_EVENT_TYPES.has(value)) return value
  return `other_sha256_${digest(value).slice(0, 16)}`
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isJsonWhitespace(character) {
  return character === ' ' || character === '\t' ||
    character === '\r' || character === '\n'
}

function parseStrictStringObject(source) {
  let cursor = 0
  const result = Object.create(null)
  const seen = new Set()
  const skipWhitespace = () => {
    while (isJsonWhitespace(source[cursor])) cursor += 1
  }
  const expect = (character) => {
    skipWhitespace()
    if (source[cursor] !== character) {
      throw new ProviderCompatProbeError('key_file_invalid_json')
    }
    cursor += 1
  }
  const stringToken = () => {
    skipWhitespace()
    if (source[cursor] !== '"') {
      throw new ProviderCompatProbeError('key_file_invalid_shape')
    }
    const start = cursor
    cursor += 1
    let escaped = false
    while (cursor < source.length) {
      const character = source[cursor]
      cursor += 1
      if (escaped) {
        escaped = false
        continue
      }
      if (character === '\\') {
        escaped = true
        continue
      }
      if (character === '"') {
        try {
          return JSON.parse(source.slice(start, cursor))
        } catch {
          throw new ProviderCompatProbeError('key_file_invalid_json')
        }
      }
    }
    throw new ProviderCompatProbeError('key_file_invalid_json')
  }

  expect('{')
  skipWhitespace()
  if (source[cursor] === '}') {
    cursor += 1
  } else {
    while (true) {
      const key = stringToken()
      if (seen.has(key)) {
        throw new ProviderCompatProbeError('key_file_duplicate_field')
      }
      seen.add(key)
      expect(':')
      result[key] = stringToken()
      skipWhitespace()
      if (source[cursor] === '}') {
        cursor += 1
        break
      }
      expect(',')
    }
  }
  skipWhitespace()
  if (cursor !== source.length) {
    throw new ProviderCompatProbeError('key_file_invalid_json')
  }
  return result
}

export function parseStrictConnectionJson(contents) {
  if (typeof contents !== 'string') {
    throw new ProviderCompatProbeError('key_file_not_text')
  }
  let source = contents.startsWith('\uFEFF') ? contents.slice(1) : contents
  if (source.includes('\uFEFF')) {
    throw new ProviderCompatProbeError('key_file_invalid_json')
  }
  let start = 0
  let end = source.length
  while (start < end && isJsonWhitespace(source[start])) start += 1
  while (end > start && isJsonWhitespace(source[end - 1])) end -= 1
  source = source.slice(start, end)
  let connection
  try {
    connection = parseStrictStringObject(source)
  } catch (error) {
    if (error instanceof ProviderCompatProbeError) throw error
    throw new ProviderCompatProbeError('key_file_invalid_json')
  }
  if (!isPlainObject(connection)) {
    throw new ProviderCompatProbeError('key_file_invalid_shape')
  }
  const keys = Object.keys(connection).sort()
  if (
    keys.length !== 3 ||
    keys[0] !== '_type' || keys[1] !== 'key' || keys[2] !== 'url' ||
    connection._type !== 'newapi_channel_conn'
  ) {
    throw new ProviderCompatProbeError('key_file_invalid_shape')
  }
  if (
    typeof connection.key !== 'string' ||
    !connection.key.trim() ||
    /[\u0000-\u001f\u007f]/.test(connection.key)
  ) {
    throw new ProviderCompatProbeError('key_file_invalid_key')
  }
  if (typeof connection.url !== 'string' || !connection.url) {
    throw new ProviderCompatProbeError('key_file_invalid_url')
  }
  let parsed
  try {
    parsed = new URL(connection.url)
  } catch {
    throw new ProviderCompatProbeError('key_file_invalid_url')
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== EXPECTED_NEWAPI_ORIGIN ||
    parsed.username || parsed.password || parsed.search || parsed.hash ||
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    connection.url.includes('?') || connection.url.includes('#')
  ) {
    throw new ProviderCompatProbeError('key_file_invalid_url')
  }
  return {
    apiKey: connection.key.trim(),
    baseUrl: EXPECTED_NEWAPI_ORIGIN,
  }
}

function assertModelProtocol(model, protocol) {
  if (!allowedModels.has(model)) {
    throw new ProviderCompatProbeError('model_not_allowed')
  }
  if (!allowedProtocols.has(protocol)) {
    throw new ProviderCompatProbeError('protocol_not_allowed')
  }
  if (modelProtocols.get(model) !== protocol) {
    throw new ProviderCompatProbeError('model_protocol_mismatch')
  }
}

function takeValue(argv, index, inlineValue) {
  const value = inlineValue ?? argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new ProviderCompatProbeError('missing_argument_value')
  }
  return value
}

export function parseProviderProbeArguments(argv) {
  const result = {
    execute: false,
    keyFile: defaultKeyFile,
    model: null,
    protocol: null,
    timeoutMs: HARD_TIMEOUT_MS,
    out: null,
  }
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const equals = argument.indexOf('=')
    const name = equals >= 0 ? argument.slice(0, equals) : argument
    const inlineValue = equals >= 0 ? argument.slice(equals + 1) : null
    if (name === '--execute') {
      if (inlineValue !== null || seen.has(name)) {
        throw new ProviderCompatProbeError('invalid_execute_argument')
      }
      seen.add(name)
      result.execute = true
      continue
    }
    if (!['--key-file', '--model', '--protocol', '--timeout-ms', '--out'].includes(name)) {
      throw new ProviderCompatProbeError('invalid_argument')
    }
    if (seen.has(name)) throw new ProviderCompatProbeError('duplicate_argument')
    seen.add(name)
    const value = takeValue(argv, index, inlineValue)
    if (inlineValue === null) index += 1
    if (name === '--key-file') result.keyFile = path.resolve(value)
    if (name === '--model') result.model = value
    if (name === '--protocol') result.protocol = value
    if (name === '--out') {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.json$/.test(value) || value.includes('..')) {
        throw new ProviderCompatProbeError('invalid_output_name')
      }
      result.out = value
    }
    if (name === '--timeout-ms') {
      const timeoutMs = Number(value)
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > HARD_TIMEOUT_MS) {
        throw new ProviderCompatProbeError('invalid_timeout')
      }
      result.timeoutMs = timeoutMs
    }
  }
  if (!result.execute) throw new ProviderCompatProbeError('execute_flag_required')
  assertModelProtocol(result.model, result.protocol)
  return result
}

export function buildProviderRequest({ baseUrl, apiKey, model, protocol }) {
  assertModelProtocol(model, protocol)
  let normalizedBase
  try {
    const parsed = new URL(baseUrl)
    if (
      parsed.protocol !== 'https:' ||
      parsed.origin !== EXPECTED_NEWAPI_ORIGIN ||
      parsed.origin !== baseUrl ||
      parsed.username || parsed.password || parsed.search || parsed.hash
    ) {
      throw new Error('invalid')
    }
    normalizedBase = parsed.origin
  } catch {
    throw new ProviderCompatProbeError('request_base_invalid')
  }
  if (typeof apiKey !== 'string' || !apiKey) {
    throw new ProviderCompatProbeError('request_key_invalid')
  }

  if (protocol === 'openai-chat') {
    return {
      url: `${normalizedBase}/v1/chat/completions`,
      headers: {
        accept: 'text/event-stream, application/json',
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: {
        model,
        messages: [{ role: 'user', content: PROBE_PROMPT }],
        max_tokens: PROBE_MAX_TOKENS,
        stream: true,
        stream_options: { include_usage: true },
      },
    }
  }
  return {
    url: `${normalizedBase}/v1/messages`,
    headers: {
      accept: 'text/event-stream, application/json',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'x-api-key': apiKey,
    },
    body: {
      model,
      max_tokens: PROBE_MAX_TOKENS,
      messages: [{ role: 'user', content: PROBE_PROMPT }],
      stream: true,
    },
  }
}

function addShape(entries, pathName, descriptor) {
  entries.push({ path: pathName, ...descriptor })
}

function inspectJsonValue(value, pathName, entries, evidence, context = {}) {
  if (value === null) {
    addShape(entries, pathName, { type: 'null' })
    if (context.key === 'finish_reason') evidence.finishReasons.push('null')
    if (context.key === 'stop_reason') evidence.stopReasons.push('null')
    return
  }
  if (Array.isArray(value)) {
    addShape(entries, pathName, { type: 'array', length: value.length })
    for (const child of value) {
      inspectJsonValue(child, `${pathName}[]`, entries, evidence, context)
    }
    return
  }
  if (isPlainObject(value)) {
    addShape(entries, pathName, { type: 'object', fields: Object.keys(value).length })
    for (const [key, child] of Object.entries(value)) {
      const safeKey = safeKeySegment(key)
      inspectJsonValue(
        child,
        `${pathName}.${safeKey}`,
        entries,
        evidence,
        { inUsage: context.inUsage || key === 'usage', key },
      )
    }
    return
  }
  if (typeof value === 'string') {
    addShape(entries, pathName, stringShape(value))
    if (context.key === 'finish_reason') {
      evidence.finishReasons.push(reasonCategory(value, KNOWN_FINISH_REASONS))
    }
    if (context.key === 'stop_reason') {
      evidence.stopReasons.push(reasonCategory(value, KNOWN_STOP_REASONS))
    }
    if (TEXT_VALUE_KEYS.has(context.key)) {
      evidence.textFields.push({ path: pathName, ...stringShape(value) })
    }
    return
  }
  if (typeof value === 'number') {
    const descriptor = Number.isFinite(value)
      ? { type: 'number', finite: true }
      : { type: 'number', finite: false }
    addShape(entries, pathName, descriptor)
    if (context.inUsage && Number.isFinite(value)) {
      evidence.usage.push({ path: pathName, value })
    }
    return
  }
  if (typeof value === 'boolean') {
    addShape(entries, pathName, { type: 'boolean' })
    return
  }
  addShape(entries, pathName, { type: typeof value })
}

export function inspectJsonShape(value) {
  const entries = []
  const evidence = {
    finishReasons: [],
    stopReasons: [],
    usage: [],
    textFields: [],
  }
  inspectJsonValue(value, '$', entries, evidence)
  entries.sort((left, right) => left.path.localeCompare(right.path))
  evidence.finishReasons.sort()
  evidence.stopReasons.sort()
  evidence.usage.sort((left, right) => left.path.localeCompare(right.path))
  evidence.textFields.sort((left, right) => left.path.localeCompare(right.path))
  return { paths: entries, ...evidence }
}

function makeTransport() {
  return {
    bytes: 0,
    chunks: 0,
    minimumChunkBytes: null,
    maximumChunkBytes: 0,
  }
}

function addChunk(transport, byteLength) {
  transport.bytes += byteLength
  transport.chunks += 1
  transport.minimumChunkBytes = transport.minimumChunkBytes === null
    ? byteLength
    : Math.min(transport.minimumChunkBytes, byteLength)
  transport.maximumChunkBytes = Math.max(transport.maximumChunkBytes, byteLength)
  if (transport.bytes > MAX_RESPONSE_BYTES) {
    throw new ProviderCompatProbeError('response_too_large', 'transport_error')
  }
}

function inspectDataPayload(data, index, eventField, idField, dataLineCount, eofTerminated) {
  const base = {
    index,
    eventType: eventTypeCategory(eventField),
    eventId: idField === null ? null : stringShape(idField),
    dataLines: dataLineCount,
    data: stringShape(data),
    eofTerminated,
  }
  if (!data.trim()) return { ...base, kind: 'empty' }
  if (data.trim() === '[DONE]') return { ...base, kind: 'done' }
  try {
    return { ...base, kind: 'json', json: inspectJsonShape(JSON.parse(data)) }
  } catch {
    return { ...base, kind: 'malformed_json' }
  }
}

function isCompletePayload(data) {
  const trimmed = data.trim()
  if (!trimmed) return false
  if (trimmed === '[DONE]') return true
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

function lineDelimitedPayloads(lines) {
  const payloads = []
  for (const line of lines) {
    if (!isCompletePayload(line)) return null
    payloads.push({ data: line, lineCount: 1 })
  }
  return payloads
}

export function createSafeSseInspector() {
  const decoder = new TextDecoder()
  const transport = makeTransport()
  const events = []
  const framing = {
    crlf: 0,
    lf: 0,
    cr: 0,
    blankLineDelimiters: 0,
    dataLines: 0,
    eventLines: 0,
    idLines: 0,
    retryLines: 0,
    commentLines: 0,
    unknownFieldLines: 0,
  }
  let pending = ''
  let eventField = null
  let idField = null
  let dataLines = []
  let eventSegments = []
  let processedLines = 0
  let ended = false

  function resetBlock() {
    eventField = null
    dataLines = []
    eventSegments = []
  }

  function finishCurrentSegment() {
    if (!dataLines.length) return
    eventSegments.push({
      eventField,
      idField,
      dataLines,
    })
    dataLines = []
  }

  function dispatch(eofTerminated = false) {
    const segments = [...eventSegments]
    if (dataLines.length) {
      segments.push({ eventField, idField, dataLines })
    }
    const combinedLines = []
    for (const segment of segments) {
      for (const line of segment.dataLines) combinedLines.push(line)
    }
    if (!combinedLines.length) {
      resetBlock()
      return
    }
    const data = combinedLines.join('\n')
    // A blank-line boundary is always standard SSE and therefore always joins
    // every data line into one event, even when the resulting application
    // payload is not JSON. At EOF, Anthropic's no-blank compatibility framing
    // is accepted only when two or more explicit event+data segments are each
    // complete. For unnamed NewAPI framing, every physical data line must be
    // a complete JSON/[DONE] payload. Both fallbacks are one-pass and bounded
    // by MAX_RESPONSE_BYTES and MAX_SSE_LINES.
    const anthropicSegments = eofTerminated && segments.length > 1 &&
      segments.every((segment) => (
        segment.eventField !== null &&
        isCompletePayload(segment.dataLines.join('\n'))
      ))
      ? segments
      : null
    const linePayloads = eofTerminated && eventSegments.length === 0 &&
      eventField === null && !isCompletePayload(data)
      ? lineDelimitedPayloads(combinedLines)
      : null
    if (anthropicSegments) {
      for (const segment of anthropicSegments) {
        events.push(inspectDataPayload(
          segment.dataLines.join('\n'),
          events.length,
          segment.eventField,
          segment.idField,
          segment.dataLines.length,
          eofTerminated,
        ))
      }
    } else if (linePayloads && linePayloads.length > 1) {
      for (const payload of linePayloads) {
        events.push(inspectDataPayload(
          payload.data,
          events.length,
          null,
          idField,
          payload.lineCount,
          eofTerminated,
        ))
      }
    } else {
      events.push(inspectDataPayload(
        data,
        events.length,
        eventField,
        idField,
        combinedLines.length,
        eofTerminated,
      ))
    }
    resetBlock()
  }

  function processLine(line) {
    processedLines += 1
    if (processedLines > MAX_SSE_LINES) {
      throw new ProviderCompatProbeError('response_too_many_sse_lines', 'transport_error')
    }
    if (line === '') {
      framing.blankLineDelimiters += 1
      dispatch(false)
      return
    }
    if (line.startsWith(':')) {
      framing.commentLines += 1
      return
    }
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') {
      framing.dataLines += 1
      dataLines.push(value)
    } else if (field === 'event') {
      framing.eventLines += 1
      finishCurrentSegment()
      eventField = value
    } else if (field === 'id') {
      framing.idLines += 1
      idField = value
    } else if (field === 'retry') {
      framing.retryLines += 1
    } else {
      framing.unknownFieldLines += 1
    }
  }

  function consume(final) {
    let cursor = 0
    for (let index = 0; index < pending.length; index += 1) {
      const character = pending[index]
      if (character !== '\r' && character !== '\n') continue
      if (character === '\r' && index + 1 === pending.length && !final) break
      processLine(pending.slice(cursor, index))
      if (character === '\r' && pending[index + 1] === '\n') {
        framing.crlf += 1
        index += 1
      } else if (character === '\r') {
        framing.cr += 1
      } else {
        framing.lf += 1
      }
      cursor = index + 1
    }
    pending = pending.slice(cursor)
    if (final && pending.length) {
      processLine(pending)
      pending = ''
    }
  }

  return {
    push(chunk) {
      if (ended) throw new ProviderCompatProbeError('inspector_already_ended')
      addChunk(transport, chunk.byteLength)
      pending += decoder.decode(chunk, { stream: true })
      consume(false)
    },
    end() {
      if (ended) throw new ProviderCompatProbeError('inspector_already_ended')
      ended = true
      pending += decoder.decode()
      consume(true)
      if (dataLines.length || eventField !== null) dispatch(true)
      return { transport, framing, events }
    },
  }
}

async function readSse(response) {
  if (!response.body) {
    throw new ProviderCompatProbeError('missing_response_body', 'transport_error')
  }
  const reader = response.body.getReader()
  const inspector = createSafeSseInspector()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      inspector.push(value)
    }
  } catch (error) {
    if (error instanceof ProviderCompatProbeError) throw error
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new ProviderCompatProbeError('timeout', 'transport_error')
    }
    throw new ProviderCompatProbeError('stream_read_failed', 'transport_error')
  }
  return inspector.end()
}

async function readJson(response) {
  if (!response.body) {
    throw new ProviderCompatProbeError('missing_response_body', 'transport_error')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const transport = makeTransport()
  let body = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      addChunk(transport, value.byteLength)
      body += decoder.decode(value, { stream: true })
    }
    body += decoder.decode()
  } catch (error) {
    if (error instanceof ProviderCompatProbeError) throw error
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new ProviderCompatProbeError('timeout', 'transport_error')
    }
    throw new ProviderCompatProbeError('response_read_failed', 'transport_error')
  }
  const data = stringShape(body)
  try {
    return {
      transport,
      events: [{ index: 0, kind: 'json', data, json: inspectJsonShape(JSON.parse(body)) }],
    }
  } catch {
    return { transport, events: [{ index: 0, kind: 'malformed_json', data }] }
  } finally {
    body = ''
  }
}

function classifyContentType(value) {
  const normalized = value.toLowerCase()
  if (normalized.includes('text/event-stream')) return 'text_event_stream'
  if (normalized.includes('application/json')) return 'application_json'
  return value ? 'other' : 'missing'
}

function safeFailure(error, status = null) {
  if (error instanceof ProviderCompatProbeError) {
    return {
      type: error.type,
      code: error.code,
      status: error.status ?? status,
    }
  }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return { type: 'transport_error', code: 'timeout', status }
  }
  return { type: 'transport_error', code: 'request_failed', status }
}

export async function runProviderCompatProbe({
  keyFile,
  model,
  protocol,
  timeoutMs = HARD_TIMEOUT_MS,
  fetchImpl = fetch,
  readFileImpl = readFile,
}) {
  assertModelProtocol(model, protocol)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > HARD_TIMEOUT_MS) {
    throw new ProviderCompatProbeError('invalid_timeout')
  }

  let keyText
  try {
    keyText = await readFileImpl(keyFile, 'utf8')
  } catch {
    throw new ProviderCompatProbeError('key_file_unreadable')
  }
  let connection
  try {
    connection = parseStrictConnectionJson(keyText)
  } finally {
    keyText = ''
  }
  const request = buildProviderRequest({
    baseUrl: connection.baseUrl,
    apiKey: connection.apiKey,
    model,
    protocol,
  })
  const requestHeaderNames = Object.keys(request.headers).sort()

  let response
  try {
    response = await fetchImpl(request.url, {
      method: 'POST',
      redirect: 'error',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new ProviderCompatProbeError(
      error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? 'timeout'
        : 'request_failed',
      'transport_error',
    )
  } finally {
    connection.apiKey = ''
    delete request.headers.authorization
    delete request.headers['x-api-key']
  }

  const expectedUrl = new URL(request.url)
  if (
    response.redirected ||
    response.url !== request.url ||
    new URL(response.url).origin !== expectedUrl.origin
  ) {
    throw new ProviderCompatProbeError(
      'response_url_mismatch',
      'transport_error',
      response.status,
    )
  }

  const mediaType = classifyContentType(response.headers.get('content-type') ?? '')
  const protocolCapture = mediaType === 'text_event_stream'
    ? await readSse(response)
    : await readJson(response)
  return {
    schemaVersion: 1,
    ok: response.ok,
    request: {
      model,
      protocol,
      endpointPath: expectedUrl.pathname,
      timeoutMs,
      maxTokens: PROBE_MAX_TOKENS,
      physicalRequests: 1,
      retries: 0,
      headerNames: requestHeaderNames,
      bodyShape: inspectJsonShape(request.body),
    },
    http: {
      status: response.status,
      redirected: response.redirected,
      mediaType,
      hasContentLength: response.headers.has('content-length'),
      contentLength: /^\d+$/.test(response.headers.get('content-length') ?? '')
        ? Number(response.headers.get('content-length'))
        : null,
      hasTransferEncoding: response.headers.has('transfer-encoding'),
    },
    protocolCapture,
  }
}

export async function persistPrivateProbeReport(report, fileName, {
  mkdirImpl = mkdir,
  writeFileImpl = writeFile,
} = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.json$/.test(fileName) || fileName.includes('..')) {
    throw new ProviderCompatProbeError('invalid_output_name')
  }
  await mkdirImpl(privateReportDirectory, { recursive: true })
  const destination = path.join(privateReportDirectory, fileName)
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  await writeFileImpl(destination, serialized, { encoding: 'utf8', flag: 'wx' })
  return { persisted: true }
}

function usage() {
  return [
    'Usage: node scripts/probe-provider-compat.mjs --execute',
    '  --model <allowed exact model name>',
    '  --protocol <openai-chat|anthropic-messages>',
    '  [--key-file <NewAPI connection JSON file>]',
    '  [--timeout-ms <1000..900000>]',
    '  [--out <private-report-name.json>]',
  ].join('\n')
}

async function main() {
  let args
  try {
    args = parseProviderProbeArguments(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: safeFailure(error) })}\n`)
    process.stderr.write(`${usage()}\n`)
    process.exitCode = 1
    return
  }
  try {
    const report = await runProviderCompatProbe(args)
    let persisted = false
    if (args.out) {
      ;({ persisted } = await persistPrivateProbeReport(report, args.out))
    }
    process.stdout.write(`${JSON.stringify({ ...report, persisted }, null, 2)}\n`)
    if (!report.ok) process.exitCode = 1
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: safeFailure(error) })}\n`)
    process.exitCode = 1
  }
}

if (
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main()
}
