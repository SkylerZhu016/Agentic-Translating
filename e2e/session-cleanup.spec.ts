// ---------------------------------------------------------------------------
// E2E: session-cleanup.spec.ts
//
// Covers:
//   - Run full pipeline → delete session → verify txt directory cleaned
//
// Strategy:
//   API-SSE-driven (like pipeline.spec.ts tests 2/3 and performance.spec.ts)
//   for precise, fast setup. After running the full pipeline (translate +
//   four stages), we verify the txt directory exists with files, then DELETE
//   the session via API and verify the directory is removed.
//
// The DELETE /api/sessions/[id] handler calls:
//   1. deleteRunArtifacts(id) — fs.rmSync(dir, { recursive: true, force: true })
//   2. repos.sessions.delete(id) — DB row deletion (cascades to children)
//
// Txt artifacts live at data/runs/<sessionId>/<kind>.txt and are verified
// directly from the test process via Node `fs` (the Playwright test process
// shares the server's working directory).
//
// All LLM calls are mocked via the shared mock LLM server (port 41099).
// ---------------------------------------------------------------------------

import { test, expect, type APIRequestContext } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import {
  resetDb,
  resetMockBehavior,
  setMockBehavior,
  buildReviewOutput,
  buildFilterOutput,
  buildOrchestrateOutput,
  collectSSEEvents,
  sseEventNames,
  sseData,
} from './helpers'

const MOCK_URL = process.env.E2E_MOCK_LLM_URL ?? 'http://localhost:41099'
const SOURCE_TEXT = 'The quick brown fox jumps over the lazy dog.'
const AGENT_NAMES = ['Agent 1', 'Agent 2', 'Agent 3']
const COORD_MODEL = 'gpt-4o-cleanup-coord'

/** Path to the runs directory (matches src/lib/storage/run-artifacts.ts). */
const RUNS_DIR = path.resolve(process.cwd(), 'data', 'runs')

test.beforeEach(async ({ request }) => {
  await resetDb(request)
  await resetMockBehavior(request)
})

/** Seed endpoint + 3 agents + coordinator pointing at mock. */
async function seedConfig(request: APIRequestContext): Promise<void> {
  const epRes = await request.post('/api/endpoints', {
    data: { name: 'Mock', base_url: MOCK_URL, api_key: 'sk-mock' },
  })
  expect(epRes.status()).toBe(201)
  const ep = await epRes.json()
  for (let i = 0; i < AGENT_NAMES.length; i++) {
    await request.post('/api/agents', {
      data: {
        name: AGENT_NAMES[i],
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
}

/** Run the full pipeline (translate + 4 stages) via API SSE. */
async function runFullPipeline(
  request: APIRequestContext,
  sessionId: string,
): Promise<void> {
  // Configure agent models to stream
  for (let i = 0; i < AGENT_NAMES.length; i++) {
    await setMockBehavior(request, {
      behavior: 'stream',
      model: `agent-model-${i + 1}`,
      delayMs: 5,
    })
  }

  // Run translation fanout
  const translateRes = await request.post(`/api/sessions/${sessionId}/translate`, {
    headers: { Accept: 'text/event-stream' },
    timeout: 60_000,
  })
  expect(translateRes.status()).toBe(200)
  const translateEvents = await collectSSEEvents(translateRes)
  expect(sseEventNames(translateEvents)).toContain('fanout_complete')
  const fanoutPayload = sseData<{ succeeded: number; failed: number }>(
    translateEvents,
    'fanout_complete',
  )
  expect(fanoutPayload?.succeeded).toBe(3)
  expect(fanoutPayload?.failed).toBe(0)

  // Run review → filter → orchestrate → assemble
  const stagePayloads: Record<string, string> = {
    review: buildReviewOutput(AGENT_NAMES),
    filter: buildFilterOutput(['Agent 1', 'Agent 2'], ['Agent 3']),
    orchestrate: buildOrchestrateOutput([
      {
        segment_index: 0,
        source_agent_id: 'Agent 1',
        source_segment: '春风又绿江南岸',
        rationale: '首句',
      },
      {
        segment_index: 1,
        source_agent_id: 'Agent 2',
        source_segment: '明月何时照我还',
        rationale: '尾句',
      },
    ]),
    assemble: '春风又绿江南岸，明月何时照我还。',
  }

  for (const stage of ['review', 'filter', 'orchestrate', 'assemble'] as const) {
    await setMockBehavior(request, {
      behavior: 'json_content',
      model: COORD_MODEL,
      jsonContent: stagePayloads[stage],
    })
    const res = await request.post(
      `/api/sessions/${sessionId}/stages/${stage}/run`,
      { headers: { Accept: 'text/event-stream' }, timeout: 60_000 },
    )
    expect(res.status()).toBe(200)
    const events = await collectSSEEvents(res)
    expect(sseEventNames(events)).toContain('stage_complete')
  }
}

// ---------------------------------------------------------------------------

test.describe('Task17 — Session cleanup', () => {
  test('run full pipeline → delete session → txt directory cleaned', async ({ request }) => {
    await seedConfig(request)

    // Create session via API
    const sessRes = await request.post('/api/sessions', {
      data: { sourceText: SOURCE_TEXT },
    })
    expect(sessRes.status()).toBe(200)
    const session = await sessRes.json()
    const sessionId = session.id

    // Run the full pipeline
    await runFullPipeline(request, sessionId)

    // ── Verify txt directory exists with files BEFORE delete ──
    const sessionDir = path.join(RUNS_DIR, sessionId)
    expect(
      fs.existsSync(sessionDir),
      `txt directory should exist after pipeline: ${sessionDir}`,
    ).toBe(true)

    // Verify at least the 4 stage txt files + 3 draft txt files exist
    const expectedFiles = [
      'review.txt',
      'filter.txt',
      'orchestrate.txt',
      'assemble.txt',
      `draft-${AGENT_NAMES[0]}.txt`,
      `draft-${AGENT_NAMES[1]}.txt`,
      `draft-${AGENT_NAMES[2]}.txt`,
    ]
    for (const fileName of expectedFiles) {
      const filePath = path.join(sessionDir, fileName)
      expect(
        fs.existsSync(filePath),
        `txt file should exist before delete: ${fileName}`,
      ).toBe(true)
    }

    // Verify session exists in DB
    const beforeDetail = await request.get(`/api/sessions/${sessionId}`)
    expect(beforeDetail.status()).toBe(200)

    // ── Delete the session via API ──
    const deleteRes = await request.delete(`/api/sessions/${sessionId}`)
    expect(deleteRes.status()).toBe(204)

    // ── Verify txt directory is GONE after delete ──
    expect(
      fs.existsSync(sessionDir),
      `txt directory should be cleaned after delete: ${sessionDir}`,
    ).toBe(false)

    // ── Verify session is gone from DB ──
    const afterDetail = await request.get(`/api/sessions/${sessionId}`)
    expect(afterDetail.status()).toBe(404)

    // ── Verify session no longer in list ──
    const listRes = await request.get('/api/sessions?limit=100')
    expect(listRes.status()).toBe(200)
    const { sessions } = await listRes.json()
    expect(
      (sessions as Array<{ id: string }>).find((s) => s.id === sessionId),
    ).toBeUndefined()
  })
})
