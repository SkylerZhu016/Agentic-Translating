// ---------------------------------------------------------------------------
// dev-harness.mts — zero-dependency CLI driver for the app's HTTP+SSE API.
//
// Mirrors the frontend protocol exactly (design: 迭代文档/第三轮迭代.txt §8.18):
// same endpoints, same SSE parser (imported from src/lib/contracts/sse.ts),
// same terminal-event semantics. Phase 1+2 scope: pure-CLI functional testing
// and debugging against a live server, without a browser.
//
// Run: node --experimental-strip-types scripts/dev-harness.mts <command> [flags]
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  parseSSEChunk,
  takeCompleteSSEText,
  type SSEEvent,
} from '../src/lib/contracts/sse.ts'

// ---------------------------------------------------------------------------
// Types & small utilities
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>

interface ParsedArgs {
  flags: Map<string, string>
  booleans: Set<string>
  positionals: string[]
}

interface CommandOutcome {
  code: number
  result: unknown
}

class HarnessError extends Error {
  exitCode: number
  dump: boolean
  constructor(message: string, exitCode: number = 1, dump: boolean = true) {
    super(message)
    this.name = 'HarnessError'
    this.exitCode = exitCode
    this.dump = dump
  }
}

function fail(message: string, exitCode: number = 1, dump: boolean = true): never {
  throw new HarnessError(message, exitCode, dump)
}

function asRecord(value: unknown): JsonObject | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonObject
  }
  return null
}

function asRecordArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? (value.filter(asRecord) as JsonObject[]) : []
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}…(${value.length}ch)`
}

function shortId(value: unknown): string {
  const text = String(value ?? '')
  return text.length > 8 ? text.slice(0, 8) : text
}

function preview(value: unknown, max: number): string {
  return truncate(String(value ?? '').replace(/\r?\n/g, '⏎'), max)
}

function parsePositiveInt(raw: string, flagName: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${flagName} must be a positive integer (got: ${raw})`, 1, false)
  }
  return value
}

function parseUuid(raw: string, flagName: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(raw)) {
    fail(`${flagName} must be a UUID (got: ${raw})`, 1, false)
  }
  return raw
}

// ---------------------------------------------------------------------------
// Global options, timestamps, output
// ---------------------------------------------------------------------------

const t0 = performance.now()

const opts = {
  command: '',
  base: process.env.AGENTIC_BASE_URL ?? 'http://127.0.0.1:3001',
  trace: false,
  timeoutMs: 600_000,
  watchdogMs: 300_000,
  json: false,
  sessionId: null as string | null,
}

function relStamp(): string {
  const elapsed = (performance.now() - t0) / 1000
  const minutes = Math.floor(elapsed / 60)
  const seconds = elapsed - minutes * 60
  return `[+${String(minutes).padStart(2, '0')}:${seconds.toFixed(1).padStart(4, '0')}]`
}

/** Human log line. In --json mode human output goes to stderr, stdout stays clean. */
function line(text: string): void {
  const rendered = `${relStamp()} ${text}\n`
  if (opts.json) process.stderr.write(rendered)
  else process.stdout.write(rendered)
}

// ---------------------------------------------------------------------------
// Trace (JSONL) + recent-event ring (failure dumps)
// ---------------------------------------------------------------------------

const DEBUG_DIR = path.join('FSBP_Test', 'private', 'debug')
const recentEvents: Array<{ t: string; kind: string; data: unknown }> = []
let tracePath: string | null = null

function fileTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function traceRecord(kind: string, data: unknown): void {
  const entry = { t: new Date().toISOString(), kind, data }
  recentEvents.push(entry)
  if (recentEvents.length > 50) recentEvents.shift()
  if (!opts.trace) return
  if (tracePath === null) {
    mkdirSync(DEBUG_DIR, { recursive: true })
    const owner = opts.sessionId ?? 'misc'
    tracePath = path.join(DEBUG_DIR, `${owner}-${opts.command}-${fileTimestamp()}.jsonl`)
  }
  appendFileSync(tracePath, `${JSON.stringify(entry)}\n`, 'utf8')
}

async function writeFailureDump(error: unknown): Promise<string | null> {
  try {
    mkdirSync(DEBUG_DIR, { recursive: true })
    const owner = opts.sessionId ?? 'misc'
    const file = path.join(
      DEBUG_DIR,
      `failure-${opts.command}-${owner}-${fileTimestamp()}.json`,
    )
    let stateSnapshot: unknown = null
    if (opts.sessionId !== null) {
      try {
        const res = await httpJson('GET', `/api/sessions/${opts.sessionId}`)
        if (res.status === 200) stateSnapshot = res.json
      } catch {
        // Best effort: never mask the original failure.
      }
    }
    writeFileSync(
      file,
      `${JSON.stringify(
        {
          command: opts.command,
          error: error instanceof Error ? error.message : String(error),
          lastEvents: recentEvents.slice(-50),
          stateSnapshot,
          fetchedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    return path.resolve(file)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Argument parsing (manual --flag=value style, same as run-round3 gate)
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string>()
  const booleans = new Set<string>()
  const positionals: string[] = []
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq === -1) booleans.add(arg.slice(2))
      else flags.set(arg.slice(2, eq), arg.slice(eq + 1))
    } else {
      positionals.push(arg)
    }
  }
  return { flags, booleans, positionals }
}

function requireFlag(args: ParsedArgs, name: string): string {
  const value = args.flags.get(name)
  if (value === undefined || value === '') {
    fail(`--${name}= is required for '${opts.command}'`, 1, false)
  }
  return value
}

function requireSession(args: ParsedArgs): string {
  const id = requireFlag(args, 'session')
  opts.sessionId = id
  return id
}

function rejectPositionals(args: ParsedArgs): void {
  if (args.positionals.length > 0) {
    fail(
      `unexpected argument(s): ${args.positionals.join(' ')} — use --flag=value form`,
      1,
      false,
    )
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers (per-request timeout via AbortController)
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      fail(`request timed out after ${opts.timeoutMs}ms: ${init.method ?? 'GET'} ${url}`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

interface JsonResponse {
  status: number
  ms: number
  text: string
  json: unknown
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function httpJson(method: string, urlPath: string, body?: unknown): Promise<JsonResponse> {
  const url = `${opts.base}${urlPath}`
  const started = performance.now()
  const response = await fetchWithTimeout(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const ms = Math.round(performance.now() - started)
  const text = await response.text()
  traceRecord('http', { method, url, status: response.status, ms })
  return { status: response.status, ms, text, json: parseBody(text) }
}

function errorMessage(payload: { status: number; text: string; json: unknown }): string {
  const body = asRecord(payload.json)
  if (body !== null) {
    const code = typeof body.error === 'string' ? body.error : ''
    const message = typeof body.message === 'string' ? body.message : ''
    if (code && message) return `${code}: ${message}`
    if (message) return message
    if (code) return code
  }
  return payload.text.slice(0, 500) || `HTTP ${payload.status}`
}

/** Open an SSE stream. Throws HarnessError on non-OK (after reading the error body). */
async function openEventStream(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<Response> {
  const url = `${opts.base}${urlPath}`
  const started = performance.now()
  const response = await fetchWithTimeout(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const ms = Math.round(performance.now() - started)
  traceRecord('http', { method, url, status: response.status, ms, stream: true })
  if (!response.ok) {
    const text = await response.text()
    fail(`${method} ${urlPath} → HTTP ${response.status}: ${errorMessage({ status: response.status, text, json: parseBody(text) })}`)
  }
  if (response.body === null) fail(`${method} ${urlPath} → response has no body`)
  return response
}

// ---------------------------------------------------------------------------
// Incremental SSE consumption (reader + TextDecoder + shared parser)
// ---------------------------------------------------------------------------

type EventHandler = (event: SSEEvent, data: JsonObject) => void

interface ConsumeResult {
  count: number
  lastEventId: string | null
}

async function consumeSSE(
  response: Response,
  handler: EventHandler,
  options: { watchdog: boolean },
): Promise<ConsumeResult> {
  const body = response.body
  if (body === null) fail('SSE response has no body')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let count = 0
  let lastEventId: string | null = null
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null

  const armWatchdog = (): void => {
    if (!options.watchdog) return
    if (watchdogTimer !== null) clearTimeout(watchdogTimer)
    watchdogTimer = setTimeout(() => {
      line(
        `watchdog: no SSE event for ${opts.watchdogMs}ms — still waiting ` +
        '(LLM silence is normal; agent.activity is throttled ≥5s; stream NOT aborted)',
      )
      armWatchdog()
    }, opts.watchdogMs)
  }

  const dispatch = (event: SSEEvent): void => {
    count += 1
    if (event.id !== undefined) lastEventId = event.id
    armWatchdog()
    let data: JsonObject = {}
    const parsed = parseBody(event.data)
    if (parsed !== null && asRecord(parsed) !== null) data = asRecord(parsed) as JsonObject
    traceRecord('sse', { event: event.event, id: event.id, data })
    handler(event, data)
  }

  armWatchdog()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      const { completeText, remainder } = takeCompleteSSEText(pending)
      pending = remainder
      if (completeText === '') continue
      for (const event of parseSSEChunk(completeText)) dispatch(event)
    }
    pending += decoder.decode()
    if (pending.trim() !== '') {
      // Terminate a trailing frame that was never closed by the server.
      for (const event of parseSSEChunk(`${pending}\n\n`)) dispatch(event)
    }
  } finally {
    if (watchdogTimer !== null) clearTimeout(watchdogTimer)
  }
  return { count, lastEventId }
}

// ---------------------------------------------------------------------------
// Run/events-stream rendering (vNext catalogue, §8.18 + vnext-runner emitters)
// ---------------------------------------------------------------------------

const SKIP_FIELDS = new Set(['seq'])

function scalarFields(data: JsonObject, extraSkip: Set<string> = new Set()): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(data)) {
    if (SKIP_FIELDS.has(key) || extraSkip.has(key) || value === null || value === undefined) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key}=${truncate(String(value), 100)}`)
    }
  }
  return parts.join(' ')
}

function arrayField(data: JsonObject, key: string): unknown[] {
  const value = data[key]
  return Array.isArray(value) ? value : []
}

class RunEventRenderer {
  private invNames = new Map<string, string>()
  private deltaStats = new Map<string, { count: number; chars: number }>()

  private flushDeltas(): void {
    for (const [invocationId, stat] of this.deltaStats) {
      const name = this.invNames.get(invocationId)
      line(
        `agent.delta ${name !== undefined && name !== '' ? name : shortId(invocationId)} ` +
        `x${stat.count} (${stat.chars} chars)`,
      )
    }
    this.deltaStats.clear()
  }

  finish(): void {
    this.flushDeltas()
  }

  handle(event: SSEEvent, data: JsonObject): void {
    const type = event.event
    if (type === 'agent.delta') {
      const invocationId = String(data.invocationId ?? '')
      const delta = String(data.delta ?? '')
      const stat = this.deltaStats.get(invocationId) ?? { count: 0, chars: 0 }
      stat.count += 1
      stat.chars += delta.length
      this.deltaStats.set(invocationId, stat)
      return
    }
    this.flushDeltas()
    switch (type) {
      case 'session.created':
        line(`session.created session=${shortId(data.sessionId)} run=${shortId(data.runId)}`)
        break
      case 'main.started':
        line(`main.started binding=${String(data.bindingSource ?? '?')}`)
        break
      case 'run.resumed':
        line(`run.resumed checkpoint=${preview(JSON.stringify(data.checkpoint ?? null), 120)}`)
        break
      case 'agent.batch.started':
        line(
          `agent.batch.started agents=${arrayField(data, 'agentVariantIds').length}` +
          (arrayField(data, 'models').length > 0
            ? ` models=${arrayField(data, 'models').map(String).join(',')}`
            : '') +
          (data.roleKind !== undefined ? ` role=${String(data.roleKind)}` : ''),
        )
        break
      case 'agent.started': {
        const invocationId = String(data.invocationId ?? '')
        const name = String(data.name ?? data.agentVariantId ?? '')
        this.invNames.set(invocationId, name)
        line(
          `agent.started ${name} model=${String(data.model ?? '?')} inv=${shortId(invocationId)}` +
          (data.roleKind !== undefined ? ` role=${String(data.roleKind)}` : '') +
          (data.replacesInvocationId !== undefined && data.replacesInvocationId !== null
            ? ` replaces=${shortId(data.replacesInvocationId)}`
            : ''),
        )
        break
      }
      case 'agent.activity': {
        const invocationId = String(data.invocationId ?? '')
        const name = this.invNames.get(invocationId) ?? shortId(invocationId)
        line(`agent.activity ${name} at=${String(data.receivedAt ?? '?')}`)
        break
      }
      case 'agent.retrying':
        line(
          `agent.retrying ${shortId(data.invocationId)} reason=${preview(data.reason, 120)} ` +
          `nextAttempt=${String(data.nextAttempt ?? '?')}`,
        )
        break
      case 'agent.completed':
        line(
          `agent.completed ${this.invNames.get(String(data.invocationId ?? '')) ?? shortId(data.invocationId)} ` +
          `latency=${String(data.latencyMs ?? '?')}ms body=${String(data.body ?? data.raw ?? '').length}chars`,
        )
        break
      case 'agent.failed':
        line(
          `agent.failed ${this.invNames.get(String(data.invocationId ?? '')) ?? shortId(data.invocationId)} ` +
          `error=${preview(data.error, 200)}`,
        )
        break
      case 'evidence.checked':
        line(`evidence.checked ${shortId(data.invocationId)} report=${preview(data.report, 160)}`)
        break
      case 'tool.called':
        line(`tool.called ${String(data.name ?? '?')} ${scalarFields(data, new Set(['name']))}`)
        break
      case 'tool.failed':
        line(`tool.failed ${String(data.name ?? '?')} error=${preview(data.error, 160)}`)
        break
      case 'team.adjusted':
      case 'team.fallback':
        line(
          `${type} agents=${arrayField(data, 'agentVariantIds').length}` +
          (data.reason !== undefined ? ` reason=${preview(data.reason, 120)}` : ''),
        )
        break
      case 'poetry.plan.started':
      case 'poetry.plan.completed':
      case 'poetry.plan.failed':
        line(`${type} ${shortId(data.invocationId)} ${scalarFields(data, new Set(['invocationId']))}`)
        break
      case 'stage.audit.started':
      case 'stage.audit.completed':
      case 'stage.audit.failed':
        line(
          `${type} stage=${String(data.stage ?? '?')} lens=${String(data.lens ?? '?')} ` +
          `model=${String(data.model ?? '?')}` +
          (data.error !== undefined ? ` error=${preview(data.error, 160)}` : ''),
        )
        break
      case 'stage.started':
      case 'stage.resumed':
        line(`${type} stage=${String(data.stage ?? '?')}`)
        break
      case 'stage.completed':
        line(
          `stage.completed stage=${String(data.stage ?? '?')} endpoint=${String(data.endpointName ?? '?')} ` +
          `model=${String(data.model ?? '?')} body=${String(data.body ?? data.raw ?? '').length}chars`,
        )
        break
      case 'stage.failed':
        line(
          `stage.failed stage=${String(data.stage ?? '?')} error=${preview(data.error, 200)}` +
          (data.diagnosticId !== undefined ? ` diagnostic=${String(data.diagnosticId)}` : ''),
        )
        break
      case 'stage.binding.resolved':
        line(`stage.binding.resolved stage=${String(data.stage ?? '?')} ${scalarFields(data, new Set(['stage']))}`)
        break
      case 'version.created':
        line(
          `version.created v${String(data.versionNo ?? '?')} source=${String(data.source ?? '?')}` +
          (data.reason !== undefined ? ` reason=${preview(data.reason, 120)}` : ''),
        )
        break
      case 'candidates.updated':
        line(
          `candidates.updated ${shortId(data.invocationId)} ` +
          `finalVersionIsStale=${String(data.finalVersionIsStale ?? '?')}`,
        )
        break
      case 'agent.retry.completed':
        line(
          `agent.retry.completed ${shortId(data.invocationId)} ` +
          `replaced=${shortId(data.replacedInvocationId)}`,
        )
        break
      case 'run.pause.requested':
        line('run.pause.requested')
        break
      case 'draft.regeneration.started':
      case 'draft.regenerated':
        line(`${type} ${scalarFields(data)}`)
        break
      case 'session.completed':
        line('session.completed — TERMINAL (success)')
        break
      case 'run.interrupted':
        line(`run.interrupted — TERMINAL error=${preview(data.error, 300)}`)
        break
      case 'run.paused':
        line(`run.paused — TERMINAL checkpoint=${preview(JSON.stringify(data.checkpoint ?? null), 160)}`)
        break
      default: {
        const fields = scalarFields(data)
        line(fields === '' ? type : `${type} ${fields}`)
      }
    }
  }
}

interface RunStreamResult {
  terminal: 'completed' | 'interrupted' | 'paused' | null
  terminalError: string | null
  count: number
  lastEventId: string | null
}

async function attachRunEvents(sessionId: string, after: number | null): Promise<RunStreamResult> {
  const query = after === null ? '' : `?after=${after}`
  const response = await openEventStream('GET', `/api/sessions/${sessionId}/events${query}`)
  const renderer = new RunEventRenderer()
  let terminal: RunStreamResult['terminal'] = null
  let terminalError: string | null = null
  const { count, lastEventId } = await consumeSSE(
    response,
    (event, data) => {
      renderer.handle(event, data)
      if (event.event === 'session.completed') terminal = 'completed'
      else if (event.event === 'run.interrupted') {
        terminal = 'interrupted'
        terminalError = String(data.error ?? '')
      } else if (event.event === 'run.paused') terminal = 'paused'
    },
    { watchdog: true },
  )
  renderer.finish()
  return { terminal, terminalError, count, lastEventId }
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function cmdCreate(args: ParsedArgs): Promise<CommandOutcome> {
  rejectPositionals(args)
  const textArg = requireFlag(args, 'text')
  const direction = requireFlag(args, 'direction')
  if (direction !== 'en_to_zh' && direction !== 'zh_to_en' && direction !== 'custom') {
    fail(`--direction must be en_to_zh|zh_to_en|custom (got: ${direction})`, 1, false)
  }
  const sourceText = textArg.startsWith('@')
    ? readFileSync(path.resolve(textArg.slice(1)), 'utf8')
    : textArg
  if (sourceText.trim() === '') fail('source text is empty', 1, false)
  const sourceLang = args.flags.get('sourceLang')
  const targetLang = args.flags.get('targetLang')
  if (direction === 'custom' && (!sourceLang || !targetLang)) {
    fail('--sourceLang and --targetLang are required when --direction=custom', 1, false)
  }
  const requestId = args.flags.has('request-id')
    ? parseUuid(args.flags.get('request-id') as string, '--request-id')
    : randomUUID()
  const body: JsonObject = {
    clientRequestId: requestId,
    sourceText,
    direction,
  }
  const taskBrief = args.flags.get('taskBrief')
  if (taskBrief !== undefined) body.taskBrief = taskBrief
  if (sourceLang !== undefined) body.sourceLang = sourceLang
  if (targetLang !== undefined) body.targetLang = targetLang

  const res = await httpJson('POST', '/api/sessions', body)
  if (res.status !== 200) {
    fail(`POST /api/sessions → HTTP ${res.status}: ${errorMessage(res)}`)
  }
  const session = asRecord(res.json)
  if (session === null || typeof session.id !== 'string') {
    fail('POST /api/sessions → response did not contain a session id')
  }
  const id = session.id as string
  opts.sessionId = id
  const publicSnapshot = asRecord(session.public_config_snapshot)
  const version = publicSnapshot !== null ? publicSnapshot.version : undefined
  line(`session ${id}`)
  line(`direction=${String(session.direction ?? '?')} state=${String(session.state ?? '?')}`)
  line(
    `public_config_snapshot.version: ${String(version ?? 'unknown')}` +
    (Number(version) === 3 ? ' (vNext → use run)' : ' (legacy → use translate)'),
  )
  return {
    code: 0,
    result: {
      sessionId: id,
      direction: session.direction ?? null,
      state: session.state ?? null,
      snapshotVersion: version ?? null,
    },
  }
}

async function cmdRun(args: ParsedArgs): Promise<CommandOutcome> {
  rejectPositionals(args)
  const sessionId = requireSession(args)
  const configMode = args.flags.get('configMode') ?? 'frozen'
  if (configMode !== 'frozen' && configMode !== 'current') {
    fail(`--configMode must be frozen|current (got: ${configMode})`, 1, false)
  }
  // Frontend sends an empty body for the default frozen mode (zod default);
  // configMode=current must be sent explicitly.
  const res = configMode === 'frozen'
    ? await httpJson('POST', `/api/sessions/${sessionId}/run`)
    : await httpJson('POST', `/api/sessions/${sessionId}/run`, { configMode })
  if (res.status !== 200 && res.status !== 202) {
    fail(`POST /run → HTTP ${res.status}: ${errorMessage(res)}`)
  }
  const payload = asRecord(res.json) ?? {}
  const runId = String(payload.runId ?? '')
  line(
    `run ${runId} — HTTP ${res.status} ` +
    `(${res.status === 200 ? 'reused existing run' : 'new run'}, configMode=${configMode})`,
  )
  const stream = await attachRunEvents(sessionId, null)
  line(`events stream closed after ${stream.count} events (last id ${stream.lastEventId ?? '-'})`)
  if (stream.terminal === 'completed') {
    return { code: 0, result: { runId, terminal: 'completed', events: stream.count } }
  }
  if (stream.terminal === 'paused') {
    line('run paused — stopped by user request')
    return { code: 3, result: { runId, terminal: 'paused', events: stream.count } }
  }
  if (stream.terminal === 'interrupted') {
    fail(`run interrupted: ${stream.terminalError ?? 'unknown error'}`, 1)
  }
  // Anomaly: stream closed without a terminal event — fall back to run statuses.
  line('events stream closed WITHOUT a terminal event — falling back to GET session')
  const detail = await httpJson('GET', `/api/sessions/${sessionId}`)
  if (detail.status === 200) {
    const runs = asRecordArray(asRecord(detail.json)?.runs)
    const counts = new Map<string, number>()
    for (const run of runs) {
      const status = String(run.status ?? 'unknown')
      counts.set(status, (counts.get(status) ?? 0) + 1)
    }
    line(
      `runs: ${[...counts.entries()].map(([status, n]) => `${status}=${n}`).join(' ') || 'none'}`,
    )
  } else {
    line(`fallback GET session failed: HTTP ${detail.status}`)
  }
  fail('events stream closed without terminal event (anomaly)', 1)
}

async function cmdTranslate(args: ParsedArgs): Promise<CommandOutcome> {
  rejectPositionals(args)
  const sessionId = requireSession(args)
  // Legacy v2 path: the POST response body itself is the SSE stream.
  const response = await openEventStream('POST', `/api/sessions/${sessionId}/translate`)
  let sawDone = false
  let sawError: string | null = null
  let fanout: JsonObject | null = null
  const tokenStats = new Map<string, { count: number; chars: number }>()
  const flushTokens = (): void => {
    for (const [agentKey, stat] of tokenStats) {
      line(`token ${agentKey} x${stat.count} (${stat.chars} chars)`)
    }
    tokenStats.clear()
  }
  const { count } = await consumeSSE(
    response,
    (event, data) => {
      switch (event.event) {
        case 'token': {
          const agentKey = String(data.agent_key ?? '?')
          const delta = String(data.delta ?? '')
          const stat = tokenStats.get(agentKey) ?? { count: 0, chars: 0 }
          stat.count += 1
          stat.chars += delta.length
          tokenStats.set(agentKey, stat)
          return
        }
        case 'agent_start':
          flushTokens()
          line(`agent_start ${String(data.agent_key ?? '?')}`)
          return
        case 'agent_complete':
          flushTokens()
          line(
            `agent_complete ${String(data.agent_key ?? '?')} status=${String(data.status ?? '?')} ` +
            `content=${String(data.content ?? '').length}chars`,
          )
          return
        case 'agent_error':
          flushTokens()
          sawError = `${String(data.agent_key ?? '?')}: ${String(data.error ?? '')}`
          line(`agent_error ${sawError}`)
          return
        case 'fanout_complete':
          flushTokens()
          fanout = data
          line(
            `fanout_complete succeeded=${String(data.succeeded ?? '?')} ` +
            `failed=${String(data.failed ?? '?')} duration_ms=${String(data.duration_ms ?? '?')}`,
          )
          return
        case 'done':
          flushTokens()
          sawDone = true
          line('done')
          return
        case 'error':
          flushTokens()
          sawError = String(data.error ?? 'unknown error')
          line(`error ${sawError}`)
          return
        default:
          flushTokens()
          line(`${event.event} ${scalarFields(data)}`)
      }
    },
    { watchdog: true },
  )
  flushTokens()
  line(`translate stream closed after ${count} events`)
  if (sawError !== null) fail(`translate failed: ${sawError}`, 1)
  if (!sawDone) fail('translate stream closed without done event', 1)
  if (fanout === null) fail('translate stream closed without fanout_complete event', 1)
  const fanoutFailed = Number(fanout.failed ?? 0)
  if (fanoutFailed !== 0) fail(`fanout_complete reported failed=${fanoutFailed}`, 1)
  return { code: 0, result: { done: true, fanout, events: count } }
}

async function cmdEvents(args: ParsedArgs): Promise<CommandOutcome> {
  rejectPositionals(args)
  const sessionId = requireSession(args)
  const afterRaw = args.flags.get('after')
  let after: number | null = null
  if (afterRaw !== undefined) {
    after = Number(afterRaw)
    if (!Number.isInteger(after) || after < 0) {
      fail(`--after must be a non-negative integer event id (got: ${afterRaw})`, 1, false)
    }
  }
  const stream = await attachRunEvents(sessionId, after)
  line(
    `events stream closed after ${stream.count} events ` +
    `(last id ${stream.lastEventId ?? '-'}, terminal: ${stream.terminal ?? 'none'})`,
  )
  return {
    code: 0,
    result: { events: stream.count, terminal: stream.terminal, lastEventId: stream.lastEventId },
  }
}

async function cmdChat(args: ParsedArgs): Promise<CommandOutcome> {
  rejectPositionals(args)
  const sessionId = requireSession(args)
  const message = requireFlag(args, 'message')

  // Cross-process activity probe first (GET /chat → ChatActivitySnapshot).
  const activity = await httpJson('GET', `/api/sessions/${sessionId}/chat`)
  if (activity.status !== 200) {
    fail(`GET /chat → HTTP ${activity.status}: ${errorMessage(activity)}`)
  }
  const snapshot = asRecord(activity.json) ?? {}
  if (snapshot.active === true) {
    line(
      `another chat turn is already running on this session ` +
      `(phase=${String(snapshot.phase ?? '?')}, lastHeartbeatAt=${String(snapshot.lastHeartbeatAt ?? '?')})`,
    )
    return {
      code: 2,
      result: {
        active: true,
        phase: snapshot.phase ?? null,
        lastHeartbeatAt: snapshot.lastHeartbeatAt ?? null,
      },
    }
  }

  // Manual fetch so 409 chat_already_running can be mapped to exit 2.
  const url = `${opts.base}/api/sessions/${sessionId}/chat`
  const started = performance.now()
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  })
  const ms = Math.round(performance.now() - started)
  traceRecord('http', { method: 'POST', url, status: response.status, ms, stream: true })
  if (response.status === 409) {
    const errBody = asRecord(parseBody(await response.text()))
    if (errBody !== null && errBody.error === 'chat_already_running') {
      line('another chat turn started between probe and POST (409 chat_already_running)')
      return { code: 2, result: { active: true, via: 'post-409' } }
    }
    fail(`POST /chat → HTTP 409: ${errorMessage({ status: 409, text: '', json: errBody })}`)
  }
  if (!response.ok) {
    const text = await response.text()
    fail(`POST /chat → HTTP ${response.status}: ${errorMessage({ status: response.status, text, json: parseBody(text) })}`)
  }
  if (response.body === null) fail('POST /chat → response has no body')

  let phase = 'waiting_for_model'
  let sawDone = false
  let sawError: string | null = null
  let completionKind: string | null = null
  let completionDiff: string | null = null
  let finalVersionNo: number | null = null
  let deltaChars = 0
  let inDelta = false
  const deltaWrite = (text: string): void => {
    inDelta = true
    deltaChars += text.length
    if (opts.json) process.stderr.write(text)
    else process.stdout.write(text)
  }
  const endDelta = (): void => {
    if (!inDelta) return
    if (opts.json) process.stderr.write('\n')
    else process.stdout.write('\n')
    inDelta = false
  }
  const cline = (text: string): void => {
    endDelta()
    line(text)
  }

  const { count } = await consumeSSE(
    response,
    (event, data) => {
      switch (event.event) {
        case 'message_start':
          // Traced but not rendered (frontend ignores it too).
          return
        case 'heartbeat':
          cline(
            `alive (elapsed ${Math.round((performance.now() - t0) / 1000)}s, phase=${phase})`,
          )
          return
        case 'activity':
          if (data.phase === 'thinking') {
            phase = 'thinking'
            cline('phase → thinking')
          }
          return
        case 'delta': {
          const text = String(data.text ?? '')
          if (text !== '' && (phase === 'waiting_for_model' || phase === 'thinking')) {
            phase = 'generating'
          }
          deltaWrite(text)
          return
        }
        case 'tool_call':
          phase = 'applying_edits'
          cline(
            `tool_call ${String(data.name ?? '?')} ` +
            `old_string="${preview(asRecord(data.arguments)?.old_string, 80)}" ` +
            `new_string="${preview(asRecord(data.arguments)?.new_string, 80)}"`,
          )
          return
        case 'tool_result':
          if (data.version_no !== undefined && data.version_no !== null) {
            finalVersionNo = Number(data.version_no)
            cline(`tool_result ok version_no=${String(data.version_no)} (persisted)`)
          } else if (data.ok === true) {
            cline(`tool_result ok diff_summary=${preview(data.diff_summary, 120)}`)
          } else {
            cline('tool_result FAILED (batch rolled back)')
          }
          return
        case 'patch.applied':
          cline(`patch.applied ${String(data.patch_id ?? '?')} → v${String(data.version_no ?? '?')}`)
          return
        case 'message_complete':
          if (data.error !== undefined && data.error !== null) {
            sawError = `${String(data.error)}: ${String(data.message ?? '')}`
            cline(`message_complete ERROR ${sawError}`)
          } else {
            completionKind = String(data.kind ?? 'unknown')
            completionDiff = data.diff_summary !== undefined ? String(data.diff_summary) : null
            cline(
              `message_complete kind=${completionKind}` +
              (completionDiff !== null ? ` diff_summary=${preview(completionDiff, 160)}` : ''),
            )
          }
          return
        case 'done':
          sawDone = true
          cline('done')
          return
        default:
          cline(`${event.event} ${scalarFields(data)}`)
      }
    },
    { watchdog: false }, // chat stream has real 15s heartbeats
  )
  endDelta()
  line(`chat stream closed after ${count} events (${deltaChars} delta chars)`)
  if (sawError !== null) fail(`chat failed: ${sawError}`, 1)
  if (!sawDone) fail('chat stream closed without done event', 1)
  if (completionKind === null) fail('chat stream closed without message_complete event', 1)
  return {
    code: 0,
    result: {
      done: true,
      kind: completionKind,
      diffSummary: completionDiff,
      versionNo: finalVersionNo,
      deltaChars,
    },
  }
}

async function cmdSuggest(args: ParsedArgs): Promise<CommandOutcome> {
  rejectPositionals(args)
  const sessionId = requireSession(args)
  const message = requireFlag(args, 'message')
  const res = await httpJson('POST', `/api/sessions/${sessionId}/revision-suggestions`, { message })
  if (res.status !== 200) {
    const body = asRecord(res.json)
    const code = body !== null ? String(body.error ?? '') : ''
    let hint: string
    if (res.status === 409 && code === 'final_version_required') {
      hint = '先运行管线产生正式版本 (run the pipeline first to produce a final version)'
    } else if (res.status === 400 && code === 'no_chat_config') {
      hint = '会话快照缺少对话模型配置 (session snapshot has no chat model configured)'
    } else if (res.status === 502 && code === 'suggestion_failed') {
      const upstream = body !== null ? String(body.message ?? '') : ''
      hint = `${upstream} — 上游错误，可安全重试（只读操作）(upstream error; safe to retry, read-only)`
    } else {
      hint = errorMessage(res)
    }
    fail(`suggest failed (HTTP ${res.status}): ${hint}`)
  }
  const result = asRecord(res.json) ?? {}
  const feedback = String(result.feedback ?? '')
  const targetReaderReport = String(result.targetReaderReport ?? '')
  const bilingualReport = String(result.bilingualReport ?? '')
  line('=== feedback ===')
  for (const row of feedback.split('\n')) line(row)
  line('=== targetReaderReport ===')
  for (const row of targetReaderReport.split('\n')) line(row)
  line('=== bilingualReport ===')
  for (const row of bilingualReport.split('\n')) line(row)
  if (feedback.trim() === '') fail('suggest returned an empty feedback field')
  return { code: 0, result: { feedback, targetReaderReport, bilingualReport } }
}

async function cmdState(args: ParsedArgs): Promise<CommandOutcome> {
  rejectPositionals(args)
  const sessionId = requireSession(args)
  const res = await httpJson('GET', `/api/sessions/${sessionId}`)
  if (res.status !== 200) {
    fail(`GET /api/sessions/${sessionId} → HTTP ${res.status}: ${errorMessage(res)}`)
  }
  const payload = asRecord(res.json)
  if (payload === null) fail('GET session → non-object JSON response')
  const session = asRecord(payload.session) ?? {}
  if (args.booleans.has('full')) {
    const full = JSON.stringify(payload, null, 2)
    if (opts.json) process.stderr.write(`${full}\n`)
    else process.stdout.write(`${full}\n`)
    return { code: 0, result: payload }
  }
  const versions = asRecordArray(payload.versions)
  const patches = asRecordArray(payload.patches)
  const runs = asRecordArray(payload.runs)
  const messages = asRecordArray(payload.messages)
  const publicSnapshot = asRecord(session.public_config_snapshot)
  line(`session ${sessionId}`)
  line(
    `state=${String(session.state ?? '?')} direction=${String(session.direction ?? '?')} ` +
    `langs=${String(session.source_lang ?? '?')}→${String(session.target_lang ?? '?')}`,
  )
  line(
    `created=${String(session.created_at ?? '?')} updated=${String(session.updated_at ?? '?')} ` +
    `snapshot.version=${String(publicSnapshot?.version ?? 'unknown')} ` +
    `latest_version_no=${String(payload.latest_version_no ?? '-')}`,
  )
  line(`versions (${versions.length}):`)
  for (const version of versions) {
    line(
      `  v${String(version.version_no ?? '?')} ${String(version.source ?? '?')} ` +
      `${String(version.created_at ?? '?')} ${String(version.text ?? '').length} chars`,
    )
  }
  const runCounts = new Map<string, number>()
  for (const run of runs) {
    const status = String(run.status ?? 'unknown')
    runCounts.set(status, (runCounts.get(status) ?? 0) + 1)
  }
  line(`patches: ${patches.length}`)
  line(`runs (${runs.length}): ${[...runCounts.entries()].map(([s, n]) => `${s}=${n}`).join(' ') || 'none'}`)
  line(`messages: ${messages.length}`)
  const evidence = asRecord(payload.final_evidence)
  if (evidence !== null) {
    line(`final_evidence: ${String(evidence.summary ?? '(no summary)')}`)
    const issueKeys = [
      'requiredTermsMissing',
      'forbiddenTermsFound',
      'numberWarnings',
      'structureWarnings',
      'punctuationWarnings',
      'rhymeWarnings',
      'boundaryWarnings',
    ]
    line(
      `  issues: ${issueKeys
        .map((key) => `${key}=${Array.isArray(evidence[key]) ? (evidence[key] as unknown[]).length : 0}`)
        .join(' ')}`,
    )
    if (typeof evidence.caveat === 'string' && evidence.caveat !== '') {
      line(`  caveat: ${truncate(evidence.caveat, 200)}`)
    }
  } else {
    line('final_evidence: none (no final version yet)')
  }
  return {
    code: 0,
    result: {
      sessionId,
      state: session.state ?? null,
      direction: session.direction ?? null,
      latestVersionNo: payload.latest_version_no ?? null,
      versions: versions.length,
      patches: patches.length,
      runs: Object.fromEntries(runCounts),
      messages: messages.length,
      finalEvidence: evidence,
      snapshotVersion: publicSnapshot?.version ?? null,
    },
  }
}

async function cmdList(args: ParsedArgs): Promise<CommandOutcome> {
  rejectPositionals(args)
  const params = new URLSearchParams()
  const direction = args.flags.get('direction')
  if (direction !== undefined) {
    if (direction !== 'en_to_zh' && direction !== 'zh_to_en' && direction !== 'custom') {
      fail(`--direction must be en_to_zh|zh_to_en|custom (got: ${direction})`, 1, false)
    }
    params.set('direction', direction)
  }
  const limitRaw = args.flags.get('limit')
  if (limitRaw !== undefined) params.set('limit', String(parsePositiveInt(limitRaw, '--limit')))
  const query = params.size > 0 ? `?${params.toString()}` : ''
  const res = await httpJson('GET', `/api/sessions${query}`)
  if (res.status !== 200) {
    fail(`GET /api/sessions → HTTP ${res.status}: ${errorMessage(res)}`)
  }
  const payload = asRecord(res.json) ?? {}
  const sessions = asRecordArray(payload.sessions)
  line(`sessions total=${String(payload.total ?? '?')} (showing ${sessions.length})`)
  for (const session of sessions) {
    const latest = asRecord(session.latest_version)
    const models = Array.isArray(session.models) ? session.models.map(String) : []
    line(
      `${String(session.id ?? '?')}  ${String(session.direction ?? '?')}  ` +
      `${String(session.state ?? '?')}  ${String(session.created_at ?? '?')}  ` +
      `latest=${latest !== null ? String(latest.source ?? '-') : '-'}  ` +
      `models=${models.length > 0 ? models.join(',') : '-'}`,
    )
  }
  return { code: 0, result: { total: payload.total ?? null, sessions } }
}

async function cmdRm(args: ParsedArgs): Promise<CommandOutcome> {
  rejectPositionals(args)
  const sessionId = requireSession(args)
  if (!args.booleans.has('yes')) {
    line(`refusing to delete session ${sessionId}: pass --yes to confirm`)
    return { code: 1, result: { deleted: false, reason: 'missing --yes' } }
  }
  const res = await httpJson('DELETE', `/api/sessions/${sessionId}`)
  if (res.status !== 204) {
    fail(`DELETE /api/sessions/${sessionId} → HTTP ${res.status}: ${errorMessage(res)}`)
  }
  line(`deleted ${sessionId} (204)`)
  return { code: 0, result: { deleted: true, sessionId } }
}

async function cmdRestore(args: ParsedArgs): Promise<CommandOutcome> {
  rejectPositionals(args)
  const sessionId = requireSession(args)
  const versionNo = parsePositiveInt(requireFlag(args, 'version'), '--version')
  // Empty body, exactly like the frontend restore button.
  const res = await httpJson(
    'POST',
    `/api/sessions/${sessionId}/versions/${versionNo}/restore`,
  )
  if (res.status !== 200) {
    fail(`POST restore → HTTP ${res.status}: ${errorMessage(res)}`)
  }
  const row = asRecord(res.json) ?? {}
  line(
    `restored → v${String(row.version_no ?? '?')} source=${String(row.source ?? '?')} ` +
    `created=${String(row.created_at ?? '?')} text=${String(row.text ?? '').length} chars`,
  )
  return { code: 0, result: row }
}

// ---------------------------------------------------------------------------
// Usage & dispatch
// ---------------------------------------------------------------------------

const USAGE = `dev-harness — CLI driver for the Agentic Translating HTTP+SSE API (Phase 1+2)

Usage:
  node --experimental-strip-types scripts/dev-harness.mts <command> [flags]

Global flags:
  --base=URL        API base (default AGENTIC_BASE_URL, then http://127.0.0.1:3001)
  --timeout=MS      per-HTTP-request timeout via AbortController (default 600000);
                    does NOT cap overall SSE consumption (streams may run 2-10 min)
  --watchdog=MS     warn when the run/events stream is silent this long
                    (default 300000; warning only, never aborts)
  --trace           append JSONL trace to FSBP_Test/private/debug/<session|misc>-<cmd>-<ts>.jsonl
  --json            machine-readable final result on stdout (human log → stderr)
  --help            show this help

Commands:
  create     --text=@path|literal --direction=en_to_zh|zh_to_en|custom
             [--taskBrief=] [--sourceLang= --targetLang=] [--request-id=UUID]
             Create a session. Reuse --request-id to make retries idempotent.
  run        --session=ID [--configMode=frozen|current]
             POST /run (empty body) then consume GET /events incrementally.
             Exit: 0=session.completed, 1=run.interrupted/anomaly, 3=run.paused.
  translate  --session=ID
             Legacy v2 path: POST /translate; the response body IS the SSE stream.
             Exit 0 iff done received and fanout_complete.failed===0.
  events     --session=ID [--after=N]
             Attach-only observation of the events stream (same rendering as run).
  chat       --session=ID --message=TEXT
             One chat revision turn. Exit 2 when another chat is already active.
  suggest    --session=ID --message=TEXT
             Revision suggestion (three isolated lenses; read-only, safe to retry).
  state      --session=ID [--full]
             Summary: state/direction/versions/patches/runs/messages/final_evidence.
             --full prints the complete raw JSON.
  list       [--direction=en_to_zh|zh_to_en|custom] [--limit=N]
             List sessions: id, direction, state, created_at, latest version, models.
  rm         --session=ID --yes
             Delete a session (204). Refuses without --yes.
  restore    --session=ID --version=N
             POST versions/N/restore (empty body); prints the new version row.

Exit codes: 0 success · 1 failure (failure dump written to FSBP_Test/private/debug/)
            2 chat already active · 3 run paused
`

const COMMANDS: Record<string, (args: ParsedArgs) => Promise<CommandOutcome>> = {
  create: cmdCreate,
  run: cmdRun,
  translate: cmdTranslate,
  events: cmdEvents,
  chat: cmdChat,
  suggest: cmdSuggest,
  state: cmdState,
  list: cmdList,
  rm: cmdRm,
  restore: cmdRestore,
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const command = argv[0]

  if (command === '--help' || command === '-h') {
    process.stdout.write(USAGE)
    return 0
  }
  if (command === undefined) {
    process.stderr.write(USAGE)
    return 1
  }
  const handler = COMMANDS[command]
  if (handler === undefined) {
    process.stderr.write(`error: unknown command '${command}'\n\n${USAGE}`)
    return 1
  }

  const args = parseArgs(argv.slice(1))
  if (args.booleans.has('help') || args.booleans.has('h')) {
    process.stdout.write(USAGE)
    return 0
  }

  opts.command = command
  opts.base = (args.flags.get('base') ?? opts.base).replace(/\/+$/, '')
  opts.trace = args.booleans.has('trace')
  opts.json = args.booleans.has('json')
  if (args.flags.has('timeout')) {
    opts.timeoutMs = parsePositiveInt(args.flags.get('timeout') as string, '--timeout')
  }
  if (args.flags.has('watchdog')) {
    opts.watchdogMs = parsePositiveInt(args.flags.get('watchdog') as string, '--watchdog')
  }
  if (args.flags.has('session')) {
    opts.sessionId = args.flags.get('session') as string
  }

  try {
    const outcome = await handler(args)
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ command, exitCode: outcome.code, result: outcome.result }, null, 2)}\n`,
      )
    }
    return outcome.code
  } catch (error) {
    const isHarnessError = error instanceof HarnessError
    const exitCode = isHarnessError ? error.exitCode : 1
    const wantsDump = isHarnessError ? error.dump : true
    process.stderr.write(
      `error: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    if (wantsDump) {
      const dumpPath = await writeFailureDump(error)
      if (dumpPath !== null) process.stderr.write(`failure dump: ${dumpPath}\n`)
    }
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            command,
            exitCode,
            error: error instanceof Error ? error.message : String(error),
          },
          null,
          2,
        )}\n`,
      )
    }
    return exitCode
  }
}

process.exitCode = await main()
