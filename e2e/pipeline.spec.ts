// ---------------------------------------------------------------------------
// E2E: pipeline.spec.ts
//
// Covers:
//   - Full pipeline free-text flow (UI): create session → source text →
//     translate → review → filter → orchestrate → assemble → verify
//     final_version created → verify txt files exist on disk
//   - Assemble output without `---` → verify final_text is full raw_output
//     (API-SSE-driven for precise mock control)
//   - Assemble empty output → verify stage fails, no final_version
//     (API-SSE-driven)
//
// Strategy:
//   Test 1 is UI-driven (matches the "free-text flow" user story) following
//   the coordinator.spec.ts pattern. Tests 2 & 3 are API-SSE-driven (like
//   performance.spec.ts) for precise control over the assemble mock's
//   jsonContent without UI timing constraints.
//
// All LLM calls are mocked via the shared mock LLM server (port 41099).
// Txt artifacts are verified directly from the test process via Node `fs`
// (the Playwright test process shares the server's working directory).
// ---------------------------------------------------------------------------

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { TID } from '../src/lib/testids'
import {
  resetDb,
  resetMockBehavior,
  setMockBehavior,
  byTid,
  evidenceScreenshot,
  tid,
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
const COORD_MODEL = 'gpt-4o-pipeline-coord'

/** Path to the runs directory (matches src/lib/storage/run-artifacts.ts). */
const RUNS_DIR = path.resolve(process.cwd(), 'data', 'runs')

test.beforeEach(async ({ request }) => {
  await resetDb(request)
  await resetMockBehavior(request)
})

/** Seed endpoint + 3 agents + coordinator pointing at mock. */
async function seedConfig(request: APIRequestContext): Promise<{ endpointId: number }> {
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
  return { endpointId: ep.id }
}

/** Configure mock for streaming agents (all three agent models). */
async function setAgentStreamMocks(request: APIRequestContext): Promise<void> {
  for (let i = 0; i < AGENT_NAMES.length; i++) {
    await setMockBehavior(request, {
      behavior: 'stream',
      model: `agent-model-${i + 1}`,
      delayMs: 5,
    })
  }
}

/** Configure mock to return C2-schema JSON for a specific stage. */
async function setStageMock(
  request: APIRequestContext,
  stage: 'review' | 'filter' | 'orchestrate',
): Promise<void> {
  let jsonContent: string
  switch (stage) {
    case 'review':
      jsonContent = buildReviewOutput(AGENT_NAMES)
      break
    case 'filter':
      jsonContent = buildFilterOutput(['Agent 1', 'Agent 2'], ['Agent 3'])
      break
    case 'orchestrate':
      jsonContent = buildOrchestrateOutput([
        {
          segment_index: 0,
          source_agent_id: 'Agent 1',
          source_segment: '春风又绿江南岸',
          rationale: '首句取 Agent 1',
        },
        {
          segment_index: 1,
          source_agent_id: 'Agent 2',
          source_segment: '明月何时照我还',
          rationale: '尾句取 Agent 2',
        },
      ])
      break
  }
  await setMockBehavior(request, {
    behavior: 'json_content',
    model: COORD_MODEL,
    jsonContent,
  })
}

// ---------------------------------------------------------------------------
// TEST 1: Full pipeline free-text flow (UI-driven)
// ---------------------------------------------------------------------------

test.describe('Task17 — Full pipeline free-text flow', () => {
  test('create session → translate → 4 stages → final_version created → txt files exist', async ({
    page,
    request,
  }) => {
    await seedConfig(request)
    await setAgentStreamMocks(request)

    // ── 1. Free-text flow: user types source text and clicks translate ──
    await page.goto('/')
    await byTid(page, TID.translate.sourceInput).waitFor({ state: 'visible' })
    await byTid(page, TID.translate.sourceInput).fill(SOURCE_TEXT)
    await byTid(page, TID.translate.translateButton).click()

    // Wait for all 3 agent cards to reach complete status
    await expect(byTid(page, TID.translate.agentStreamCard)).toHaveCount(3, {
      timeout: 10_000,
    })
    await expect(byTid(page, TID.translate.agentStatusComplete)).toHaveCount(3, {
      timeout: 30_000,
    })

    // ── 2. Run the four stages in order via UI ──
    await byTid(page, TID.stage.stepper).waitFor({ state: 'visible' })
    const stages = ['review', 'filter', 'orchestrate', 'assemble'] as const
    for (const stage of stages) {
      // For assemble, set a mock with a non-empty final_text containing `---`
      // to exercise the normal (separator-present) path.
      if (stage === 'assemble') {
        await setMockBehavior(request, {
          behavior: 'json_content',
          model: COORD_MODEL,
          jsonContent: '春风又绿江南岸，明月何时照我还。\n---\n这是组装注释。',
        })
      } else {
        await setStageMock(request, stage)
      }

      const btn = page
        .locator(`[data-stage="${stage}"]`)
        .locator(tid(TID.stage.runStageButton))
      await expect(btn).toBeEnabled({ timeout: 10_000 })
      await btn.click()

      // Wait for the 完成 badge on this stage's output panel
      await expect(
        page
          .locator(`${tid(TID.stage.outputPanel)}[data-stage="${stage}"]`)
          .locator('text=完成'),
      ).toBeVisible({ timeout: 30_000 })
    }

    // ── 3. Verify final_text populated in UI ──
    await expect(byTid(page, TID.edit.finalText)).toContainText(/春风又绿江南岸/, {
      timeout: 10_000,
    })
    await evidenceScreenshot(page, 'pipeline-full-flow-complete')

    // ── 4. Get the session ID (most recent session) ──
    const sessListRes = await request.get('/api/sessions?limit=1')
    expect(sessListRes.status()).toBe(200)
    const { sessions } = await sessListRes.json()
    expect(sessions.length).toBe(1)
    const sessionId = sessions[0].id

    // ── 5. Verify final_version created via API ──
    const sessDetailRes = await request.get(`/api/sessions/${sessionId}`)
    expect(sessDetailRes.status()).toBe(200)
    const detail = await sessDetailRes.json()
    expect(detail.versions.length).toBeGreaterThanOrEqual(1)
    const assembleVersion = detail.versions.find(
      (v: { source: string }) => v.source === 'assemble',
    )
    expect(assembleVersion).toBeDefined()
    expect(assembleVersion.text).toContain('春风又绿江南岸')
    // Session state should be 'assembled'
    expect(detail.session.state).toBe('assembled')

    // ── 6. Verify txt files exist on disk ──
    const sessionDir = path.join(RUNS_DIR, sessionId)
    expect(fs.existsSync(sessionDir), `session dir should exist: ${sessionDir}`).toBe(true)

    // Stage txt files
    for (const stage of stages) {
      const txtPath = path.join(sessionDir, `${stage}.txt`)
      expect(fs.existsSync(txtPath), `stage txt should exist: ${stage}.txt`).toBe(true)
      const content = fs.readFileSync(txtPath, 'utf-8')
      expect(content.length).toBeGreaterThan(0)
    }

    // Draft txt files (one per agent, named draft-{agentKey})
    // agent_key equals the agent's name (see session-service.ts)
    for (const name of AGENT_NAMES) {
      const draftPath = path.join(sessionDir, `draft-${name}.txt`)
      expect(fs.existsSync(draftPath), `draft txt should exist: draft-${name}.txt`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// TEST 2: Assemble output without `---` → final_text is full raw_output
// ---------------------------------------------------------------------------

test.describe('Task17 — Assemble without `---` separator', () => {
  test('raw_output has no `---` → final_version.text equals full raw_output', async ({
    request,
  }) => {
    await seedConfig(request)
    await setAgentStreamMocks(request)

    // Create session via API
    const sessRes = await request.post('/api/sessions', {
      data: { sourceText: SOURCE_TEXT },
    })
    expect(sessRes.status()).toBe(200)
    const session = await sessRes.json()
    const sessionId = session.id

    // Run translation fanout via SSE
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

    // Run review → filter → orchestrate via SSE
    for (const stage of ['review', 'filter', 'orchestrate'] as const) {
      await setStageMock(request, stage)
      const res = await request.post(
        `/api/sessions/${sessionId}/stages/${stage}/run`,
        { headers: { Accept: 'text/event-stream' }, timeout: 60_000 },
      )
      expect(res.status()).toBe(200)
      const events = await collectSSEEvents(res)
      expect(sseEventNames(events)).toContain('stage_complete')
    }

    // ── Configure assemble mock with content that has NO `---` separator ──
    // The pipeline extracts final_text as rawText.split('\n---\n')[0].trim().
    // With no `---`, the split returns the whole string, so final_text should
    // equal the full raw_output.
    const fullRawOutput = '这是没有分隔符的完整译文内容，将作为最终文本。'
    await setMockBehavior(request, {
      behavior: 'json_content',
      model: COORD_MODEL,
      jsonContent: fullRawOutput,
    })

    const assembleRes = await request.post(
      `/api/sessions/${sessionId}/stages/assemble/run`,
      { headers: { Accept: 'text/event-stream' }, timeout: 60_000 },
    )
    expect(assembleRes.status()).toBe(200)
    const assembleEvents = await collectSSEEvents(assembleRes)
    expect(sseEventNames(assembleEvents)).toContain('stage_complete')

    // ── Verify final_version.text equals the full raw_output ──
    const detailRes = await request.get(`/api/sessions/${sessionId}`)
    expect(detailRes.status()).toBe(200)
    const detail = await detailRes.json()

    // Find the assemble stage_output to get raw_output
    const assembleStage = detail.stages.find(
      (s: { stage: string }) => s.stage === 'assemble',
    )
    expect(assembleStage).toBeDefined()
    expect(assembleStage.status).toBe('complete')
    expect(assembleStage.raw_output).toBe(fullRawOutput)

    // Find the final_version created by assemble
    const assembleVersion = detail.versions.find(
      (v: { source: string }) => v.source === 'assemble',
    )
    expect(assembleVersion).toBeDefined()
    // final_text = raw_output.split('\n---\n')[0].trim() = fullRawOutput (no `---`)
    expect(assembleVersion.text).toBe(fullRawOutput)
    // Explicitly assert equality: final_version.text === raw_output (no truncation)
    expect(assembleVersion.text).toBe(assembleStage.raw_output)

    // Session state should be 'assembled'
    expect(detail.session.state).toBe('assembled')
  })
})

// ---------------------------------------------------------------------------
// TEST 3: Assemble empty output → stage fails, no final_version
// ---------------------------------------------------------------------------

test.describe('Task17 — Assemble empty output fails', () => {
  test('empty raw_output → stage status=failed, no final_version, state stays coordinating', async ({
    request,
  }) => {
    await seedConfig(request)
    await setAgentStreamMocks(request)

    // Create session + run translation fanout
    const sessRes = await request.post('/api/sessions', {
      data: { sourceText: SOURCE_TEXT },
    })
    expect(sessRes.status()).toBe(200)
    const session = await sessRes.json()
    const sessionId = session.id

    const translateRes = await request.post(`/api/sessions/${sessionId}/translate`, {
      headers: { Accept: 'text/event-stream' },
      timeout: 60_000,
    })
    expect(translateRes.status()).toBe(200)
    const translateEvents = await collectSSEEvents(translateRes)
    expect(sseEventNames(translateEvents)).toContain('fanout_complete')

    // Run review → filter → orchestrate
    for (const stage of ['review', 'filter', 'orchestrate'] as const) {
      await setStageMock(request, stage)
      const res = await request.post(
        `/api/sessions/${sessionId}/stages/${stage}/run`,
        { headers: { Accept: 'text/event-stream' }, timeout: 60_000 },
      )
      expect(res.status()).toBe(200)
      const events = await collectSSEEvents(res)
      expect(sseEventNames(events)).toContain('stage_complete')
    }

    // ── Configure assemble mock to return EMPTY content ──
    // jsonContent = '' → raw_text = '' → final_text = '' (after trim)
    // handlers.ts overrides ok=false, code='assemble_empty'
    await setMockBehavior(request, {
      behavior: 'json_content',
      model: COORD_MODEL,
      jsonContent: '',
    })

    const assembleRes = await request.post(
      `/api/sessions/${sessionId}/stages/assemble/run`,
      { headers: { Accept: 'text/event-stream' }, timeout: 60_000 },
    )
    expect(assembleRes.status()).toBe(200)
    const assembleEvents = await collectSSEEvents(assembleRes)
    // The SSE stream should emit stage_error (not stage_complete)
    const eventNames = sseEventNames(assembleEvents)
    expect(eventNames).toContain('stage_error')
    expect(eventNames).not.toContain('stage_complete')

    // The stage_error event should carry the assemble_empty code
    const errorPayload = sseData<{ stage: string; code?: string; detail?: string }>(
      assembleEvents,
      'stage_error',
    )
    expect(errorPayload?.stage).toBe('assemble')
    expect(errorPayload?.code).toBe('assemble_empty')

    // ── Verify via API: stage status=failed, no final_version ──
    const detailRes = await request.get(`/api/sessions/${sessionId}`)
    expect(detailRes.status()).toBe(200)
    const detail = await detailRes.json()

    const assembleStage = detail.stages.find(
      (s: { stage: string }) => s.stage === 'assemble',
    )
    expect(assembleStage).toBeDefined()
    expect(assembleStage.status).toBe('failed')
    expect(assembleStage.error).toContain('empty')

    // No final_version should exist (no 'assemble' source version)
    const assembleVersion = (detail.versions as Array<{ source: string }>).find(
      (v) => v.source === 'assemble',
    )
    expect(assembleVersion).toBeUndefined()

    // Session state should NOT be 'assembled' (stays 'coordinating')
    expect(detail.session.state).not.toBe('assembled')
    expect(detail.session.state).toBe('coordinating')
  })
})
