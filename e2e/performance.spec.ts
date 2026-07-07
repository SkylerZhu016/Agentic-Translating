// ---------------------------------------------------------------------------
// E2E: performance.spec.ts
//
// Covers:
//   AC24 — 基线性能（performance baseline）
//     - 6 agents × 10ms/token delay mock → fanout completes in < 5 seconds
//     - four stages (review/filter/orchestrate/assemble) under 10 seconds total
//
// Strategy:
//   Uses the API directly (APIRequestContext + SSE consumption) rather than
//   the UI, so timings reflect server-side orchestration rather than browser
//   rendering overhead. The shared mock is configured with `stream` behavior
//   and a 10ms chunkDelayMs for agents, and `json_content` for stages (each
//   stage is a single non-streaming LLM round-trip).
//
//   The fanout_complete SSE event carries a server-reported duration_ms which
//   we assert against; we also wall-clock the operation as a cross-check.
//   For stages, we sum the wall-clock durations of the four sequential
//   stage_run SSE calls.
// ---------------------------------------------------------------------------

import { test, expect, type APIRequestContext } from '@playwright/test'
import {
  resetDb,
  resetMockBehavior,
  setMockBehavior,
  collectSSEEvents,
  sseEventNames,
  sseData,
  buildReviewOutput,
  buildFilterOutput,
  buildOrchestrateOutput,
  buildAssembleOutput,
} from './helpers'

const MOCK_URL = process.env.E2E_MOCK_LLM_URL ?? 'http://localhost:41099'
const SOURCE_TEXT = 'The quick brown fox jumps over the lazy dog. ' +
  'Pack my box with five dozen liquor jugs. ' +
  'How vexingly quick daft zebras jump.'
const COORD_MODEL = 'gpt-4o-coordinator'
const NUM_AGENTS = 6

test.beforeEach(async ({ request }) => {
  await resetDb(request)
  await resetMockBehavior(request)
})

/** Seed endpoint + N agents + coordinator. */
async function seedConfig(request: APIRequestContext): Promise<{ sessionId: string }> {
  const epRes = await request.post('/api/endpoints', {
    data: { name: 'Mock', base_url: MOCK_URL, api_key: 'sk-mock' },
  })
  expect(epRes.status()).toBe(201)
  const ep = await epRes.json()
  for (let i = 0; i < NUM_AGENTS; i++) {
    await request.post('/api/agents', {
      data: {
        name: `Agent ${i + 1}`,
        endpoint_id: ep.id,
        model: `agent-model-${i + 1}`,
        prompt_override: null,
        sort_order: i,
      },
    })
  }
  const coRes = await request.put('/api/coordinator', {
    data: { endpoint_id: ep.id, model: COORD_MODEL },
  })
  expect(coRes.status()).toBe(200)

  // Create a session
  const sessRes = await request.post('/api/sessions', {
    data: { sourceText: SOURCE_TEXT },
  })
  expect(sessRes.status()).toBe(200)
  const session = await sessRes.json()
  return { sessionId: session.id }
}

/** Run translation fanout via SSE and return the fanout_complete payload. */
async function runFanout(
  request: APIRequestContext,
  sessionId: string,
): Promise<{ succeeded: number; failed: number; durationMs: number; wallMs: number }> {
  const wallStart = Date.now()
  const res = await request.post(`/api/sessions/${sessionId}/translate`, {
    headers: { Accept: 'text/event-stream' },
    timeout: 60_000,
  })
  expect(res.status()).toBe(200)
  const events = await collectSSEEvents(res)
  const wallMs = Date.now() - wallStart

  const names = sseEventNames(events)
  expect(names).toContain('fanout_complete')
  expect(names[names.length - 1]).toBe('done')

  const payload = sseData<{ succeeded: number; failed: number; duration_ms: number }>(
    events,
    'fanout_complete',
  )
  expect(payload).not.toBeNull()
  return {
    succeeded: payload!.succeeded,
    failed: payload!.failed,
    durationMs: payload!.duration_ms,
    wallMs,
  }
}

/** Run a single stage via SSE and return wall-clock duration in ms. */
async function runStage(
  request: APIRequestContext,
  sessionId: string,
  stage: 'review' | 'filter' | 'orchestrate' | 'assemble',
): Promise<number> {
  const wallStart = Date.now()
  const res = await request.post(
    `/api/sessions/${sessionId}/stages/${stage}/run`,
    { headers: { Accept: 'text/event-stream' }, timeout: 60_000 },
  )
  expect(res.status()).toBe(200)
  const events = await collectSSEEvents(res)
  const wallMs = Date.now() - wallStart
  const names = sseEventNames(events)
  expect(names).toContain('stage_complete')
  expect(names[names.length - 1]).toBe('done')
  return wallMs
}

test.describe('AC24 — performance baseline', () => {
  test('6 agents × 10ms/token → fanout < 5s', async ({ request }) => {
    // Configure all 6 agent models to stream with 10ms chunk delay
    for (let i = 1; i <= NUM_AGENTS; i++) {
      await setMockBehavior(request, {
        behavior: 'stream',
        model: `agent-model-${i}`,
        delayMs: 10,
      })
    }

    const { sessionId } = await seedConfig(request)
    const result = await runFanout(request, sessionId)

    expect(result.failed).toBe(0)
    expect(result.succeeded).toBe(NUM_AGENTS)

    // Assert both server-reported duration and wall-clock are under 5s
    expect(result.durationMs, `server duration_ms ${result.durationMs}ms`).toBeLessThan(5000)
    expect(result.wallMs, `wall-clock ${result.wallMs}ms`).toBeLessThan(5000)

    // eslint-disable-next-line no-console
    console.log(
      `[AC24 fanout] server=${result.durationMs}ms wall=${result.wallMs}ms ` +
        `succeeded=${result.succeeded} failed=${result.failed}`,
    )
  })

  test('four stages total < 10s', async ({ request }) => {
    const agentNames = Array.from({ length: NUM_AGENTS }, (_, i) => `Agent ${i + 1}`)
    const { sessionId } = await seedConfig(request)

    // First run the translation fanout so the session is in "translated" state
    for (let i = 1; i <= NUM_AGENTS; i++) {
      await setMockBehavior(request, {
        behavior: 'stream',
        model: `agent-model-${i}`,
        delayMs: 10,
      })
    }
    await runFanout(request, sessionId)

    // Configure the coordinator model to return C2-schema JSON for each stage
    const stagePayloads: Record<string, string> = {
      review: buildReviewOutput(agentNames),
      filter: buildFilterOutput(agentNames.slice(0, 3), agentNames.slice(3)),
      orchestrate: buildOrchestrateOutput([
        { segment_index: 0, source_agent_id: agentNames[0], source_segment: 'seg one', rationale: 'r1' },
        { segment_index: 1, source_agent_id: agentNames[1], source_segment: 'seg two', rationale: 'r2' },
      ]),
      assemble: buildAssembleOutput('春风又绿江南岸，明月何时照我还。', 'assembled'),
    }

    const stages = ['review', 'filter', 'orchestrate', 'assemble'] as const
    const wallStart = Date.now()
    const durations: Record<string, number> = {}
    for (const stage of stages) {
      await setMockBehavior(request, {
        behavior: 'json_content',
        model: COORD_MODEL,
        jsonContent: stagePayloads[stage],
      })
      durations[stage] = await runStage(request, sessionId, stage)
    }
    const totalWallMs = Date.now() - wallStart

    expect(totalWallMs, `four stages total ${totalWallMs}ms`).toBeLessThan(10_000)

    // eslint-disable-next-line no-console
    console.log(
      `[AC24 stages] ` +
        stages.map((s) => `${s}=${durations[s]}ms`).join(' ') +
        ` total=${totalWallMs}ms`,
    )
  })
})
