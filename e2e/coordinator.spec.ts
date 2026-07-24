// ---------------------------------------------------------------------------
// E2E: coordinator.spec.ts
//
// Covers:
//   AC19 — 四步全通（four stages all pass: review → filter → orchestrate →
//          assemble, each producing a structured output panel; final-text
//          populated by assemble）
//          + stale 联动（stale linkage: re-run an upstream stage → downstream
//          stages show stale badge）
//
// Strategy:
//   1. Seed config + run translation via UI (so the session enters state
//      "translated" and stages become runnable).
//   2. Configure mock to return C2-schema-compliant JSON for the coordinator
//      model (used by all four stages).
//   3. Click each stage's run-stage-button in order; assert each
//      stage-output-panel shows a "完成" badge.
//   4. Re-run the review stage → assert the filter/orchestrate/assemble
//      panels show a stale badge.
// ---------------------------------------------------------------------------

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
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
  buildAssembleOutput,
} from './helpers'

const MOCK_URL = process.env.E2E_MOCK_LLM_URL ?? 'http://localhost:41099'
const SOURCE_TEXT = 'The quick brown fox jumps over the lazy dog.'
const AGENT_NAMES = ['Agent 1', 'Agent 2', 'Agent 3']
const COORD_MODEL = 'gpt-4o-coordinator'

test.beforeEach(async ({ request }) => {
  await resetDb(request)
  await resetMockBehavior(request)
})

/** Seed endpoint + 3 agents + coordinator config pointing at mock. */
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
  // Coordinator config (non-flash model)
  const coRes = await request.put('/api/coordinator', {
    data: { endpoint_id: ep.id, model: COORD_MODEL, chat_endpoint_id: ep.id, chat_model: 'chat-model' },
  })
  expect(coRes.status()).toBe(200)
}

/**
 * Configure the mock to return C2-schema-compliant JSON for the coordinator
 * model across all four stage prompts. The stage pipeline calls the LLM with
 * the same endpoint/model; the mock dispatches by model, so a single
 * setBehavior covers review/filter/orchestrate/assemble.
 *
 * Because the mock can only return one fixed jsonContent per model slot, we
 * switch behavior between stage runs by re-issuing /__control before each
 * stage click.
 */
async function setStageOutput(
  request: APIRequestContext,
  stage: 'review' | 'filter' | 'orchestrate' | 'assemble',
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
        { segment_index: 0, source_agent_id: 'Agent 1', source_segment: '春风又绿江南岸', rationale: '首句取 Agent 1' },
        { segment_index: 1, source_agent_id: 'Agent 2', source_segment: '明月何时照我还', rationale: '尾句取 Agent 2' },
      ])
      break
    case 'assemble':
      jsonContent = buildAssembleOutput('春风又绿江南岸，明月何时照我还。', '拼接两段译稿。')
      break
  }
  await setMockBehavior(request, {
    behavior: 'json_content',
    model: COORD_MODEL,
    jsonContent,
  })
}

/** Run the full translation fanout so the session enters state "translated". */
async function runTranslation(page: Page, request: APIRequestContext): Promise<void> {
  // All three agent models stream successfully
  for (let i = 0; i < AGENT_NAMES.length; i++) {
    await setMockBehavior(request, {
      behavior: 'stream',
      model: `agent-model-${i + 1}`,
      delayMs: 5,
    })
  }
  await page.goto('/')
  await byTid(page, TID.translate.sourceInput).fill(SOURCE_TEXT)
  await byTid(page, TID.translate.translateButton).click()
  // Dynamic selection falls back to the two mandatory complementary roles.
  await expect(byTid(page, TID.translate.agentStreamCard)).toHaveCount(2, { timeout: 10_000 })
  await expect(byTid(page, TID.translate.agentStatusComplete)).toHaveCount(2, { timeout: 30_000 })
}

/** Locator for a specific stage's run button (scoped by data-stage li). */
function stageRunButton(page: Page, stage: string) {
  return page
    .locator(`[data-stage="${stage}"]`)
    .locator(tid(TID.stage.runStageButton))
}

/** Locator for a specific stage's output panel (both data-stage + data-testid on the same element). */
function stageOutputPanel(page: Page, stage: string) {
  return page.locator(`${tid(TID.stage.outputPanel)}[data-stage="${stage}"]`)
}

test.describe('AC19 — four stages all pass', () => {
  test('review → filter → orchestrate → assemble complete in order', async ({
    page,
    request,
  }) => {
    await seedConfig(request)
    await runTranslation(page, request)

    // Stepper should be visible now
    await byTid(page, TID.stage.stepper).waitFor({ state: 'visible' })

    const stages = ['review', 'filter', 'orchestrate', 'assemble'] as const
    for (const stage of stages) {
      // Configure mock to return the right JSON for this stage's LLM call
      await setStageOutput(request, stage)

      const btn = stageRunButton(page, stage)
      await expect(btn).toBeEnabled({ timeout: 10_000 })
      await btn.click()

      // Wait for the panel's "完成" badge to appear (web-first)
      await expect(
        stageOutputPanel(page, stage).locator('text=完成'),
      ).toBeVisible({ timeout: 30_000 })

      await evidenceScreenshot(page, `coordinator-${stage}-complete`)
    }

    // After assemble, final-text should be populated
    await expect(byTid(page, TID.edit.finalText)).toContainText(/春风又绿江南岸/, {
      timeout: 10_000,
    })
    await evidenceScreenshot(page, 'coordinator-all-stages-complete')
  })
})

test.describe('AC19 — stale linkage', () => {
  test('re-run review → filter/orchestrate/assemble show stale badge', async ({
    page,
    request,
  }) => {
    await seedConfig(request)
    await runTranslation(page, request)

    const stages = ['review', 'filter', 'orchestrate', 'assemble'] as const
    for (const stage of stages) {
      await setStageOutput(request, stage)
      const btn = stageRunButton(page, stage)
      await expect(btn).toBeEnabled({ timeout: 10_000 })
      await btn.click()
      await expect(
        stageOutputPanel(page, stage).locator('text=完成'),
      ).toBeVisible({ timeout: 30_000 })
    }

    // All four complete; no stale badges yet
    await expect(byTid(page, TID.stage.staleBadge)).toHaveCount(0)

    // Re-run review → downstream stages should become stale
    await setStageOutput(request, 'review')
    const reviewBtn = stageRunButton(page, 'review')
    await expect(reviewBtn).toBeEnabled()
    await reviewBtn.click()
    // Review itself should reach complete again
    await expect(
      stageOutputPanel(page, 'review').locator('text=完成'),
    ).toBeVisible({ timeout: 30_000 })

    // Downstream stages (filter, orchestrate, assemble) should now show stale badges
    await expect(byTid(page, TID.stage.staleBadge)).toHaveCount(3, { timeout: 10_000 })
    await evidenceScreenshot(page, 'coordinator-stale-linkage')
  })
})
