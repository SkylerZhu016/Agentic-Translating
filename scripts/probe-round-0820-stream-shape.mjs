import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  assertConnectionMatchesFreezeEndpoint,
  normalizeConnectionBase,
  parseKeyFileContents,
} from './run-round-0820-with-key-file.mjs'
import {
  hashFile,
  hashJson,
  readJsonl,
  resolvePortable,
  seededNumber,
} from './round-0820-lib.mjs'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptDirectory, '..')
const defaultKeyFile = path.join(
  repositoryRoot,
  '迭代文档',
  '第三轮迭代材料',
  '更换key.txt',
)
const defaultFreezeFile = path.join(
  repositoryRoot,
  'FSBP_Test',
  'private',
  'round-0820',
  'freeze-manifest.json',
)

const EXPECTED_MODEL = 'GPT 5.6 Sol: CPA'
const PROBE_PROFILES = new Set([
  'simple',
  'frozen-direct',
  'frozen-direct-no-seed',
])
const PROBE_PROMPT = 'Reply exactly: OK'
const MAX_TOKENS = 16
const HARD_TIMEOUT_MS = 900_000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

// Only stable protocol keys are reported. Unknown keys and their values are
// counted as redacted so provider-controlled object keys cannot become output.
const SAFE_JSON_KEYS = new Set([
  'id',
  'object',
  'created',
  'model',
  'service_tier',
  'system_fingerprint',
  'choices',
  'index',
  'delta',
  'message',
  'role',
  'content',
  'reasoning_content',
  'reasoning_content_delta',
  'reasoning',
  'thinking',
  'analysis',
  'output_text',
  'text',
  'refusal',
  'annotations',
  'audio',
  'tool_calls',
  'function_call',
  'finish_reason',
  'logprobs',
  'usage',
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'prompt_tokens_details',
  'completion_tokens_details',
  'cached_tokens',
  'audio_tokens',
  'reasoning_tokens',
  'accepted_prediction_tokens',
  'rejected_prediction_tokens',
  'error',
  'status',
  'code',
  'type',
  'param',
  'message',
])
const TEXT_FIELD_KEYS = new Set([
  'content',
  'reasoning_content',
  'reasoning_content_delta',
  'reasoning',
  'thinking',
  'analysis',
  'output_text',
  'text',
  'refusal',
])
const KNOWN_FINISH_REASONS = new Set([
  'stop',
  'length',
  'content_filter',
  'tool_calls',
  'function_call',
])

class SafeProbeError extends Error {
  constructor(code, type = 'probe_error', status = null) {
    super(code)
    this.name = 'SafeProbeError'
    this.code = sanitizeIdentifier(code)
    this.type = sanitizeIdentifier(type)
    this.status = Number.isInteger(status) ? status : null
  }
}

function sanitizeIdentifier(value, fallback = 'unrecognized') {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/.test(trimmed)
    ? trimmed
    : fallback
}

export function parseProbeArguments(argv) {
  const selected = {
    keyFile: defaultKeyFile,
    freezeFile: defaultFreezeFile,
    profile: 'simple',
  }
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const equals = token.indexOf('=')
    const name = equals >= 0 ? token.slice(0, equals) : token
    if (!['--key-file', '--freeze', '--profile'].includes(name)) {
      throw new SafeProbeError('invalid_argument')
    }
    if (seen.has(name)) throw new SafeProbeError('duplicate_argument')
    seen.add(name)
    const value = equals >= 0 ? token.slice(equals + 1) : argv[++index]
    if (!value || value.startsWith('--')) {
      throw new SafeProbeError('missing_argument_value')
    }
    if (name === '--key-file') selected.keyFile = path.resolve(value)
    if (name === '--freeze') selected.freezeFile = path.resolve(value)
    if (name === '--profile') {
      if (!PROBE_PROFILES.has(value)) {
        throw new SafeProbeError('invalid_profile')
      }
      selected.profile = value
    }
  }
  return selected
}

function modelSeed(seed, sampleId, phase) {
  return Math.floor(seededNumber(seed, sampleId, phase) * 2_147_483_647)
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

function isNonEmptyString(value) {
  return typeof value === 'string' && Boolean(value.trim())
}

async function resolveFrozenDatasetPath(portablePath) {
  let declaredPath
  let realRepositoryRoot
  let realDatasetPath
  try {
    declaredPath = resolvePortable(repositoryRoot, portablePath)
    ;[realRepositoryRoot, realDatasetPath] = await Promise.all([
      realpath(repositoryRoot),
      realpath(declaredPath),
    ])
  } catch {
    throw new SafeProbeError('frozen_dataset_path_invalid')
  }
  const relative = path.relative(realRepositoryRoot, realDatasetPath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SafeProbeError('frozen_dataset_path_invalid')
  }
  return realDatasetPath
}

async function frozenDirectRequest(manifest) {
  const snapshot = assertPlainObject(
    manifest.snapshot,
    'invalid_frozen_snapshot',
  )
  const datasets = assertPlainObject(
    snapshot.datasets,
    'invalid_frozen_datasets',
  )
  const descriptor = assertPlainObject(
    datasets.quality,
    'missing_quality_dataset',
  )
  if (descriptor.name !== 'quality' || descriptor.kind !== 'quality') {
    throw new SafeProbeError('invalid_quality_descriptor')
  }
  if (
    !isNonEmptyString(descriptor.path) ||
    !/^[a-f0-9]{64}$/i.test(descriptor.sha256 ?? '') ||
    !Number.isInteger(descriptor.expectedCount) || descriptor.expectedCount < 1
  ) {
    throw new SafeProbeError('invalid_quality_descriptor')
  }
  const recordHashes = assertPlainObject(
    descriptor.recordHashes,
    'invalid_quality_record_hashes',
  )
  const datasetPath = await resolveFrozenDatasetPath(descriptor.path)
  let records
  try {
    if (await hashFile(datasetPath) !== descriptor.sha256) {
      throw new SafeProbeError('quality_file_hash_mismatch')
    }
    records = await readJsonl(datasetPath)
  } catch (error) {
    if (error instanceof SafeProbeError) throw error
    throw new SafeProbeError('quality_dataset_unreadable')
  }
  if (records.length !== descriptor.expectedCount || records.length < 1) {
    throw new SafeProbeError('quality_record_count_mismatch')
  }

  const sample = assertPlainObject(records[0], 'invalid_first_quality_record')
  if (
    !isNonEmptyString(sample.id) ||
    !Object.hasOwn(recordHashes, sample.id) ||
    !/^[a-f0-9]{64}$/i.test(recordHashes[sample.id] ?? '') ||
    hashJson(sample) !== recordHashes[sample.id]
  ) {
    throw new SafeProbeError('first_quality_record_hash_mismatch')
  }
  if (
    !['en_to_zh', 'zh_to_en'].includes(sample.direction) ||
    !isNonEmptyString(sample.sourceText) ||
    (sample.taskBrief !== undefined && typeof sample.taskBrief !== 'string') ||
    (sample.contextBefore !== undefined && typeof sample.contextBefore !== 'string') ||
    (sample.contextAfter !== undefined && typeof sample.contextAfter !== 'string')
  ) {
    throw new SafeProbeError('invalid_first_quality_record')
  }

  const promptBundle = assertPlainObject(
    snapshot.promptBundle,
    'invalid_frozen_prompt_bundle',
  )
  const parameters = assertPlainObject(
    snapshot.parameters,
    'invalid_frozen_parameters',
  )
  if (!isNonEmptyString(promptBundle.direct) || !isNonEmptyString(snapshot.seed)) {
    throw new SafeProbeError('invalid_frozen_direct_request')
  }
  if (
    typeof parameters.temperature !== 'number' ||
    !Number.isFinite(parameters.temperature) ||
    parameters.temperature < 0 || parameters.temperature > 2 ||
    !Number.isInteger(parameters.maxTokens) || parameters.maxTokens < 1
  ) {
    throw new SafeProbeError('invalid_frozen_direct_request')
  }
  return {
    messages: [
      { role: 'system', content: promptBundle.direct },
      { role: 'user', content: sourceBlock(sample) },
    ],
    temperature: parameters.temperature,
    max_tokens: parameters.maxTokens,
    seed: modelSeed(snapshot.seed, sample.id, 'direct'),
  }
}

async function requestForProfile(profile, manifest) {
  if (profile === 'simple') {
    return {
      messages: [{ role: 'user', content: PROBE_PROMPT }],
      max_tokens: MAX_TOKENS,
      temperature: 0,
    }
  }
  if (profile === 'frozen-direct') return frozenDirectRequest(manifest)
  if (profile === 'frozen-direct-no-seed') {
    const request = await frozenDirectRequest(manifest)
    delete request.seed
    return request
  }
  throw new SafeProbeError('invalid_profile')
}

function unsignedFreezeManifest(manifest) {
  const { freezeManifestSha256: _ignored, ...unsigned } = manifest
  return unsigned
}

function assertPlainObject(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SafeProbeError(code)
  }
  return value
}

export function validateProbeFreeze(manifest) {
  assertPlainObject(manifest, 'invalid_freeze_manifest')
  if (
    manifest.roundId !== 'round-0820' ||
    manifest.namespace !== 'fsbp' ||
    manifest.snapshot?.roundId !== 'round-0820' ||
    manifest.snapshot?.namespace !== 'fsbp'
  ) {
    throw new SafeProbeError('wrong_freeze_identity')
  }
  if (
    typeof manifest.freezeManifestSha256 !== 'string' ||
    hashJson(unsignedFreezeManifest(manifest)) !== manifest.freezeManifestSha256
  ) {
    throw new SafeProbeError('freeze_hash_mismatch')
  }

  const endpoint = assertPlainObject(
    manifest.snapshot?.endpoint,
    'invalid_frozen_endpoint',
  )
  if (endpoint.apiKeyEnv !== 'FSBP_EXPERIMENT_API_KEY') {
    throw new SafeProbeError('unexpected_key_binding')
  }
  const frozenBase = normalizeConnectionBase(endpoint.baseUrl)
  const route = endpoint.chatCompletionsPath
  if (
    typeof route !== 'string' ||
    !route.startsWith('/') ||
    route.startsWith('//') ||
    route.includes('\\') ||
    route.includes('?') ||
    route.includes('#') ||
    route.split('/').some((segment) => segment === '.' || segment === '..') ||
    /%(?:2e|2f|3f|23|5c)/i.test(route)
  ) {
    throw new SafeProbeError('invalid_chat_completions_path')
  }
  let requestUrl
  try {
    requestUrl = new URL(`${frozenBase}${route}`)
  } catch {
    throw new SafeProbeError('invalid_request_url')
  }
  const frozenOrigin = new URL(frozenBase).origin
  if (
    requestUrl.protocol !== 'https:' ||
    requestUrl.origin !== frozenOrigin ||
    requestUrl.href !== `${frozenBase}${route}` ||
    requestUrl.username || requestUrl.password ||
    requestUrl.search || requestUrl.hash
  ) {
    throw new SafeProbeError('request_url_mismatch')
  }

  const models = assertPlainObject(
    manifest.snapshot?.models,
    'invalid_frozen_models',
  )
  if (models.direct !== EXPECTED_MODEL) {
    throw new SafeProbeError('unexpected_probe_model')
  }
  const frozenTimeout = manifest.snapshot?.parameters?.timeoutMs
  if (frozenTimeout !== HARD_TIMEOUT_MS) {
    throw new SafeProbeError('invalid_frozen_timeout')
  }
  return {
    endpoint,
    model: models.direct,
    requestUrl: requestUrl.href,
    timeoutMs: frozenTimeout,
  }
}

function makeProtocolAccumulator() {
  return {
    jsonPathCounts: new Map(),
    textFields: new Map(),
    finishReasons: new Map(),
    usageValues: new Map(),
    redactedJsonKeyOccurrences: 0,
    providerError: null,
    terminalFinishReason: false,
  }
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount)
}

function addTextField(accumulator, pathName, value) {
  const prior = accumulator.textFields.get(pathName) ?? {
    field: pathName,
    fragments: 0,
    nonEmptyFragments: 0,
    characters: 0,
  }
  prior.fragments += 1
  const length = Array.from(value).length
  prior.characters += length
  if (length > 0) prior.nonEmptyFragments += 1
  accumulator.textFields.set(pathName, prior)
}

function captureProviderError(accumulator, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  let error = null
  if (value.error && typeof value.error === 'object' && !Array.isArray(value.error)) {
    error = value.error
  } else if (
    Object.hasOwn(value, 'code') && Object.hasOwn(value, 'type') &&
    !Object.hasOwn(value, 'choices')
  ) {
    error = value
  }
  if (!error) return
  accumulator.providerError = {
    hasStatus: Object.hasOwn(error, 'status'),
    hasCode: Object.hasOwn(error, 'code'),
    hasType: Object.hasOwn(error, 'type'),
  }
}

export function inspectProtocolJson(value, accumulator, pathName = '$', context = {}) {
  if (Array.isArray(value)) {
    for (const child of value) {
      inspectProtocolJson(child, accumulator, `${pathName}[]`, context)
    }
    return
  }
  if (!value || typeof value !== 'object') return

  captureProviderError(accumulator, value)
  for (const [key, child] of Object.entries(value)) {
    if (!SAFE_JSON_KEYS.has(key)) {
      accumulator.redactedJsonKeyOccurrences += 1
      continue
    }
    const childPath = `${pathName}.${key}`
    increment(accumulator.jsonPathCounts, childPath)
    const inUsage = context.inUsage || key === 'usage'
    if (TEXT_FIELD_KEYS.has(key) && typeof child === 'string') {
      addTextField(accumulator, childPath, child)
    }
    if (key === 'finish_reason') {
      const reason = child === null
        ? 'null'
        : KNOWN_FINISH_REASONS.has(child) ? child : 'other'
      increment(accumulator.finishReasons, reason)
      if (typeof child === 'string') accumulator.terminalFinishReason = true
    }
    if (inUsage && typeof child === 'number' && Number.isFinite(child)) {
      const values = accumulator.usageValues.get(childPath) ?? []
      values.push(child)
      accumulator.usageValues.set(childPath, values)
    }
    inspectProtocolJson(child, accumulator, childPath, { inUsage })
  }
}

function sortedObject(map) {
  return Object.fromEntries(
    [...map.entries()].sort(([left], [right]) => left.localeCompare(right)),
  )
}

function protocolSummary(accumulator) {
  return {
    safeJsonKeyPathOccurrences: sortedObject(accumulator.jsonPathCounts),
    redactedJsonKeyOccurrences: accumulator.redactedJsonKeyOccurrences,
    candidateTextFields: [...accumulator.textFields.values()]
      .sort((left, right) => left.field.localeCompare(right.field)),
    finishReasons: sortedObject(accumulator.finishReasons),
    usage: [...accumulator.usageValues.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([field, values]) => ({ field, values })),
    providerError: accumulator.providerError,
  }
}

function isCompleteDataPayload(value) {
  const trimmed = value.trim()
  if (!trimmed) return false
  if (trimmed === '[DONE]') return true
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

function makeTransportStats() {
  return {
    bytes: 0,
    chunks: 0,
    zeroLengthChunks: 0,
    minimumChunkBytes: null,
    maximumChunkBytes: 0,
  }
}

function addChunk(stats, length) {
  stats.bytes += length
  stats.chunks += 1
  if (length === 0) stats.zeroLengthChunks += 1
  stats.minimumChunkBytes = stats.minimumChunkBytes === null
    ? length
    : Math.min(stats.minimumChunkBytes, length)
  stats.maximumChunkBytes = Math.max(stats.maximumChunkBytes, length)
  if (stats.bytes > MAX_RESPONSE_BYTES) {
    throw new SafeProbeError('response_too_large', 'transport_error')
  }
}

export function createSseShapeInspector() {
  const protocol = makeProtocolAccumulator()
  const transport = makeTransportStats()
  const textDecoder = new TextDecoder()
  let pending = ''
  let dataLines = []
  let ended = false
  const stats = {
    lineEndings: { crlf: 0, lf: 0, cr: 0 },
    blankLineDelimiters: 0,
    dataLines: 0,
    commentLines: 0,
    eventFieldLines: 0,
    idFieldLines: 0,
    retryFieldLines: 0,
    unknownFieldLines: 0,
    events: {
      total: 0,
      json: 0,
      done: 0,
      malformedJson: 0,
      emptyData: 0,
      eofTerminated: 0,
    },
    sawDone: false,
  }

  function dispatch(eofTerminated = false) {
    if (!dataLines.length) return
    stats.events.total += 1
    if (eofTerminated) stats.events.eofTerminated += 1
    const data = dataLines.join('\n')
    dataLines = []
    if (!data.trim()) {
      stats.events.emptyData += 1
      return
    }
    if (data.trim() === '[DONE]') {
      stats.events.done += 1
      stats.sawDone = true
      return
    }
    let parsed
    try {
      parsed = JSON.parse(data)
    } catch {
      stats.events.malformedJson += 1
      return
    }
    stats.events.json += 1
    inspectProtocolJson(parsed, protocol)
  }

  function processLine(line) {
    if (line === '') {
      stats.blankLineDelimiters += 1
      dispatch(false)
      return
    }
    if (line.startsWith(':')) {
      stats.commentLines += 1
      return
    }
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') {
      stats.dataLines += 1
      dataLines.push(value)
      // NewAPI may emit one complete JSON payload per data line without the
      // blank event delimiter required by the SSE specification. Dispatch as
      // soon as the current data block is independently complete; incomplete
      // multi-line SSE data remains buffered until it becomes valid JSON.
      if (isCompleteDataPayload(dataLines.join('\n'))) dispatch(false)
    } else if (field === 'event') {
      stats.eventFieldLines += 1
    } else if (field === 'id') {
      stats.idFieldLines += 1
    } else if (field === 'retry') {
      stats.retryFieldLines += 1
    } else {
      stats.unknownFieldLines += 1
    }
  }

  function consume(final = false) {
    let cursor = 0
    for (let index = 0; index < pending.length; index += 1) {
      const character = pending[index]
      if (character !== '\r' && character !== '\n') continue
      if (character === '\r' && index + 1 === pending.length && !final) break
      processLine(pending.slice(cursor, index))
      if (character === '\r' && pending[index + 1] === '\n') {
        stats.lineEndings.crlf += 1
        index += 1
      } else if (character === '\r') {
        stats.lineEndings.cr += 1
      } else {
        stats.lineEndings.lf += 1
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
      if (ended) throw new SafeProbeError('inspector_already_ended')
      addChunk(transport, chunk.byteLength)
      pending += textDecoder.decode(chunk, { stream: true })
      consume(false)
    },
    terminal() {
      return stats.sawDone || protocol.terminalFinishReason
    },
    end() {
      if (ended) throw new SafeProbeError('inspector_already_ended')
      ended = true
      pending += textDecoder.decode()
      consume(true)
      if (dataLines.length) dispatch(true)
      return {
        transport,
        sse: stats,
        protocol: protocolSummary(protocol),
      }
    },
  }
}

async function readSseShape(response) {
  if (!response.body) throw new SafeProbeError('missing_response_body', 'transport_error')
  const inspector = createSseShapeInspector()
  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      inspector.push(value)
      if (inspector.terminal()) {
        try {
          await reader.cancel()
        } catch {
          // Terminal protocol evidence is sufficient; cancellation details
          // are deliberately neither surfaced nor persisted.
        }
        break
      }
    }
  } catch (error) {
    try {
      await reader.cancel()
    } catch {
      // Deliberately ignore cancellation errors; nothing from them is emitted.
    }
    if (error instanceof SafeProbeError) throw error
    throw new SafeProbeError('stream_read_failed', 'transport_error')
  }
  return inspector.end()
}

async function readJsonShape(response) {
  if (!response.body) throw new SafeProbeError('missing_response_body', 'transport_error')
  const reader = response.body.getReader()
  const transport = makeTransportStats()
  const decoder = new TextDecoder()
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
    try {
      await reader.cancel()
    } catch {
      // Deliberately ignore cancellation errors; nothing from them is emitted.
    }
    if (error instanceof SafeProbeError) throw error
    throw new SafeProbeError('response_read_failed', 'transport_error')
  }
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new SafeProbeError('non_sse_non_json_response', 'protocol_error', response.status)
  } finally {
    body = ''
  }
  const protocol = makeProtocolAccumulator()
  inspectProtocolJson(parsed, protocol)
  return {
    transport,
    sse: null,
    protocol: protocolSummary(protocol),
  }
}

function safeFailure(error, status = null) {
  if (error instanceof SafeProbeError) {
    return {
      status: error.status ?? status,
      code: error.code,
      type: error.type,
    }
  }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return { status, code: 'timeout', type: 'transport_error' }
  }
  return { status, code: 'request_failed', type: 'transport_error' }
}

export async function runProbe({
  keyFile,
  freezeFile,
  profile = 'simple',
}) {
  let keyText
  let manifestText
  try {
    ;[keyText, manifestText] = await Promise.all([
      readFile(keyFile, 'utf8'),
      readFile(freezeFile, 'utf8'),
    ])
  } catch {
    throw new SafeProbeError('input_file_unreadable')
  }

  let keyMaterial
  let manifest
  try {
    keyMaterial = parseKeyFileContents(keyText)
    if (!keyMaterial.connectionBase) {
      throw new SafeProbeError('connection_json_required')
    }
  } catch {
    throw new SafeProbeError('key_file_invalid')
  } finally {
    keyText = ''
  }
  try {
    manifest = JSON.parse(manifestText)
  } catch {
    throw new SafeProbeError('freeze_json_invalid')
  } finally {
    manifestText = ''
  }

  const frozen = validateProbeFreeze(manifest)
  try {
    assertConnectionMatchesFreezeEndpoint(
      keyMaterial.connectionBase,
      frozen.endpoint,
    )
  } catch {
    throw new SafeProbeError('connection_freeze_mismatch')
  }
  const profileRequest = await requestForProfile(profile, manifest)

  let response
  try {
    response = await fetch(frozen.requestUrl, {
      method: 'POST',
      redirect: 'error',
      headers: {
        accept: 'text/event-stream',
        'content-type': 'application/json',
        authorization: `Bearer ${keyMaterial.apiKey}`,
      },
      body: JSON.stringify({
        model: frozen.model,
        ...profileRequest,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: AbortSignal.timeout(frozen.timeoutMs),
    })
  } catch (error) {
    throw new SafeProbeError(
      error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? 'timeout'
        : 'request_failed',
      'transport_error',
    )
  } finally {
    keyMaterial.apiKey = ''
  }

  if (
    response.redirected ||
    response.url !== frozen.requestUrl ||
    new URL(response.url).origin !== new URL(frozen.requestUrl).origin
  ) {
    try {
      await response.body?.cancel()
    } catch {
      // The mismatch is the only emitted fact.
    }
    throw new SafeProbeError('response_url_mismatch', 'transport_error', response.status)
  }

  const contentType = response.headers.get('content-type') ?? ''
  const normalizedContentType = contentType.toLowerCase()
  const mediaType = normalizedContentType.includes('text/event-stream')
    ? 'text_event_stream'
    : normalizedContentType.includes('application/json')
      ? 'application_json'
      : contentType ? 'other' : 'missing'
  const shape = mediaType === 'text_event_stream'
    ? await readSseShape(response)
    : await readJsonShape(response)
  const result = {
    ok: response.ok,
    profile,
    http: {
      status: response.status,
      mediaType,
    },
    ...shape,
  }
  if (!response.ok) {
    result.error = {
      status: response.status,
      code: 'http_error',
      type: 'upstream_error',
    }
  }
  return result
}

async function main() {
  let args
  try {
    args = parseProbeArguments(process.argv.slice(2))
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: safeFailure(error) }, null, 2)}\n`)
    process.exitCode = 1
    return
  }
  try {
    const result = await runProbe(args)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (!result.ok) process.exitCode = 1
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: safeFailure(error) }, null, 2)}\n`)
    process.exitCode = 1
  }
}

if (
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main()
}
