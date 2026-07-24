// ---------------------------------------------------------------------------
// E2E helpers — shared by all specs
//
// Provides:
//   - testid selector shortcuts (single source of truth for data-testid strings)
//   - mock LLM control client (POST /__control to dynamically switch behavior)
//   - DB reset helper (POST /api/test-only/reset-db)
//   - evidence screenshot helper (saves to .omo/evidence/e2e/)
//   - SSE event collector (for direct API SSE consumption tests)
//   - C2 schema-compliant mock JSON payloads for stage outputs
// ---------------------------------------------------------------------------

import { expect, type Page, type APIRequestContext, type Locator } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import type { MockBehavior } from '../test/fixtures/mock-llm'

export const E2E_DATA_DIR = path.join(process.cwd(), '.omo', 'e2e-data')

// ---- Mock LLM control -----------------------------------------------------

const MOCK_URL = process.env.E2E_MOCK_LLM_URL ?? 'http://localhost:41099'

export interface ControlOptions {
  behavior: MockBehavior
  model?: string
  delayMs?: number
  status?: number
  jsonContent?: string
  errorMessage?: string
  errorType?: string
  errorCode?: string
  stream?: boolean
  echoChars?: number
}

/**
 * Send a control request to the mock LLM's /__control channel.
 * Use this inside specs to dynamically switch behavior without restarting
 * the server. `model` omitted → catch-all slot ('*').
 */
export async function setMockBehavior(
  api: APIRequestContext,
  opts: ControlOptions,
): Promise<void> {
  const res = await api.post(`${MOCK_URL}/__control`, { data: opts })
  expect(res.status(), `mock /__control ${JSON.stringify(opts)}`).toBe(204)
}

/** Convenience: reset the catch-all slot to a benign echo behavior. */
export async function resetMockBehavior(api: APIRequestContext): Promise<void> {
  await setMockBehavior(api, { behavior: 'echo' })
}

// ---- DB reset -------------------------------------------------------------

/**
 * Reset the application SQLite DB to a clean baseline via the test-only
 * /api/test-only/reset-db endpoint. Call this at the start of each spec
 * (beforeEach) so specs are isolated.
 */
export async function resetDb(api: APIRequestContext): Promise<void> {
  const res = await api.post('/api/test-only/reset-db')
  expect(res.status(), 'POST /api/test-only/reset-db should be 200').toBe(200)
  const body = await res.json()
  expect(body.success).toBe(true)
}

// ---- Testid selectors -----------------------------------------------------

/**
 * Build a `[data-testid="X"]` selector string. Centralized so spec diffs
 * stay small if testids change.
 */
export function tid(id: string): string {
  return `[data-testid="${id}"]`
}

/** Locator shortcut for a testid within a scope. */
export function byTid(page: Page | Locator, id: string): Locator {
  return page.locator(tid(id))
}

// ---- Evidence capture -----------------------------------------------------

const EVIDENCE_DIR = path.join(process.cwd(), '.omo', 'evidence', 'e2e')

/**
 * Save a screenshot as E2E evidence. The filename is derived from the spec
 * name + step label. Stored under .omo/evidence/e2e/ (gitignored).
 */
export async function evidenceScreenshot(
  page: Page,
  label: string,
): Promise<string> {
  if (!fs.existsSync(EVIDENCE_DIR)) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(EVIDENCE_DIR, `${stamp}-${label}.png`)
  await page.screenshot({ path: file, fullPage: true })
  return file
}

// ---- SSE event collection (for direct API SSE tests) ---------------------

export interface SSEEvent {
  event: string
  data: string
}

/**
 * Parse SSE events from a raw string buffer (the full response body).
 * Each event block is separated by a blank line; `event:` and `data:` lines
 * are extracted. Use this when the response has been fully buffered (e.g.
 * Playwright's APIResponse.body() returns a Promise<Buffer>).
 */
export function parseSSEBuffer(text: string): SSEEvent[] {
  const events: SSEEvent[] = []
  const blocks = text.split('\n\n')
  for (const block of blocks) {
    flushBlock(block, events)
  }
  return events
}

/**
 * Consume an SSE response body and return parsed events. Accepts either a
 * Web ReadableStream (with getReader), a Node stream (on('data')), or an
 * object with a `body(): Promise<Buffer>` method (Playwright APIResponse).
 */
export async function collectSSEEvents(
  res: {
    body: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null
  } | {
    body: () => Promise<Buffer>
  },
): Promise<SSEEvent[]> {
  // Playwright APIResponse shape: body() is a method returning Promise<Buffer>
  if (typeof (res as { body?: unknown }).body === 'function') {
    const buf = await (res as { body: () => Promise<Buffer> }).body()
    return parseSSEBuffer(buf.toString('utf-8'))
  }

  const bodyVal = (res as { body: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null }).body
  const events: SSEEvent[] = []
  if (!bodyVal) return events

  const reader = (bodyVal as ReadableStream<Uint8Array>).getReader?.()
    ? (bodyVal as ReadableStream<Uint8Array>).getReader()
    : null

  let buffer = ''
  if (reader) {
    // Web ReadableStream path
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += new TextDecoder().decode(value)
      buffer = drainBuffer(buffer, events)
    }
  } else {
    // Node stream path
    const nodeStream = bodyVal as NodeJS.ReadableStream
    await new Promise<void>((resolve) => {
      nodeStream.on('data', (chunk: Buffer | string) => {
        buffer += chunk.toString('utf-8')
        buffer = drainBuffer(buffer, events)
      })
      nodeStream.on('end', () => {
        // Flush any trailing block
        flushBlock(buffer, events)
        buffer = ''
        resolve()
      })
      nodeStream.on('error', () => resolve())
    })
  }
  flushBlock(buffer, events)
  return events
}

function drainBuffer(buffer: string, events: SSEEvent[]): string {
  const idx = buffer.indexOf('\n\n')
  if (idx === -1) return buffer
  const block = buffer.slice(0, idx)
  parseBlock(block, events)
  return buffer.slice(idx + 2)
}

function flushBlock(buffer: string, events: SSEEvent[]): void {
  if (buffer.trim().length > 0) parseBlock(buffer, events)
}

function parseBlock(block: string, events: SSEEvent[]): void {
  let event = 'message'
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  if (dataLines.length > 0 || event !== 'message') {
    events.push({ event, data: dataLines.join('\n') })
  }
}

/** Get event names in order — convenient for asserting SSE sequences. */
export function sseEventNames(events: SSEEvent[]): string[] {
  return events.map((e) => e.event)
}

/** Find the first event with a given name and parse its data as JSON. */
export function sseData<T = unknown>(events: SSEEvent[], name: string): T | null {
  const ev = events.find((e) => e.event === name)
  if (!ev) return null
  try {
    return JSON.parse(ev.data) as T
  } catch {
    return null
  }
}

// ---- FSBP free-text stage payloads ----------------------------------------
// The mock fixture calls the response field `jsonContent`, but that field is
// simply message.content. Product stage output remains free text.

export function buildReviewOutput(agentNames: string[]): string {
  return [
    '审查意见',
    ...agentNames.map(
      (name, index) =>
        `${index + 1}. ${name}：用词准确、节奏得当；部分衔接可进一步打磨。`,
    ),
  ].join('\n')
}

export function buildFilterOutput(
  selected: string[],
  rejected: string[],
): string {
  return `保留：${selected.join('、')}。这些候选风格互补。\n淘汰：${
    rejected.join('、') || '无'
  }。`
}

export function buildOrchestrateOutput(
  assignments: Array<{
    segment_index: number
    source_agent_id: string
    source_segment: string
    rationale: string
  }>,
  notes = '按意群编排',
): string {
  return [
    `总体方案：${notes}`,
    ...assignments.map(
      (item) =>
        `第 ${item.segment_index + 1} 段采用 ${item.source_agent_id} 的“${
          item.source_segment
        }”：${item.rationale}`,
    ),
  ].join('\n')
}

export function buildAssembleOutput(finalText: string, notes = ''): string {
  return notes ? `${finalText}\n---\n${notes}` : finalText
}

// Backwards-compatible defaults using agent names "Agent 1" / "Agent 2" /
// "Agent 3" (the auto-generated names from AgentPanel). Specs that create
// agents with custom names should use the build* functions instead.
export const MOCK_REVIEW_OUTPUT = buildReviewOutput(['Agent 1', 'Agent 2', 'Agent 3'])
export const MOCK_FILTER_OUTPUT = buildFilterOutput(['Agent 1', 'Agent 2'], ['Agent 3'])
export const MOCK_ORCHESTRATE_OUTPUT = buildOrchestrateOutput([
  { segment_index: 0, source_agent_id: 'Agent 1', source_segment: '春风又绿江南岸', rationale: '首句取 Agent 1' },
  { segment_index: 1, source_agent_id: 'Agent 2', source_segment: '明月何时照我还', rationale: '尾句取 Agent 2' },
])
export const MOCK_ASSEMBLE_OUTPUT = buildAssembleOutput(
  '春风又绿江南岸，明月何时照我还。',
  '拼接两段译稿。',
)
