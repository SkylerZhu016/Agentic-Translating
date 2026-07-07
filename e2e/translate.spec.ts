// ---------------------------------------------------------------------------
// E2E: translate.spec.ts
//
// Covers:
//   AC18 — 流式网格（streaming agent grid: N agents → N cards with streaming
//          status badges, transitioning to complete) + 单卡重试（single card
//          retry: induce error on one agent → retry-agent-button → re-streams
//          → complete）
//
// All LLM base_urls point at the shared mock on port 41099. The mock is
// configured via POST /__control to return predictable stream / error
// behaviors per model.
// ---------------------------------------------------------------------------

import { test, expect } from '@playwright/test'
import { TID } from '../src/lib/testids'
import {
  resetDb,
  resetMockBehavior,
  setMockBehavior,
  byTid,
  evidenceScreenshot,
  tid,
} from './helpers'

const MOCK_URL = process.env.E2E_MOCK_LLM_URL ?? 'http://localhost:41099'
const SOURCE_TEXT = 'The quick brown fox jumps over the lazy dog.'

test.beforeEach(async ({ request }) => {
  await resetDb(request)
  await resetMockBehavior(request)
})

/** Seed a baseline config (1 endpoint + 3 agents) via API for fast setup. */
async function seedBaselineConfig(
  request: import('@playwright/test').APIRequestContext,
  models: string[],
): Promise<void> {
  const epRes = await request.post('/api/endpoints', {
    data: { name: 'Mock', base_url: MOCK_URL, api_key: 'sk-mock' },
  })
  expect(epRes.status()).toBe(201)
  const ep = await epRes.json()
  for (let i = 0; i < models.length; i++) {
    const agRes = await request.post('/api/agents', {
      data: {
        name: `Agent ${i + 1}`,
        endpoint_id: ep.id,
        model: models[i],
        prompt_override: null,
        sort_order: i,
      },
    })
    expect(agRes.status()).toBe(201)
  }
}

test.describe('AC18 — streaming agent grid', () => {
  test('three agents stream in parallel → all cards reach complete status', async ({
    page,
    request,
  }) => {
    // Configure mock: all three models stream successfully
    await setMockBehavior(request, { behavior: 'stream', model: 'gpt-4o', delayMs: 5 })
    await setMockBehavior(request, { behavior: 'stream', model: 'claude-3.7', delayMs: 5 })
    await setMockBehavior(request, { behavior: 'stream', model: 'gemini-2.0', delayMs: 5 })

    await seedBaselineConfig(request, ['gpt-4o', 'claude-3.7', 'gemini-2.0'])

    await page.goto('/')
    await byTid(page, TID.translate.sourceInput).waitFor({ state: 'visible' })

    await byTid(page, TID.translate.sourceInput).fill(SOURCE_TEXT)
    await byTid(page, TID.translate.translateButton).click()

    // Wait for three agent cards to appear
    await expect(byTid(page, TID.translate.agentStreamCard)).toHaveCount(3, {
      timeout: 10_000,
    })

    // Each card should transition through streaming → complete.
    // Web-first: wait for all three complete badges to appear.
    await expect(
      byTid(page, TID.translate.agentStatusComplete),
    ).toHaveCount(3, { timeout: 30_000 })

    // No error badges should be present
    await expect(byTid(page, TID.translate.agentStatusError)).toHaveCount(0)

    await evidenceScreenshot(page, 'translate-all-complete')
  })

  test('cards show streaming badge while in flight', async ({ page, request }) => {
    // Slower stream so the streaming badge is observable
    await setMockBehavior(request, { behavior: 'stream', delayMs: 50 })

    await seedBaselineConfig(request, ['gpt-4o', 'claude-3.7', 'gemini-2.0'])

    await page.goto('/')
    await byTid(page, TID.translate.sourceInput).fill(SOURCE_TEXT)
    await byTid(page, TID.translate.translateButton).click()

    await expect(byTid(page, TID.translate.agentStreamCard)).toHaveCount(3, {
      timeout: 10_000,
    })

    // At least one streaming badge should appear before any complete badge
    await expect(byTid(page, TID.translate.agentStatusStreaming).first()).toBeVisible({
      timeout: 10_000,
    })
    await evidenceScreenshot(page, 'translate-streaming-in-flight')

    // Eventually all complete
    await expect(byTid(page, TID.translate.agentStatusComplete)).toHaveCount(3, {
      timeout: 30_000,
    })
  })
})

test.describe('AC18 — single card retry', () => {
  test('error card shows retry button → click → card re-streams to complete', async ({
    page,
    request,
  }) => {
    // Two models succeed, one fails (5xx → retryable in fanout, but we use
    // 401 which is non-retryable so the card lands in error state).
    await setMockBehavior(request, { behavior: 'stream', model: 'gpt-4o' })
    await setMockBehavior(request, { behavior: 'stream', model: 'claude-3.7' })
    await setMockBehavior(request, {
      behavior: 'error',
      model: 'gemini-2.0',
      status: 401,
      errorMessage: 'Invalid API key',
    })

    await seedBaselineConfig(request, ['gpt-4o', 'claude-3.7', 'gemini-2.0'])

    await page.goto('/')
    await byTid(page, TID.translate.sourceInput).fill(SOURCE_TEXT)
    await byTid(page, TID.translate.translateButton).click()

    await expect(byTid(page, TID.translate.agentStreamCard)).toHaveCount(3, {
      timeout: 10_000,
    })

    // Wait for the error badge to appear (at least one card errors)
    await expect(byTid(page, TID.translate.agentStatusError).first()).toBeVisible({
      timeout: 20_000,
    })
    await evidenceScreenshot(page, 'translate-error-card-shown')

    // The retry button should be visible on the error card
    const retryButton = byTid(page, TID.translate.retryAgentButton).first()
    await expect(retryButton).toBeVisible()

    // Now flip the failing model to stream so retry succeeds
    await setMockBehavior(request, { behavior: 'stream', model: 'gemini-2.0' })

    await retryButton.click()

    // After retry, the error badge should disappear and a complete badge
    // should be present on that card. Wait for all 3 completes.
    await expect(byTid(page, TID.translate.agentStatusComplete)).toHaveCount(3, {
      timeout: 30_000,
    })
    await expect(byTid(page, TID.translate.agentStatusError)).toHaveCount(0)

    await evidenceScreenshot(page, 'translate-retry-success')
  })
})
