// ---------------------------------------------------------------------------
// E2E: translate.spec.ts
//
// Covers:
//   AC18 — 动态保底流式网格（两个互补角色 → 两张卡片）+ 单卡重试（single card
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
  const binding = (model: string) => ({
    endpointId: ep.id,
    model,
    contextWindow: 128000,
  })
  const profile = await request.put('/api/model-profiles/en_to_zh', {
    data: {
      defaultWorker: binding(models[0]),
      mainAgent: binding('main-model'),
      editingAgent: binding(models[1] ?? models[0]),
    },
  })
  expect(profile.status()).toBe(200)
  await setMockBehavior(request, {
    behavior: 'tool_call',
    model: 'main-model',
    stream: true,
  })
}

test.describe('AC18 — streaming agent grid', () => {
  test('fallback pair streams in parallel → both cards reach complete status', async ({
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

    const candidateCards = page.locator(
      `${tid(TID.translate.agentStreamCard)}[data-agent-kind="translation"]`,
    )
    await expect(candidateCards).toHaveCount(2, {
      timeout: 10_000,
    })

    // Each card should transition through streaming → complete.
    // Web-first: wait for both mandatory fallback candidates.
    await expect(
      candidateCards.locator(tid(TID.translate.agentStatusComplete)),
    ).toHaveCount(2, { timeout: 30_000 })

    // No error badges should be present
    await expect(
      candidateCards.locator(tid(TID.translate.agentStatusError)),
    ).toHaveCount(0)
    await expect(page.getByText('v1 · 主 Agent 成稿')).toBeVisible({
      timeout: 30_000,
    })

    await evidenceScreenshot(page, 'translate-all-complete')
  })

  test('cards show streaming badge while in flight', async ({ page, request }) => {
    test.setTimeout(60_000)
    // Slower stream so the streaming badge is observable
    for (const model of ['gpt-4o', 'claude-3.7', 'gemini-2.0']) {
      await setMockBehavior(request, {
        behavior: 'stream',
        model,
        delayMs: 250,
      })
    }

    await seedBaselineConfig(request, ['gpt-4o', 'claude-3.7', 'gemini-2.0'])

    await page.goto('/')
    await byTid(page, TID.translate.sourceInput).fill(SOURCE_TEXT)
    await byTid(page, TID.translate.translateButton).click()

    const candidateCards = page.locator(
      `${tid(TID.translate.agentStreamCard)}[data-agent-kind="translation"]`,
    )
    await expect(candidateCards).toHaveCount(2, {
      timeout: 30_000,
    })

    // At least one streaming badge should appear before any complete badge
    await expect(candidateCards.locator(tid(TID.translate.agentStatusStreaming)).first()).toBeVisible({
      timeout: 10_000,
    })
    await evidenceScreenshot(page, 'translate-streaming-in-flight')

    // Eventually all complete
    await expect(candidateCards.locator(tid(TID.translate.agentStatusComplete))).toHaveCount(2, {
      timeout: 30_000,
    })
    await expect(page.getByText('v1 · 主 Agent 成稿')).toBeVisible({
      timeout: 30_000,
    })
  })
})

test.describe('AC18 — single card retry', () => {
  test('error card shows retry button → click → card re-streams to complete', async ({
    page,
    request,
  }) => {
    await setMockBehavior(request, { behavior: 'stream', model: 'good-model' })
    await setMockBehavior(request, {
      behavior: 'error',
      model: 'bad-model',
      status: 401,
      errorMessage: 'Invalid API key',
    })

    const endpointResponse = await request.post('/api/endpoints', {
      data: { name: 'Retry Mock', base_url: MOCK_URL, api_key: 'sk-mock' },
    })
    expect(endpointResponse.status()).toBe(201)
    const endpoint = await endpointResponse.json()
    const catalogResponse = await request.get(
      '/api/agent-catalog?direction=en_to_zh',
    )
    expect(catalogResponse.status()).toBe(200)
    const catalog = await catalogResponse.json()
    const variants = catalog.variants.slice(0, 2)
    const defaultBinding = {
      endpointId: endpoint.id,
      model: 'good-model',
      contextWindow: 128000,
    }
    const presetResponse = await request.post('/api/workflow-presets', {
      data: {
        name: 'Retry fixed team',
        description: '',
        direction: 'en_to_zh',
        contract: {
          sourceLang: '英文',
          targetLang: '中文',
          taskBriefTemplate: '',
          teamPolicy: 'fixed',
          reviewMode: 'main_editor',
          agentVariantIds: variants.map((variant: { id: string }) => variant.id),
          agentVariantSnapshots: variants,
          defaultWorkerBinding: defaultBinding,
          agentBindingOverrides: {
            [variants[1].id]: {
              endpointId: endpoint.id,
              model: 'bad-model',
              contextWindow: 128000,
            },
          },
          mainAgentBinding: defaultBinding,
          editingAgentBinding: defaultBinding,
          promptBundleVersion: 1,
          maxAgentCalls: 5,
          batchConcurrency: 2,
          constraints: {},
        },
      },
    })
    expect(presetResponse.status()).toBe(201)
    const preset = await presetResponse.json()

    await page.goto('/')
    await page.locator('details').first().click()
    await page
      .locator('details select')
      .first()
      .selectOption(preset.preset.id)
    await byTid(page, TID.translate.sourceInput).fill(SOURCE_TEXT)
    await byTid(page, TID.translate.translateButton).click()

    await expect(byTid(page, TID.translate.agentStreamCard)).toHaveCount(2, {
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
    await setMockBehavior(request, { behavior: 'stream', model: 'bad-model' })

    await retryButton.click()

    // After retry, the error badge should disappear and a complete badge
    // should be present on that card. Wait for both completes.
    await expect(byTid(page, TID.translate.agentStatusComplete)).toHaveCount(2, {
      timeout: 30_000,
    })
    await expect(byTid(page, TID.translate.agentStatusError)).toHaveCount(0)

    await evidenceScreenshot(page, 'translate-retry-success')
  })
})
