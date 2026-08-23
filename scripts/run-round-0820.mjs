import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  appendFile,
  mkdir,
  readFile,
} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  MULTI_CONDITIONS,
  ROUND_ID,
  STAGES,
  assertNonEmptyString,
  assertPathInside,
  assertSafeId,
  hashFile,
  hashJson,
  parseArgs,
  parseSemanticOutput,
  readJson,
  readJsonl,
  resolvePortable,
  seededNumber,
  sha256,
  writeJsonAtomic,
  writeJsonlAtomic,
  writeJsonNew,
} from './round-0820-lib.mjs'
import {
  createExperimentCredentialResolver,
  redactCredentialText,
  redactCredentialValue,
} from './run-round-0820-with-key-file.mjs'

const execFileAsync = promisify(execFile)
const MODEL_CALL_HARD_TIMEOUT_MS = 900_000
const MAX_RETRY_BACKOFF_MS = 60_000
const MAX_SAMPLE_CONCURRENCY = 32
const MAX_SSE_PENDING_CHARACTERS = 8 * 1024 * 1024
const MAX_SSE_EVENTS = 100_000
const MAX_VISIBLE_CONTENT_CHARACTERS = 8 * 1024 * 1024
const GPT_MODEL = 'GPT 5.6 Sol: CPA'
const EXPERIMENT_API_KEY_ENV = 'FSBP_EXPERIMENT_API_KEY'
const EXPECTED_MODELS = Object.freeze({
  direct: GPT_MODEL,
  analysis: Object.freeze([GPT_MODEL, GPT_MODEL]),
  candidates: Object.freeze([GPT_MODEL, GPT_MODEL, GPT_MODEL]),
  editor: GPT_MODEL,
  fallbackModel: GPT_MODEL,
})

function usage() {
  return [
    'Usage: node scripts/run-round-0820.mjs [--freeze <freeze-manifest.json>]',
    '  [--output <new-or-resumable-private-run-directory>] [--repo-root <repository>]',
    '  [--run-id <id>] [--dataset <name>] [--retry-failed] [--allow-nonformal]',
  ].join('\n')
}

async function allOrThrowAfterSettled(promises) {
  const settled = await Promise.allSettled(promises)
  const rejected = settled.find((entry) => entry.status === 'rejected')
  if (rejected) throw rejected.reason
  return settled.map((entry) => entry.value)
}

async function runWorkerPool(items, concurrency, work) {
  if (!items.length) return
  let nextIndex = 0
  let firstError = null
  let failed = false
  const workerCount = Math.min(concurrency, items.length)
  const workers = Array.from({ length: workerCount }, async () => {
    while (!failed) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      try {
        await work(items[index], index)
      } catch (error) {
        if (!failed) firstError = error
        failed = true
      }
    }
  })
  await Promise.all(workers)
  if (failed) throw firstError
}

function contentText(message) {
  if (typeof message?.content === 'string') return message.content
  if (Array.isArray(message?.content)) {
    return message.content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
  }
  return ''
}

function modelSeed(seed, sampleId, phase) {
  return Math.floor(seededNumber(seed, sampleId, phase) * 2_147_483_647)
}

function endpointUrl(endpoint) {
  const base = String(endpoint.baseUrl).replace(/\/+$/, '')
  const route = `/${String(endpoint.chatCompletionsPath ?? '/v1/chat/completions')
    .replace(/^\/+/, '')}`
  return `${base}${route}`
}

class UpstreamTimeoutError extends Error {
  constructor(
    message = 'Upstream model did not complete within the shared model-call deadline.',
    partialRecord = null,
  ) {
    super(message)
    this.name = 'UpstreamTimeoutError'
    this.partialRecord = partialRecord
  }
}

class UpstreamStreamInterruptedError extends Error {
  constructor(partialRecord, message = 'Upstream stream closed before a completion marker.') {
    super(message)
    this.name = 'UpstreamStreamInterruptedError'
    this.partialRecord = partialRecord
  }
}

class UpstreamEmptyVisibleContentError extends Error {
  constructor(partialRecord) {
    const diagnostics = partialRecord?.providerDiagnostics
    const message = diagnostics?.reasoningChunks
      ? `Provider completed with ${diagnostics.reasoningChunks} reasoning chunk(s) ` +
        `(${diagnostics.reasoningCharacters} characters) but no visible message content.`
      : partialRecord?.usage
        ? 'Provider completed with usage but no visible message content.'
        : 'Provider completed without visible message content.'
    super(message)
    this.name = 'UpstreamEmptyVisibleContentError'
    this.partialRecord = partialRecord
  }
}

class UpstreamIncompleteResponseError extends Error {
  constructor(partialRecord) {
    super(
      `Upstream ended generation with non-success finish_reason ${JSON.stringify(partialRecord.finishReason)}.`,
    )
    this.name = 'UpstreamIncompleteResponseError'
    this.partialRecord = partialRecord
  }
}

class UpstreamEventError extends Error {
  constructor(partialRecord, providerEventError) {
    super('Upstream SSE event reported an error.')
    this.name = 'UpstreamEventError'
    this.partialRecord = partialRecord
    this.providerEventError = providerEventError
  }
}

class ProviderHttpError extends Error {
  constructor(status, message, retryAfterMs = null, sensitiveValues = []) {
    super(`HTTP ${status}: ${redactCredentialText(message, sensitiveValues)}`)
    this.name = 'ProviderHttpError'
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null
  const normalized = value.trim()
  const seconds = /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN
  if (Number.isSafeInteger(seconds) && seconds >= 0) {
    return Math.min(MAX_RETRY_BACKOFF_MS, Math.round(seconds * 1000))
  }
  const at = Date.parse(normalized)
  if (!Number.isFinite(at)) return null
  return Math.min(MAX_RETRY_BACKOFF_MS, Math.max(0, at - now))
}

function retryBackoffMs(error, attempt) {
  if (error instanceof ProviderHttpError && error.retryAfterMs !== null) {
    return error.retryAfterMs
  }
  return Math.min(MAX_RETRY_BACKOFF_MS, 1000 * (2 ** Math.max(0, attempt - 1)))
}

function waitForRetry(delayMs, deadline) {
  const remainingMs = Math.floor(deadline - performance.now())
  if (remainingMs <= 0 || delayMs >= remainingMs) return Promise.resolve(false)
  const deadlineSignal = AbortSignal.timeout(remainingMs)
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(true), delayMs)
    const onAbort = () => finish(false)
    function finish(completed) {
      clearTimeout(timer)
      deadlineSignal.removeEventListener('abort', onAbort)
      resolve(completed)
    }
    deadlineSignal.addEventListener('abort', onAbort, { once: true })
  })
}

function completionPayloadFromJson(text, status) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`HTTP ${status}: provider returned non-JSON content`)
  }
}

function normalizedUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const promptTokens = value.prompt_tokens
  const completionTokens = value.completion_tokens
  const totalTokens = value.total_tokens
  if (
    !Number.isSafeInteger(promptTokens) || promptTokens < 0 ||
    !Number.isSafeInteger(completionTokens) || completionTokens < 0 ||
    (
      totalTokens !== undefined &&
      (!Number.isSafeInteger(totalTokens) || totalTokens < 0)
    )
  ) return null
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens ?? promptTokens + completionTokens,
  }
}

const REASONING_FIELDS = Object.freeze(['reasoning_content', 'thinking', 'reasoning'])

function createProviderDiagnostics() {
  return {
    reasoningFields: new Set(),
    reasoningChunks: 0,
    reasoningCharacters: 0,
  }
}

function observeReasoningFields(value, diagnostics) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  for (const field of REASONING_FIELDS) {
    const fragment = value[field]
    if (typeof fragment !== 'string' || !fragment.length) continue
    diagnostics.reasoningFields.add(field)
    diagnostics.reasoningChunks += 1
    diagnostics.reasoningCharacters += fragment.length
  }
}

function snapshotProviderDiagnostics(diagnostics) {
  if (!diagnostics.reasoningChunks) return null
  return {
    reasoningFields: REASONING_FIELDS.filter((field) => diagnostics.reasoningFields.has(field)),
    reasoningChunks: diagnostics.reasoningChunks,
    reasoningCharacters: diagnostics.reasoningCharacters,
  }
}

function providerDiagnosticsFromPayload(payload) {
  const diagnostics = createProviderDiagnostics()
  observeReasoningFields(payload?.choices?.[0]?.message, diagnostics)
  return snapshotProviderDiagnostics(diagnostics)
}

function safeProviderEventError(value) {
  const safeIdentifier = (candidate) => (
    typeof candidate === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(candidate)
      ? candidate
      : null
  )
  const status = Number.isSafeInteger(value?.status) && value.status >= 100 && value.status <= 599
    ? value.status
    : null
  return {
    ...(safeIdentifier(value?.type) ? { type: safeIdentifier(value.type) } : {}),
    ...(safeIdentifier(value?.code) ? { code: safeIdentifier(value.code) } : {}),
    ...(status !== null ? { status } : {}),
  }
}

async function readProviderCompletion(response) {
  const contentType = response.headers.get('content-type') ?? ''
  if (!response.ok) {
    const responseText = await response.text()
    let payload
    try {
      payload = JSON.parse(responseText)
    } catch {
      payload = { error: { message: responseText || response.statusText } }
    }
    return {
      payload,
      transport: 'error_body',
      terminalEvidence: null,
      finishReasonInferred: false,
      providerDiagnostics: null,
    }
  }
  if (!contentType.toLowerCase().includes('text/event-stream')) {
    const payload = completionPayloadFromJson(await response.text(), response.status)
    return {
      payload,
      transport: 'json_fallback',
      terminalEvidence: typeof payload?.choices?.[0]?.finish_reason === 'string'
        ? 'finish_reason'
        : 'json_response',
      finishReasonInferred: false,
      providerDiagnostics: providerDiagnosticsFromPayload(payload),
    }
  }
  if (!response.body) {
    throw new UpstreamStreamInterruptedError(
      {
        raw: '',
        body: '',
        annotation: null,
        finishReason: null,
        usage: null,
        terminalEvidence: null,
        finishReasonInferred: false,
        providerDiagnostics: null,
      },
      'Upstream SSE response had no body.',
    )
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const pendingLineFragments = []
  let pendingLineCharacters = 0
  let eventDataLines = []
  let bufferedEventCharacters = 0
  const rawFragments = []
  let rawCharacters = 0
  let parsedEventCount = 0
  let finishReason = null
  let usage = null
  let sawDone = false
  let sawMalformedData = false
  let cleanEof = false
  let terminalEvidence = null
  let finishReasonInferred = false
  let cleanEofCandidate = null
  let providerEventError = null
  let terminalReached = false
  const mutableDiagnostics = createProviderDiagnostics()
  const rawText = () => rawFragments.join('')
  const providerDiagnostics = () => snapshotProviderDiagnostics(mutableDiagnostics)

  const partialRecord = () => {
    const semantic = parseSemanticOutput(rawText())
    return {
      raw: semantic.raw,
      body: semantic.body,
      annotation: semantic.annotation,
      finishReason,
      usage,
      terminalEvidence,
      finishReasonInferred,
      providerDiagnostics: providerDiagnostics(),
      ...(providerEventError ? { providerEventError } : {}),
    }
  }
  const appendRaw = (content) => {
    if (content.length > MAX_VISIBLE_CONTENT_CHARACTERS - rawCharacters) {
      throw new UpstreamStreamInterruptedError(
        partialRecord(),
        'Upstream visible content exceeded the bounded stream limit.',
      )
    }
    rawFragments.push(content)
    rawCharacters += content.length
  }
  const mergeAggregateMessage = (content) => {
    if (!rawCharacters) {
      appendRaw(content)
      return true
    }
    const current = rawText()
    if (content === current) return true
    if (content.startsWith(current)) {
      if (content.length > MAX_VISIBLE_CONTENT_CHARACTERS) {
        throw new UpstreamStreamInterruptedError(
          partialRecord(),
          'Upstream visible content exceeded the bounded stream limit.',
        )
      }
      rawFragments.length = 0
      rawFragments.push(content)
      rawCharacters = content.length
      return true
    }
    return false
  }
  const consumeData = (data) => {
    const normalized = data.trim()
    if (!normalized) return 'empty'
    parsedEventCount += 1
    if (parsedEventCount > MAX_SSE_EVENTS) {
      throw new UpstreamStreamInterruptedError(
        partialRecord(),
        'Upstream SSE stream exceeded the bounded event limit.',
      )
    }
    if (normalized === '[DONE]') {
      sawDone = true
      terminalReached = true
      if (!finishReason) terminalEvidence = 'done_marker'
      return 'terminal'
    }
    let event
    try {
      event = JSON.parse(data)
    } catch {
      return 'malformed'
    }

    const hasUsage = event?.usage !== undefined && event.usage !== null
    const eventUsage = hasUsage ? normalizedUsage(event.usage) : null
    const invalidUsage = hasUsage && !eventUsage
    if (eventUsage) usage = eventUsage

    if (event?.error !== undefined && event.error !== null) {
      providerEventError = safeProviderEventError(event.error)
      cleanEofCandidate = null
      if (invalidUsage) sawMalformedData = true
      terminalReached = true
      return 'error'
    }

    const choice = event?.choices?.[0]
    observeReasoningFields(choice?.delta, mutableDiagnostics)
    observeReasoningFields(choice?.message, mutableDiagnostics)
    const deltaContent = contentText(choice?.delta)
    const aggregateContent = contentText(choice?.message)
    const hasDelta = Boolean(choice?.delta && typeof choice.delta === 'object')
    const hasAggregate = Boolean(aggregateContent)
    const invalidFinishReason = (
      choice?.finish_reason !== null &&
      choice?.finish_reason !== undefined &&
      typeof choice.finish_reason !== 'string'
    )

    if (finishReason && (deltaContent || aggregateContent)) {
      cleanEofCandidate = null
      return 'malformed'
    }
    const hasExplicitFinishReason = typeof choice?.finish_reason === 'string'
    if (hasExplicitFinishReason) {
      finishReason = choice.finish_reason
      terminalEvidence = 'finish_reason'
      finishReasonInferred = false
      cleanEofCandidate = null
    }
    if (deltaContent) appendRaw(deltaContent)
    else if (hasAggregate && !mergeAggregateMessage(aggregateContent)) {
      cleanEofCandidate = null
      return 'malformed'
    }
    if (invalidFinishReason) {
      cleanEofCandidate = null
      return 'malformed'
    }

    if (!finishReason) {
      if (hasAggregate) cleanEofCandidate = 'aggregate_message'
      else if (eventUsage && !hasDelta) cleanEofCandidate = 'final_usage'
      else cleanEofCandidate = null
    }
    if (invalidUsage) {
      cleanEofCandidate = null
      return 'malformed'
    }
    if (hasExplicitFinishReason) {
      terminalReached = true
      return 'terminal'
    }
    return 'parsed'
  }
  const payloadIsComplete = (data) => {
    const normalized = data.trim()
    if (normalized === '[DONE]') return true
    try {
      JSON.parse(data)
      return true
    } catch {
      return false
    }
  }
  const consumeBufferedEvent = () => {
    if (!eventDataLines.length || terminalReached) return
    const joined = eventDataLines.join('\n')
    const lines = eventDataLines
    eventDataLines = []
    bufferedEventCharacters = 0
    if (payloadIsComplete(joined)) {
      if (consumeData(joined) === 'malformed') sawMalformedData = true
      return
    }

    // Standard SSE joins data fields. NewAPI also emits one complete JSON
    // event per data line without blank separators. Only fall back when the
    // standards-compliant joined payload cannot be parsed.
    for (const data of lines) {
      if (terminalReached) break
      const result = consumeData(data)
      if (result === 'malformed') sawMalformedData = true
    }
  }
  const consumeLine = (input) => {
    if (terminalReached) return
    const line = input.endsWith('\r') ? input.slice(0, -1) : input
    if (line === '') {
      consumeBufferedEvent()
      return
    }
    if (!line.startsWith('data:')) return
    const data = line.slice(5).replace(/^ /, '')
    if (data.trim() === '[DONE]') {
      consumeBufferedEvent()
      if (!terminalReached) consumeData(data)
      return
    }
    if (eventDataLines.length === 1 && payloadIsComplete(eventDataLines[0])) {
      consumeBufferedEvent()
    }
    if (!terminalReached) {
      if (data.length > MAX_SSE_PENDING_CHARACTERS - bufferedEventCharacters) {
        throw new UpstreamStreamInterruptedError(
          partialRecord(),
          'Upstream SSE event exceeded the bounded parser buffer.',
        )
      }
      eventDataLines.push(data)
      bufferedEventCharacters += data.length
    }
    if (!terminalReached && payloadIsComplete(data)) {
      let immediateEvent
      try {
        immediateEvent = JSON.parse(data)
      } catch {
        immediateEvent = null
      }
      if (
        (immediateEvent?.error !== undefined && immediateEvent.error !== null) ||
        typeof immediateEvent?.choices?.[0]?.finish_reason === 'string'
      ) consumeBufferedEvent()
    }
  }
  const appendPendingLine = (fragment) => {
    if (!fragment) return
    if (fragment.length > MAX_SSE_PENDING_CHARACTERS - pendingLineCharacters) {
      throw new UpstreamStreamInterruptedError(
        partialRecord(),
        'Upstream SSE line exceeded the bounded parser buffer.',
      )
    }
    pendingLineFragments.push(fragment)
    pendingLineCharacters += fragment.length
  }
  const consumeDecodedText = (chunk) => {
    let start = 0
    while (!terminalReached) {
      const boundary = chunk.indexOf('\n', start)
      if (boundary < 0) break
      appendPendingLine(chunk.slice(start, boundary))
      const line = pendingLineFragments.join('')
      pendingLineFragments.length = 0
      pendingLineCharacters = 0
      consumeLine(line)
      start = boundary + 1
    }
    if (!terminalReached) appendPendingLine(chunk.slice(start))
  }
  const flushPending = () => {
    if (!terminalReached && pendingLineCharacters) {
      const line = pendingLineFragments.join('')
      pendingLineFragments.length = 0
      pendingLineCharacters = 0
      consumeLine(line)
    }
    if (!terminalReached) consumeBufferedEvent()
  }
  const cancelAfterTerminal = async () => {
    try {
      await reader.cancel('SSE terminal event received')
    } catch {
      // A post-terminal transport reset cannot invalidate a parsed terminal event.
    }
  }

  try {
    while (!terminalReached) {
      const { done, value } = await reader.read()
      if (done) {
        const tail = decoder.decode()
        if (tail) consumeDecodedText(tail)
        cleanEof = true
        break
      }
      const chunk = decoder.decode(value, { stream: true })
      if (chunk) consumeDecodedText(chunk)
    }
    if (terminalReached) await cancelAfterTerminal()
    else flushPending()
  } catch (error) {
    // A provider/network error can arrive after complete line-delimited events
    // but before a blank separator. Recover those events for failure evidence;
    // any genuinely truncated residual data keeps the attempt failed.
    flushPending()
    if (terminalReached) {
      await cancelAfterTerminal()
    } else if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new UpstreamTimeoutError(
        'Upstream model did not complete within the shared model-call deadline.',
        partialRecord(),
      )
    } else {
      const detail = error instanceof Error ? ` ${error.message}` : ''
      throw new UpstreamStreamInterruptedError(
        partialRecord(),
        `Upstream stream was interrupted before completion.${detail}`,
      )
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // Already released by the fetch implementation.
    }
  }

  if (providerEventError) {
    throw new UpstreamEventError(partialRecord(), providerEventError)
  }
  if (sawMalformedData) {
    throw new UpstreamStreamInterruptedError(
      partialRecord(),
      'Upstream SSE response ended with malformed or truncated data.',
    )
  }
  const raw = rawText()
  if (!finishReason && sawDone) {
    finishReason = 'stop'
    finishReasonInferred = true
    terminalEvidence = 'done_marker'
  } else if (!finishReason && cleanEof && cleanEofCandidate) {
    finishReason = 'stop'
    finishReasonInferred = true
    terminalEvidence = cleanEofCandidate
  }
  if (!finishReason) {
    throw new UpstreamStreamInterruptedError(partialRecord())
  }
  if (finishReason === 'stop' && !raw.trim()) {
    throw new UpstreamEmptyVisibleContentError(partialRecord())
  }
  return {
    payload: {
      choices: [{ finish_reason: finishReason, message: { content: raw } }],
      usage,
    },
    transport: 'sse',
    terminalEvidence,
    finishReasonInferred,
    providerDiagnostics: providerDiagnostics(),
  }
}

function sourceBlock(sample) {
  return [
    `Direction: ${sample.direction}`,
    `Task brief:\n${sample.taskBrief ?? ''}`,
    sample.contextBefore ? `Context before:\n${sample.contextBefore}` : '',
    sample.contextAfter ? `Context after:\n${sample.contextAfter}` : '',
    `Source text:\n${sample.sourceText}`,
  ].filter(Boolean).join('\n\n')
}

function directMessages(sample, prompts) {
  return [
    { role: 'system', content: prompts.direct },
    { role: 'user', content: sourceBlock(sample) },
  ]
}

function analysisMessages(sample, prompts, index) {
  const prompt = Array.isArray(prompts.analysis)
    ? prompts.analysis[index % prompts.analysis.length]
    : prompts.analysis
  return [
    { role: 'system', content: prompt },
    { role: 'user', content: sourceBlock(sample) },
  ]
}

function candidateMessages(sample, prompts, index, analyses) {
  const prompt = Array.isArray(prompts.candidate)
    ? prompts.candidate[index % prompts.candidate.length]
    : prompts.candidate
  return [
    { role: 'system', content: prompt },
    {
      role: 'user',
      content: [
        sourceBlock(sample),
        'Independent analyses:',
        analyses.map((record, position) => (
          `Analysis ${position + 1}:\n${record.raw}`
        )).join('\n\n'),
      ].join('\n\n'),
    },
  ]
}

function inherited(record, condition) {
  return condition === 'multi_raw' ? record.raw : record.body
}

function stageMessages(sample, prompts, stage, condition, candidates, stageRecords) {
  const candidatesBlock = candidates.map((candidate, index) => (
    `Candidate ${index + 1}:\n${inherited(candidate, condition)}`
  )).join('\n\n')
  const priorBlock = STAGES
    .slice(0, STAGES.indexOf(stage))
    .map((priorStage) => {
      const record = stageRecords.get(priorStage)
      return record
        ? `${priorStage.toUpperCase()}:\n${inherited(record, condition)}`
        : ''
    })
    .filter(Boolean)
    .join('\n\n')
  return [
    { role: 'system', content: prompts.stages[stage] },
    {
      role: 'user',
      content: [
        sourceBlock(sample),
        `Candidate translations:\n${candidatesBlock}`,
        priorBlock,
      ].filter(Boolean).join('\n\n'),
    },
  ]
}

function normalizeUpstreamCandidate(sample) {
  const upstream = sample.upstream ?? sample
  const raw = assertNonEmptyString(upstream.raw, `${sample.id}.upstream.raw`)
  const parsed = parseSemanticOutput(raw)
  const body = assertNonEmptyString(
    upstream.body ?? parsed.body,
    `${sample.id}.upstream.body`,
  )
  const annotation = upstream.annotation ?? parsed.annotation
  if (!annotation || typeof annotation !== 'string') {
    throw new Error(`${sample.id}: annotation-isolation sample requires an annotation.`)
  }
  if (parsed.body !== body) {
    throw new Error(`${sample.id}: upstream body does not match the body parsed from raw.`)
  }
  return {
    taskKey: `${sample.id}:frozen-upstream-candidate`,
    phase: 'candidate',
    model: upstream.model ?? sample.model ?? 'frozen-upstream-model',
    status: 'complete',
    raw,
    body,
    annotation,
    boundaryFound: parsed.boundaryFound,
    boundaryCount: parsed.boundaryCount,
    frozenInvocationId: upstream.invocationId ?? sample.invocationId ?? null,
  }
}

async function git(repositoryRoot, args) {
  const { stdout } = await execFileAsync('git', ['-C', repositoryRoot, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  })
  return stdout.trim()
}

function unsignedFreezeManifest(manifest) {
  const { freezeManifestSha256: _ignored, ...unsigned } = manifest
  return unsigned
}

function assertExactStringArray(actual, expected, label) {
  if (
    !Array.isArray(actual) || actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(`Frozen ${label} must be exactly [${expected.join(', ')}].`)
  }
}

function assertFrozenRuntimeContract(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('Frozen snapshot must be an object.')
  }
  const models = snapshot.models
  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    throw new Error('Frozen models must be an object.')
  }
  if (models.direct !== EXPECTED_MODELS.direct) {
    throw new Error(`Frozen models.direct must be ${EXPECTED_MODELS.direct}.`)
  }
  assertExactStringArray(models.analysis, EXPECTED_MODELS.analysis, 'models.analysis')
  assertExactStringArray(models.candidates, EXPECTED_MODELS.candidates, 'models.candidates')
  if (models.editor !== EXPECTED_MODELS.editor) {
    throw new Error(`Frozen models.editor must be ${EXPECTED_MODELS.editor}.`)
  }
  if (models.fallbackModel !== EXPECTED_MODELS.fallbackModel) {
    throw new Error(`Frozen models.fallbackModel must be ${EXPECTED_MODELS.fallbackModel}.`)
  }

  const parameters = snapshot.parameters
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new Error('Frozen parameters must be an object.')
  }
  if (parameters.maxTokens !== 131_072) {
    throw new Error('Frozen parameters.maxTokens must be exactly 131072.')
  }
  if (parameters.timeoutMs !== MODEL_CALL_HARD_TIMEOUT_MS) {
    throw new Error('Frozen parameters.timeoutMs must be exactly 900000.')
  }
  if (parameters.sampleConcurrency !== 5) {
    throw new Error('Frozen parameters.sampleConcurrency must be exactly 5.')
  }
  if (parameters.fallbackAttempts !== 1) {
    throw new Error('Frozen parameters.fallbackAttempts must be exactly 1.')
  }

  const endpoint = snapshot.endpoint
  if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) {
    throw new Error('Frozen endpoint must be an object.')
  }
  const expectedEndpointKeys = ['apiKeyEnv', 'baseUrl', 'chatCompletionsPath']
  const endpointKeys = Object.keys(endpoint).sort()
  if (
    endpointKeys.length !== expectedEndpointKeys.length ||
    endpointKeys.some((key, index) => key !== expectedEndpointKeys[index])
  ) {
    throw new Error(
      'Frozen endpoint may contain only baseUrl, chatCompletionsPath, and apiKeyEnv.',
    )
  }
  const baseUrl = assertNonEmptyString(endpoint.baseUrl, 'endpoint.baseUrl')
  let parsedBaseUrl
  try {
    parsedBaseUrl = new URL(baseUrl)
  } catch {
    throw new Error('Frozen endpoint.baseUrl must be an absolute HTTP(S) URL.')
  }
  if (!['http:', 'https:'].includes(parsedBaseUrl.protocol)) {
    throw new Error('Frozen endpoint.baseUrl must use HTTP or HTTPS.')
  }
  const chatCompletionsPath = assertNonEmptyString(
    endpoint.chatCompletionsPath,
    'endpoint.chatCompletionsPath',
  )
  if (!chatCompletionsPath.startsWith('/')) {
    throw new Error('Frozen endpoint.chatCompletionsPath must start with /.')
  }
  if (endpoint.apiKeyEnv !== EXPERIMENT_API_KEY_ENV) {
    throw new Error(`Frozen endpoint.apiKeyEnv must be ${EXPERIMENT_API_KEY_ENV}.`)
  }
}

async function verifyFrozenInputs(manifest, repositoryRoot, { allowNonformal = false } = {}) {
  if (
    manifest.roundId !== ROUND_ID || manifest.snapshot?.roundId !== ROUND_ID ||
    manifest.namespace !== 'fsbp' || manifest.snapshot?.namespace !== 'fsbp'
  ) {
    throw new Error(`Freeze manifest is not for ${ROUND_ID}.`)
  }
  if (hashJson(unsignedFreezeManifest(manifest)) !== manifest.freezeManifestSha256) {
    throw new Error('Freeze manifest hash mismatch.')
  }
  assertFrozenRuntimeContract(manifest.snapshot)
  const formalIdentityValid = (
    manifest.mode === 'formal' && manifest.source?.clean === true &&
    manifest.formalValidation?.status === 'passed'
  )
  if (manifest.formalEligible !== formalIdentityValid) {
    throw new Error('Freeze manifest formal eligibility is internally inconsistent.')
  }
  const currentCommit = (await git(repositoryRoot, ['rev-parse', 'HEAD'])).toLowerCase()
  if (currentCommit !== manifest.source?.commit) {
    throw new Error(
      `Source commit drift: frozen ${manifest.source?.commit}, current ${currentCommit}.`,
    )
  }
  if (!manifest.formalEligible && !allowNonformal) {
    throw new Error('Non-formal freeze manifest requires the explicit --allow-nonformal development flag.')
  }
  const currentStatus = await git(repositoryRoot, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ])
  if (manifest.formalEligible && currentStatus) {
    throw new Error('Repository changed after the formal freeze; create a new frozen round manifest.')
  }
  for (const entry of Object.values(manifest.snapshot.datasets ?? {})) {
    const currentHash = await hashFile(resolvePortable(repositoryRoot, entry.path))
    if (currentHash !== entry.sha256) {
      throw new Error(`Frozen dataset drift: ${entry.path}`)
    }
  }
  for (const prompt of manifest.snapshot.promptFiles ?? []) {
    const currentHash = await hashFile(resolvePortable(repositoryRoot, prompt.path))
    if (currentHash !== prompt.sha256) {
      throw new Error(`Frozen prompt drift: ${prompt.path}`)
    }
  }
}

async function jsonlArtifact(runDirectory, filePath) {
  const records = await readJsonl(filePath)
  return {
    path: path.relative(runDirectory, filePath).replace(/\\/g, '/'),
    sha256: await hashFile(filePath),
    recordCount: records.length,
  }
}

function errorRecord(error, sensitiveValues = []) {
  const message = redactCredentialText(
    error instanceof Error ? error.message : String(error),
    sensitiveValues,
  )
  let code = 'unknown_failure'
  let origin = 'local'
  let retryable = false
  if (error?.name === 'AbortError' || /cancelled|canceled/i.test(message)) code = 'cancelled'
  else if (error instanceof UpstreamEventError) {
    code = 'upstream_event_error'
    origin = 'upstream'
    // A parsed SSE error event bypasses the ordinary same-model retry loop.
    // callModel may still route it through the single frozen fallback attempt.
    retryable = false
  }
  else if (error instanceof UpstreamIncompleteResponseError) {
    code = 'upstream_incomplete_finish_reason'
    origin = 'upstream'
    retryable = true
  }
  else if (error instanceof UpstreamEmptyVisibleContentError) {
    code = 'empty_visible_content'
    origin = 'upstream'
    retryable = true
  }
  else if (
    error instanceof UpstreamTimeoutError || error?.name === 'TimeoutError' ||
    /timed? ?out|timeout/i.test(message)
  ) {
    code = 'upstream_timeout'
    origin = 'upstream'
    retryable = true
  } else if (error instanceof UpstreamStreamInterruptedError) {
    code = 'upstream_stream_interrupted'
    origin = 'upstream'
    retryable = true
  } else if (
    error instanceof ProviderHttpError && [408, 409].includes(error.status)
  ) {
    code = 'provider_failure'
    origin = 'upstream'
    retryable = true
  } else if (
    (error instanceof ProviderHttpError && error.status === 429) ||
    /HTTP 429/.test(message)
  ) {
    code = 'rate_limited'
    origin = 'upstream'
    retryable = true
  }
  else if (
    (
      error instanceof ProviderHttpError &&
      error.status >= 400 && error.status < 500
    ) ||
    /HTTP 4\d\d/.test(message)
  ) code = 'provider_request_rejected'
  else if (
    (
      error instanceof ProviderHttpError &&
      error.status >= 500 && error.status < 600
    ) ||
    /HTTP 5\d\d/.test(message)
  ) {
    code = 'provider_failure'
    origin = 'upstream'
    retryable = true
  }
  else if (/non-JSON/i.test(message)) {
    code = 'provider_non_json'
    origin = 'upstream'
    retryable = true
  }
  else if (/empty body/i.test(message)) {
    code = 'empty_fsbp_body'
    origin = 'upstream'
    retryable = true
  }
  else if (/empty message/i.test(message)) {
    code = 'empty_model_message'
    origin = 'upstream'
    retryable = true
  }
  else if (/fetch failed|econnreset|socket|terminated|network/i.test(message)) {
    code = 'upstream_network_failure'
    origin = 'upstream'
    retryable = true
  }
  return { code, message, origin, retryable }
}

function fallbackReason(error) {
  if (error instanceof IncompleteOutputError) return 'incomplete_output'
  return errorRecord(error).code
}

function permitsFrozenFallback(error) {
  if (error instanceof IncompleteOutputError) return true
  if (error instanceof UpstreamStreamInterruptedError) return true
  if (error instanceof UpstreamEmptyVisibleContentError) return true
  if (error instanceof UpstreamTimeoutError || error?.name === 'TimeoutError') return true
  // An UpstreamEventError can only be created after an HTTP 200 SSE stream was
  // established and emitted a provider error event. Some compatible gateways
  // mislabel transient stream failures as invalid_request_error; the transport
  // evidence is authoritative for the single frozen-model fallback decision.
  if (error instanceof UpstreamEventError) return true

  const retryableStatus = (status) => (
    status === 408 || status === 409 || status === 429 ||
    (Number.isSafeInteger(status) && status >= 500 && status < 600)
  )
  if (error instanceof ProviderHttpError) return retryableStatus(error.status)

  const failure = errorRecord(error)
  return [
    'empty_fsbp_body',
    'empty_model_message',
    'upstream_network_failure',
  ].includes(failure.code)
}

function redactErrorInPlace(error, sensitiveValues = []) {
  if (!(error instanceof Error)) return error
  error.message = redactCredentialText(error.message, sensitiveValues)
  if (typeof error.stack === 'string') {
    error.stack = redactCredentialText(error.stack, sensitiveValues)
  }
  if (error.partialRecord && typeof error.partialRecord === 'object') {
    error.partialRecord = redactCredentialValue(error.partialRecord, sensitiveValues)
  }
  return error
}

class IncompleteOutputError extends Error {
  constructor(partialRecord) {
    super('Provider ended the response at the frozen output-token limit.')
    this.name = 'IncompleteOutputError'
    this.partialRecord = partialRecord
  }
}

function failedOutcomeFields(error, errorPrefix = '') {
  if (error instanceof IncompleteOutputError) {
    const partial = error.partialRecord
    return {
      status: 'incomplete_output',
      errorCode: 'incomplete_output',
      errorOrigin: 'upstream',
      error: `${errorPrefix}${error.message}`,
      partialRaw: partial.raw,
      partialBody: partial.body,
      partialAnnotation: partial.annotation,
      sourceTaskKey: partial.taskKey,
      finishReason: partial.finishReason,
      truncated: true,
    }
  }
  if (error instanceof UpstreamStreamInterruptedError) {
    const partial = error.partialRecord
    return {
      status: 'failed',
      errorCode: 'upstream_stream_interrupted',
      errorOrigin: 'upstream',
      error: `${errorPrefix}${error.message}`,
      partialRaw: partial.raw,
      partialBody: partial.body,
      partialAnnotation: partial.annotation,
      finishReason: partial.finishReason,
      truncated: true,
    }
  }
  if (error instanceof UpstreamEmptyVisibleContentError) {
    const partial = error.partialRecord
    return {
      status: 'failed',
      errorCode: 'empty_visible_content',
      errorOrigin: 'upstream',
      error: `${errorPrefix}${error.message}`,
      partialRaw: partial.raw,
      partialBody: partial.body,
      partialAnnotation: partial.annotation,
      finishReason: partial.finishReason,
      truncated: false,
    }
  }
  if (error instanceof UpstreamEventError) {
    const partial = error.partialRecord
    return {
      status: 'failed',
      errorCode: 'upstream_event_error',
      errorOrigin: 'upstream',
      error: `${errorPrefix}${error.message}`,
      partialRaw: partial.raw,
      partialBody: partial.body,
      partialAnnotation: partial.annotation,
      finishReason: partial.finishReason,
      truncated: true,
    }
  }
  if (
    (error instanceof UpstreamTimeoutError && error.partialRecord) ||
    error instanceof UpstreamIncompleteResponseError
  ) {
    const partial = error.partialRecord
    const failure = errorRecord(error)
    return {
      status: 'failed',
      errorCode: failure.code,
      errorOrigin: failure.origin,
      error: `${errorPrefix}${failure.message}`,
      partialRaw: partial.raw,
      partialBody: partial.body,
      partialAnnotation: partial.annotation,
      finishReason: partial.finishReason,
      truncated: true,
    }
  }
  const failure = errorRecord(error)
  return {
    status: failure.code === 'cancelled' ? 'cancelled' : 'failed',
    errorCode: failure.code,
    errorOrigin: failure.origin,
    error: `${errorPrefix}${failure.message}`,
  }
}

// Both options are import-only test seams. The direct CLI guard below never
// derives either from argv or environment variables, so a runnable frozen
// manifest still always carries the exact 900-second timeout contract.
export async function runRound0820({
  credentialResolver = null,
  modelCallTimeoutMs = MODEL_CALL_HARD_TIMEOUT_MS,
} = {}) {
  const args = parseArgs(process.argv.slice(2))
  const repositoryRoot = path.resolve(args['repo-root'] ?? process.cwd())
  const freezePath = path.resolve(
    args.freeze ?? path.join(repositoryRoot, 'FSBP_Test', 'private', ROUND_ID, 'freeze-manifest.json'),
  )
  const freeze = await readJson(freezePath)
  await verifyFrozenInputs(freeze, repositoryRoot, {
    allowNonformal: args['allow-nonformal'] === true,
  })

  const snapshot = freeze.snapshot
  const parameters = snapshot.parameters
  const fallbackModel = assertNonEmptyString(snapshot.models.fallbackModel, 'models.fallbackModel')
  const fallbackAttempts = parameters.fallbackAttempts
  if (!Number.isSafeInteger(fallbackAttempts) || fallbackAttempts !== 1) {
    throw new Error('Frozen parameters.fallbackAttempts must be exactly 1.')
  }
  const sampleConcurrency = parameters.sampleConcurrency ?? 1
  if (
    !Number.isSafeInteger(sampleConcurrency) ||
    sampleConcurrency < 1 ||
    sampleConcurrency > MAX_SAMPLE_CONCURRENCY
  ) {
    throw new Error(
      `Frozen parameters.sampleConcurrency must be an integer from 1 to ${MAX_SAMPLE_CONCURRENCY}.`,
    )
  }
  const keyFilePath = process.env.FSBP_EXPERIMENT_KEY_FILE?.trim() || null
  if (credentialResolver !== null && typeof credentialResolver !== 'function') {
    throw new Error('Injected experiment credential resolver must be a function.')
  }
  if (
    !Number.isSafeInteger(modelCallTimeoutMs) || modelCallTimeoutMs < 1_000 ||
    modelCallTimeoutMs > MODEL_CALL_HARD_TIMEOUT_MS
  ) {
    throw new Error('Injected model-call timeout must be an integer from 1000 through 900000.')
  }
  if (modelCallTimeoutMs !== MODEL_CALL_HARD_TIMEOUT_MS && credentialResolver === null) {
    throw new Error('Injected model-call timeout requires an injected test credential resolver.')
  }
  const resolveApiKey = credentialResolver ?? createExperimentCredentialResolver({
    keyFilePath,
    endpoint: snapshot.endpoint,
    selectedRepositoryRoot: repositoryRoot,
  })
  const credentialResolution = credentialResolver
    ? 'injected_test_resolver'
    : process.env[EXPERIMENT_API_KEY_ENV]?.trim()
      ? 'per_fetch_process_environment'
      : 'per_fetch_external_temporary_file'
  const runId = assertSafeId(
    args['run-id'] ?? `${ROUND_ID}-${freeze.freezeManifestSha256.slice(0, 12)}`,
    'run ID',
  )
  const outputDir = path.resolve(
    args.output ?? path.join(
      repositoryRoot,
      'FSBP_Test',
      'private',
      ROUND_ID,
      'runs',
      runId,
    ),
  )
  assertPathInside(
    path.join(repositoryRoot, 'FSBP_Test', 'private', ROUND_ID),
    outputDir,
    'run output',
  )
  await mkdir(outputDir, { recursive: true })
  const eventsPath = path.join(outputDir, 'events.jsonl')
  const outcomesPath = path.join(outputDir, 'outcomes.jsonl')
  const cachePath = path.join(outputDir, 'candidate-cache.jsonl')
  const finalPath = path.join(outputDir, 'final.jsonl')
  const runManifestPath = path.join(outputDir, 'run-manifest.json')
  await Promise.all(
    [eventsPath, outcomesPath, cachePath].map((filePath) => appendFile(filePath, '', 'utf8')),
  )
  const existingRunManifest = await readJson(runManifestPath).catch((error) => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
  if (existingRunManifest) {
    if (
      existingRunManifest.runId !== runId ||
      existingRunManifest.freezeManifestSha256 !== freeze.freezeManifestSha256
    ) {
      throw new Error('Output directory belongs to a different frozen run.')
    }
    await writeJsonAtomic(runManifestPath, {
      ...existingRunManifest,
      status: 'running',
      resumedAt: new Date().toISOString(),
      runtimeLimits: {
        ...existingRunManifest.runtimeLimits,
        upstreamCallHardTimeoutMs: modelCallTimeoutMs,
        sampleConcurrency,
        providerSeedSent: false,
        credentialResolution,
        fallbackModel,
        fallbackAttempts,
      },
    })
  } else {
    await writeJsonNew(runManifestPath, {
      schemaVersion: '1.0.0',
      roundId: ROUND_ID,
      namespace: 'fsbp',
      runId,
      createdAt: new Date().toISOString(),
      status: 'running',
      freezeManifest: path.relative(outputDir, freezePath).replace(/\\/g, '/'),
      freezeManifestSha256: freeze.freezeManifestSha256,
      sourceCommit: freeze.source.commit,
      freezeMode: freeze.mode,
      formalEligible: freeze.formalEligible,
      promptBundleSha256: freeze.hashes.promptBundleSha256,
      models: snapshot.models,
      parameters: snapshot.parameters,
      runtimeLimits: {
        upstreamCallHardTimeoutMs: modelCallTimeoutMs,
        timeoutScope: 'all_attempts_for_one_logical_model_call',
        sampleConcurrency,
        providerSeedSent: false,
        credentialResolution,
        fallbackModel,
        fallbackAttempts,
      },
      seedSha256: freeze.hashes.seedSha256,
      annotation_source: freeze.annotation_source,
      annotation_version: freeze.annotation_version,
      annotation_hash: freeze.annotation_hash,
      determinism_level: freeze.determinism_level,
    })
  }

  const previousEvents = await readJsonl(eventsPath, { allowMissing: true })
  const previousOutcomes = await readJsonl(outcomesPath, { allowMissing: true })
  const previousCache = await readJsonl(cachePath, { allowMissing: true })
  const successByTask = new Map(
    previousEvents
      .filter((record) => record.status === 'complete')
      .map((record) => [record.taskKey, record]),
  )
  const latestOutcome = new Map()
  for (const record of previousOutcomes) latestOutcome.set(record.outcomeKey, record)
  const candidateCache = new Map()
  for (const record of previousCache) candidateCache.set(record.cacheKey, record)
  let appendQueue = Promise.resolve()
  const append = (filePath, record, sensitiveValues = []) => {
    const safeRecord = redactCredentialValue(record, sensitiveValues)
    appendQueue = appendQueue.then(() =>
      appendFile(filePath, `${JSON.stringify(safeRecord)}\n`, 'utf8'),
    )
    return appendQueue
  }

  const url = endpointUrl(snapshot.endpoint)
  async function callModelAttempts({
    taskKey,
    sampleId,
    datasetName,
    phase,
    model,
    messages,
    meta = {},
    maxAttempts,
  }) {
    const cached = successByTask.get(taskKey)
    if (cached) return cached
    const callStarted = performance.now()
    const callDeadline = callStarted + Math.min(
      parameters.timeoutMs,
      modelCallTimeoutMs,
    )
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAt = new Date().toISOString()
      const started = performance.now()
      const requestSeed = modelSeed(snapshot.seed, sampleId, meta.seedScope ?? taskKey)
      const requestPayload = {
        model,
        messages,
        temperature: parameters.temperature,
        max_tokens: parameters.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      }
      let attemptApiKey = null
      try {
        // This read is deliberately inside the attempt loop and immediately
        // adjacent to fetch so rotations also apply to retries and concurrent calls.
        attemptApiKey = await resolveApiKey()
        const remainingMs = Math.floor(callDeadline - performance.now())
        if (remainingMs <= 0) throw new UpstreamTimeoutError()
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${attemptApiKey}`,
          },
          body: JSON.stringify(requestPayload),
          signal: AbortSignal.timeout(remainingMs),
        })
        const {
          payload,
          transport,
          terminalEvidence,
          finishReasonInferred,
          providerDiagnostics,
        } = await readProviderCompletion(response)
        if (!response.ok) {
          throw new ProviderHttpError(
            response.status,
            payload?.error?.message ?? response.statusText,
            retryAfterMs(response.headers.get('retry-after')),
            [attemptApiKey],
          )
        }
        const finishReason = payload?.choices?.[0]?.finish_reason ?? null
        const raw = contentText(payload?.choices?.[0]?.message)
        const semantic = parseSemanticOutput(raw)
        const usage = normalizedUsage(payload?.usage)
        if (finishReason !== 'stop' && finishReason !== 'length') {
          throw new UpstreamIncompleteResponseError({
            raw: semantic.raw,
            body: semantic.body,
            annotation: semantic.annotation,
            finishReason,
            usage,
            terminalEvidence,
            finishReasonInferred,
            providerDiagnostics,
          })
        }
        if (finishReason === 'stop' && !raw.trim()) {
          throw new UpstreamEmptyVisibleContentError({
            raw: semantic.raw,
            body: semantic.body,
            annotation: semantic.annotation,
            finishReason,
            usage,
            terminalEvidence,
            finishReasonInferred,
            providerDiagnostics,
          })
        }
        if (finishReason === 'stop' && !semantic.body) throw new Error('FSBP body is empty.')
        const incomplete = finishReason === 'length'
        const record = redactCredentialValue({
          eventId: randomUUID(),
          eventType: 'model_call_attempt',
          roundId: ROUND_ID,
          runId,
          taskKey,
          sampleId,
          datasetName,
          phase,
          model,
          attempt,
          status: incomplete ? 'incomplete_output' : 'complete',
          requestHash: hashJson(requestPayload),
          requestSeed,
          providerSeedSent: false,
          startedAt,
          completedAt: new Date().toISOString(),
          latencyMs: Math.round(performance.now() - started),
          raw: semantic.raw,
          body: semantic.body,
          annotation: semantic.annotation,
          boundaryFound: semantic.boundaryFound,
          boundaryCount: semantic.boundaryCount,
          finishReason,
          terminalEvidence,
          finishReasonInferred,
          ...(providerDiagnostics ? { providerDiagnostics } : {}),
          truncated: incomplete,
          transport,
          ...(incomplete
            ? {
                errorCode: 'incomplete_output',
                errorOrigin: 'upstream',
                error: 'Provider ended the response at the frozen output-token limit.',
              }
            : {}),
          usage,
          ...meta,
        }, [attemptApiKey])
        await append(eventsPath, record, [attemptApiKey])
        if (incomplete) {
          if (attempt < maxAttempts) continue
          throw new IncompleteOutputError(record)
        }
        successByTask.set(taskKey, record)
        return record
      } catch (error) {
        if (error instanceof IncompleteOutputError) throw error
        const failure = errorRecord(error, [attemptApiKey])
        const partial = (
          error instanceof UpstreamStreamInterruptedError ||
          error instanceof UpstreamEmptyVisibleContentError ||
          error instanceof UpstreamEventError ||
          error instanceof UpstreamIncompleteResponseError ||
          error instanceof UpstreamTimeoutError
        )
          ? redactCredentialValue(error.partialRecord, [attemptApiKey])
          : null
        const retryDelay = retryBackoffMs(error, attempt)
        const retryScheduled = (
          failure.retryable &&
          attempt < maxAttempts &&
          performance.now() + retryDelay < callDeadline
        )
        await append(eventsPath, {
          eventId: randomUUID(),
          eventType: 'model_call_attempt',
          roundId: ROUND_ID,
          runId,
          taskKey,
          sampleId,
          datasetName,
          phase,
          model,
          attempt,
          status: failure.code === 'cancelled' ? 'cancelled' : 'failed',
          requestHash: hashJson(requestPayload),
          requestSeed,
          providerSeedSent: false,
          startedAt,
          completedAt: new Date().toISOString(),
          latencyMs: Math.round(performance.now() - started),
          errorCode: failure.code,
          errorOrigin: failure.origin,
          error: failure.message,
          retryScheduled,
          retryDelayMs: retryScheduled ? retryDelay : null,
          ...(partial
            ? {
                partialRaw: partial.raw,
                partialBody: partial.body,
                partialAnnotation: partial.annotation,
                finishReason: partial.finishReason,
                usage: partial.usage ?? null,
                terminalEvidence: partial.terminalEvidence ?? null,
                finishReasonInferred: partial.finishReasonInferred ?? false,
                ...(partial.providerDiagnostics
                  ? { providerDiagnostics: partial.providerDiagnostics }
                  : {}),
                ...(partial.providerEventError
                  ? { providerEventError: partial.providerEventError }
                  : {}),
                truncated: true,
              }
            : {}),
          ...meta,
        }, [attemptApiKey])
        if (!retryScheduled) throw redactErrorInPlace(error, [attemptApiKey])
        if (!await waitForRetry(retryDelay, callDeadline)) {
          throw new UpstreamTimeoutError(
            'Shared model-call deadline expired during retry backoff.',
            partial,
          )
        }
      }
    }
    throw new Error(`Unreachable task state: ${taskKey}`)
  }

  async function callModel({ taskKey, sampleId, datasetName, phase, model, messages, meta = {} }) {
    const logicalTaskKey = taskKey
    const fallbackTaskKey = `${logicalTaskKey}:fallback`
    const cached = successByTask.get(logicalTaskKey) ?? successByTask.get(fallbackTaskKey)
    if (cached) return cached
    const primaryMeta = {
      ...meta,
      logicalTaskKey,
      fallbackFrom: null,
      fallbackReason: null,
      fallbackAttempt: null,
    }
    try {
      return await callModelAttempts({
        taskKey: logicalTaskKey,
        sampleId,
        datasetName,
        phase,
        model,
        messages,
        meta: primaryMeta,
        maxAttempts: parameters.retries + 1,
      })
    } catch (error) {
      if (!permitsFrozenFallback(error)) throw error
      return callModelAttempts({
        taskKey: fallbackTaskKey,
        sampleId,
        datasetName,
        phase,
        model: fallbackModel,
        messages,
        meta: {
          ...meta,
          logicalTaskKey,
          fallbackFrom: model,
          fallbackReason: fallbackReason(error),
          fallbackAttempt: 1,
        },
        maxAttempts: fallbackAttempts,
      })
    }
  }

  async function saveOutcome(record) {
    const safeRecord = redactCredentialValue(record)
    const previous = latestOutcome.get(safeRecord.outcomeKey)
    if (previous?.status === 'complete') return previous
    if (previous && previous.status !== 'complete' && !args['retry-failed']) return previous
    await append(outcomesPath, safeRecord)
    latestOutcome.set(safeRecord.outcomeKey, safeRecord)
    return safeRecord
  }

  async function runPipeline({ sample, datasetName, condition, candidates, candidateSetHash }) {
    const outcomeKey = `${datasetName}:${sample.id}:${condition}`
    const existing = latestOutcome.get(outcomeKey)
    if (existing?.status === 'complete') return existing
    if (existing && existing.status !== 'complete' && !args['retry-failed']) return existing
    const comparisonControl = {
      sampleHash: hashJson(sample),
      candidateSetHash,
      editorModel: snapshot.models.editor,
      parameters,
      promptStagesHash: hashJson(snapshot.promptBundle.stages),
      toolLimits: snapshot.toolLimits,
      stageSeeds: Object.fromEntries(
        STAGES.map((stage) => [stage, modelSeed(snapshot.seed, sample.id, `stage:${stage}`)]),
      ),
    }
    const comparisonControlHash = hashJson(comparisonControl)
    const stageRecords = new Map()
    try {
      for (const stage of STAGES) {
        const record = await callModel({
          taskKey: `${datasetName}:${sample.id}:${condition}:${stage}`,
          sampleId: sample.id,
          datasetName,
          phase: 'stage',
          model: snapshot.models.editor,
          messages: stageMessages(
            sample,
            snapshot.promptBundle,
            stage,
            condition,
            candidates,
            stageRecords,
          ),
          meta: {
            condition,
            stage,
            seedScope: `stage:${stage}`,
            inheritedView: condition === 'multi_raw' ? 'raw' : 'body',
            candidateSetHash,
            comparisonControlHash,
          },
        })
        stageRecords.set(stage, record)
      }
      const finalRecord = stageRecords.get('assemble')
      return saveOutcome({
        outcomeId: randomUUID(),
        outcomeKey,
        roundId: ROUND_ID,
        namespace: 'fsbp',
        runId,
        datasetName,
        experiment: datasetName === 'annotationStress'
          ? 'annotation_isolation'
          : 'translation_quality',
        sampleId: sample.id,
        direction: sample.direction,
        category: sample.category ?? null,
        sourceText: sample.sourceText,
        taskBrief: sample.taskBrief ?? '',
        condition,
        status: 'complete',
        model: snapshot.models.editor,
        text: finalRecord.body,
        raw: finalRecord.raw,
        sourceTaskKey: finalRecord.taskKey,
        candidateSetHash,
        candidateSnapshotHash: candidateSetHash,
        pairId: sha256(`${datasetName}\u0000${sample.id}\u0000${comparisonControlHash}`),
        comparisonControlHash,
        allowedDifference: 'downstream_inherited_view_only',
        inheritedView: condition === 'multi_raw' ? 'raw' : 'body',
        targetedError: sample.targetedError ?? null,
        errorEvidence: sample.errorEvidence ?? null,
        annotationInfluence: sample.annotationInfluence ?? null,
        confirmationStatus: sample.confirmationStatus ?? null,
        completedAt: new Date().toISOString(),
      })
    } catch (error) {
      return saveOutcome({
        outcomeId: randomUUID(),
        outcomeKey,
        roundId: ROUND_ID,
        namespace: 'fsbp',
        runId,
        datasetName,
        experiment: datasetName === 'annotationStress'
          ? 'annotation_isolation'
          : 'translation_quality',
        sampleId: sample.id,
        direction: sample.direction,
        category: sample.category ?? null,
        sourceText: sample.sourceText,
        taskBrief: sample.taskBrief ?? '',
        condition,
        ...failedOutcomeFields(error),
        candidateSetHash,
        candidateSnapshotHash: candidateSetHash,
        pairId: sha256(`${datasetName}\u0000${sample.id}\u0000${comparisonControlHash}`),
        comparisonControlHash,
        allowedDifference: 'downstream_inherited_view_only',
        inheritedView: condition === 'multi_raw' ? 'raw' : 'body',
        targetedError: sample.targetedError ?? null,
        errorEvidence: sample.errorEvidence ?? null,
        annotationInfluence: sample.annotationInfluence ?? null,
        confirmationStatus: sample.confirmationStatus ?? null,
        completedAt: new Date().toISOString(),
      })
    }
  }

  async function runDirect(sample, datasetName) {
    const outcomeKey = `${datasetName}:${sample.id}:direct`
    const existing = latestOutcome.get(outcomeKey)
    if (existing?.status === 'complete') return existing
    if (existing && existing.status !== 'complete' && !args['retry-failed']) return existing
    try {
      const direct = await callModel({
        taskKey: `${datasetName}:${sample.id}:direct`,
        sampleId: sample.id,
        datasetName,
        phase: 'direct',
        model: snapshot.models.direct,
        messages: directMessages(sample, snapshot.promptBundle),
        meta: { condition: 'direct', seedScope: 'direct' },
      })
      return saveOutcome({
        outcomeId: randomUUID(),
        outcomeKey,
        roundId: ROUND_ID,
        namespace: 'fsbp',
        runId,
        datasetName,
        experiment: 'translation_quality',
        sampleId: sample.id,
        direction: sample.direction,
        category: sample.category ?? null,
        sourceText: sample.sourceText,
        taskBrief: sample.taskBrief ?? '',
        condition: 'direct',
        status: 'complete',
        model: direct.model,
        text: direct.body,
        raw: direct.raw,
        sourceTaskKey: direct.taskKey,
        completedAt: new Date().toISOString(),
      })
    } catch (error) {
      return saveOutcome({
        outcomeId: randomUUID(),
        outcomeKey,
        roundId: ROUND_ID,
        namespace: 'fsbp',
        runId,
        datasetName,
        experiment: 'translation_quality',
        sampleId: sample.id,
        direction: sample.direction,
        category: sample.category ?? null,
        sourceText: sample.sourceText,
        taskBrief: sample.taskBrief ?? '',
        condition: 'direct',
        ...failedOutcomeFields(error),
        completedAt: new Date().toISOString(),
      })
    }
  }

  async function qualityCandidates(sample, datasetName, datasetSnapshotHash) {
    const sourceHash = sha256(sample.sourceText)
    const retrievalSnapshotHash = hashJson(
      sample.retrievalSnapshot ?? sample.projectMemorySnapshot ?? null,
    )
    const promptHash = hashJson({
      analysis: snapshot.promptBundle.analysis,
      candidate: snapshot.promptBundle.candidate,
    })
    const modelHash = hashJson({
      analysis: snapshot.models.analysis,
      candidates: snapshot.models.candidates,
      fallbackModel: snapshot.models.fallbackModel,
    })
    const parametersHash = hashJson(parameters)
    const cacheControl = {
      sampleHash: hashJson(sample),
      sourceHash,
      datasetSnapshotHash,
      retrievalSnapshotHash,
      generatorCommit: freeze.source.commit,
      promptHash,
      modelHash,
      parametersHash,
      seed: snapshot.seed,
    }
    const cacheKey = sha256(`${datasetName}\u0000${sample.id}\u0000${hashJson(cacheControl)}`)
    const cached = candidateCache.get(cacheKey)
    if (cached) {
      if (cached.controlHash !== hashJson(cacheControl)) {
        throw new Error(`${sample.id}: candidate cache control hash mismatch.`)
      }
      if (
        cached.immutable !== true ||
        cached.candidateSetHash !== hashJson(cached.candidates) ||
        cached.sourceHash !== sourceHash ||
        cached.datasetSnapshotHash !== datasetSnapshotHash ||
        cached.retrievalSnapshotHash !== retrievalSnapshotHash ||
        cached.generatorCommit !== freeze.source.commit ||
        cached.promptHash !== promptHash ||
        cached.modelHash !== modelHash ||
        cached.parametersHash !== parametersHash
      ) {
        throw new Error(`${sample.id}: immutable candidate snapshot hash mismatch.`)
      }
      return cached
    }
    const analyses = await allOrThrowAfterSettled(
      snapshot.models.analysis.map((model, index) => callModel({
        taskKey: `${datasetName}:${sample.id}:analysis:${index + 1}`,
        sampleId: sample.id,
        datasetName,
        phase: 'analysis',
        model,
        messages: analysisMessages(sample, snapshot.promptBundle, index),
        meta: { analysisIndex: index + 1, seedScope: `analysis:${index + 1}` },
      })),
    )
    const candidates = await allOrThrowAfterSettled(
      snapshot.models.candidates.map((model, index) => callModel({
        taskKey: `${datasetName}:${sample.id}:candidate:${index + 1}`,
        sampleId: sample.id,
        datasetName,
        phase: 'candidate',
        model,
        messages: candidateMessages(sample, snapshot.promptBundle, index, analyses),
        meta: { candidateIndex: index + 1, seedScope: `candidate:${index + 1}` },
      })),
    )
    const publicCandidates = candidates.map((record) => ({
      taskKey: record.logicalTaskKey ?? record.taskKey,
      physicalTaskKey: record.taskKey,
      fallbackFrom: record.fallbackFrom ?? null,
      fallbackReason: record.fallbackReason ?? null,
      fallbackAttempt: record.fallbackAttempt ?? null,
      model: record.model,
      requestHash: record.requestHash,
      raw: record.raw,
      body: record.body,
      annotation: record.annotation,
      boundaryFound: record.boundaryFound,
      boundaryCount: record.boundaryCount,
    }))
    const record = redactCredentialValue({
      cacheRecordId: randomUUID(),
      cacheKey,
      roundId: ROUND_ID,
      namespace: 'fsbp',
      runId,
      datasetName,
      sampleId: sample.id,
      immutable: true,
      sourceHash,
      datasetSnapshotHash,
      retrievalSnapshotHash,
      generatorCommit: freeze.source.commit,
      promptHash,
      modelHash,
      parametersHash,
      controlHash: hashJson(cacheControl),
      analysisTaskKeys: analyses.map((entry) => entry.logicalTaskKey ?? entry.taskKey),
      analysisPhysicalTaskKeys: analyses.map((entry) => entry.taskKey),
      candidates: publicCandidates,
      candidateSetHash: hashJson(publicCandidates),
      createdAt: new Date().toISOString(),
    })
    await append(cachePath, record)
    candidateCache.set(cacheKey, record)
    return record
  }

  const selectedDatasets = args.dataset
    ? String(args.dataset).split(',').map((name) => name.trim()).filter(Boolean)
    : Object.keys(snapshot.datasets)
  for (const name of selectedDatasets) {
    if (!snapshot.datasets[name]) throw new Error(`Unknown frozen dataset: ${name}`)
  }

  for (const datasetName of selectedDatasets) {
    const descriptor = snapshot.datasets[datasetName]
    const datasetPath = resolvePortable(repositoryRoot, descriptor.path)
    const samples = await readJsonl(datasetPath)
    for (const sample of samples) {
      if (hashJson(sample) !== descriptor.recordHashes[sample.id]) {
        throw new Error(`${datasetName}:${sample.id}: frozen record hash mismatch.`)
      }
      assertNonEmptyString(sample.sourceText, `${datasetName}:${sample.id}.sourceText`)
    }
    await runWorkerPool(samples, sampleConcurrency, async (sample) => {
      if (descriptor.kind === 'annotation_isolation' || datasetName === 'annotationStress') {
        const candidate = normalizeUpstreamCandidate(sample)
        const sourceHash = sha256(sample.sourceText)
        const datasetSnapshotHash = descriptor.sha256
        const retrievalSnapshotHash = hashJson(
          sample.retrievalSnapshot ?? sample.projectMemorySnapshot ?? null,
        )
        const generatorCommit = sample.upstream?.generatorCommit ??
          sample.generatorCommit ?? freeze.source.commit
        const promptHash = hashJson(snapshot.promptBundle.stages)
        const modelHash = hashJson({
          upstream: candidate.model,
          editor: snapshot.models.editor,
        })
        const parametersHash = hashJson(parameters)
        const frozenCandidate = {
          ...candidate,
          immutable: true,
          sourceHash,
          datasetSnapshotHash,
          retrievalSnapshotHash,
          generatorCommit,
          promptHash,
          modelHash,
          parametersHash,
        }
        const candidates = [frozenCandidate]
        const candidateSetHash = hashJson(candidates)
        const controlHash = hashJson({
          sourceHash,
          datasetSnapshotHash,
          retrievalSnapshotHash,
          generatorCommit,
          promptHash,
          modelHash,
          parametersHash,
          seed: snapshot.seed,
        })
        const cacheKey = sha256(
          `${datasetName}\u0000${sample.id}\u0000${controlHash}`,
        )
        const cached = candidateCache.get(cacheKey)
        if (cached) {
          if (
            cached.immutable !== true ||
            cached.controlHash !== controlHash ||
            cached.candidateSetHash !== hashJson(cached.candidates)
          ) {
            throw new Error(`${sample.id}: frozen evidence snapshot hash mismatch.`)
          }
        } else {
          const cacheRecord = redactCredentialValue({
            cacheRecordId: randomUUID(),
            cacheKey,
            roundId: ROUND_ID,
            namespace: 'fsbp',
            runId,
            datasetName,
            sampleId: sample.id,
            kind: 'frozen_annotation_evidence',
            immutable: true,
            sourceHash,
            datasetSnapshotHash,
            retrievalSnapshotHash,
            generatorCommit,
            promptHash,
            modelHash,
            parametersHash,
            controlHash,
            analysisTaskKeys: [],
            candidates,
            candidateSetHash,
            createdAt: new Date().toISOString(),
          })
          await append(cachePath, cacheRecord)
          candidateCache.set(cacheKey, cacheRecord)
        }
        const sharedCandidates = (cached ?? candidateCache.get(cacheKey)).candidates
        const sharedCandidateSetHash = (cached ?? candidateCache.get(cacheKey)).candidateSetHash
        await allOrThrowAfterSettled(
          MULTI_CONDITIONS.map((condition) => runPipeline({
            sample,
            datasetName,
            condition,
            candidates: sharedCandidates,
            candidateSetHash: sharedCandidateSetHash,
          })),
        )
      } else if (descriptor.kind === 'quality' || datasetName === 'quality') {
        const [directResult, candidateResult] = await Promise.allSettled([
          runDirect(sample, datasetName),
          qualityCandidates(
            sample,
            datasetName,
            descriptor.sha256,
          ),
        ])
        if (directResult.status === 'rejected') throw directResult.reason
        if (candidateResult.status === 'rejected') {
          const error = candidateResult.reason
          await allOrThrowAfterSettled(
            MULTI_CONDITIONS.map((condition) => saveOutcome({
              outcomeId: randomUUID(),
              outcomeKey: `${datasetName}:${sample.id}:${condition}`,
              roundId: ROUND_ID,
              namespace: 'fsbp',
              runId,
              datasetName,
              experiment: 'translation_quality',
              sampleId: sample.id,
              direction: sample.direction,
              category: sample.category ?? null,
              sourceText: sample.sourceText,
              taskBrief: sample.taskBrief ?? '',
              condition,
              ...failedOutcomeFields(error, 'Shared candidate generation failed: '),
              candidateSetHash: null,
              pairId: sha256(`${datasetName}\u0000${sample.id}\u0000candidate-failure`),
              comparisonControlHash: null,
              allowedDifference: 'downstream_inherited_view_only',
              inheritedView: condition === 'multi_raw' ? 'raw' : 'body',
              completedAt: new Date().toISOString(),
            })),
          )
          process.stdout.write(`Completed ${datasetName}:${sample.id}\n`)
          return
        }
        const candidateRecord = candidateResult.value
        await allOrThrowAfterSettled(
          MULTI_CONDITIONS.map((condition) => runPipeline({
            sample,
            datasetName,
            condition,
            candidates: candidateRecord.candidates,
            candidateSetHash: candidateRecord.candidateSetHash,
          })),
        )
      } else {
        throw new Error(
          `${datasetName}: unsupported dataset kind ${descriptor.kind}; expected quality or annotation_isolation.`,
        )
      }
      process.stdout.write(`Completed ${datasetName}:${sample.id}\n`)
    })
  }

  await appendQueue
  const allOutcomes = await readJsonl(outcomesPath, { allowMissing: true })
  const latest = new Map()
  for (const record of allOutcomes) latest.set(record.outcomeKey, record)
  const finalRecords = [...latest.values()]
    .map((record) => redactCredentialValue(record))
    .sort((left, right) =>
      left.datasetName.localeCompare(right.datasetName) ||
      left.sampleId.localeCompare(right.sampleId) ||
      ['direct', 'multi_raw', 'multi_fsbp'].indexOf(left.condition) -
        ['direct', 'multi_raw', 'multi_fsbp'].indexOf(right.condition),
    )
  await writeJsonlAtomic(finalPath, finalRecords)
  const eventRecords = await readJsonl(eventsPath, { allowMissing: true })
  const failed = finalRecords.filter((record) => record.status !== 'complete')
  const completed = finalRecords.filter((record) => record.status === 'complete')
  const usageRecords = eventRecords
    .map((record) => ({ record, usage: normalizedUsage(record.usage) }))
    .filter((entry) => entry.usage !== null)
  const usageStatistics = {
    attemptsWithUsage: usageRecords.length,
    attemptsMissingUsage: eventRecords.length - usageRecords.length,
    completedAttemptsWithUsage: usageRecords
      .filter(({ record }) => record.status === 'complete').length,
    failedAttemptsWithUsage: usageRecords
      .filter(({ record }) => record.status === 'failed' || record.status === 'cancelled').length,
    incompleteAttemptsWithUsage: usageRecords
      .filter(({ record }) => record.status === 'incomplete_output').length,
    promptTokens: usageRecords.reduce((total, { usage: recordUsage }) => (
      total + recordUsage.prompt_tokens
    ), 0),
    completionTokens: usageRecords.reduce((total, { usage: recordUsage }) => (
      total + recordUsage.completion_tokens
    ), 0),
    totalTokens: usageRecords.reduce((total, { usage: recordUsage }) => (
      total + recordUsage.total_tokens
    ), 0),
  }
  const artifacts = {
    events: await jsonlArtifact(outputDir, eventsPath),
    outcomes: await jsonlArtifact(outputDir, outcomesPath),
    candidateCache: await jsonlArtifact(outputDir, cachePath),
    final: await jsonlArtifact(outputDir, finalPath),
  }
  await writeJsonAtomic(runManifestPath, {
    ...(await readJson(runManifestPath)),
    updatedAt: new Date().toISOString(),
    status: failed.length ? 'completed_with_failures' : 'complete',
    selectedDatasets,
    resultCounts: {
      total: finalRecords.length,
      complete: completed.length,
      failed: failed.length,
      failedOutcomeKeys: failed.map((record) => record.outcomeKey),
      recordedAttempts: eventRecords.length,
      recordedFailedAttempts: eventRecords.filter((record) => record.status === 'failed').length,
      recordedIncompleteAttempts: eventRecords
        .filter((record) => record.status === 'incomplete_output').length,
      cachedCandidateSets: candidateCache.size,
    },
    usageStatistics,
    artifacts,
  })
  process.stdout.write(`${JSON.stringify({
    runId,
    status: failed.length ? 'completed_with_failures' : 'complete',
    complete: completed.length,
    failed: failed.length,
    outputDir,
  }, null, 2)}\n`)
  if (failed.length) process.exitCode = 1
}

if (
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runRound0820().catch((error) => {
    process.stderr.write(`${redactCredentialText(
      error instanceof Error ? error.stack ?? error.message : String(error),
    )}\n`)
    process.exitCode = 1
  })
}
