// ---------------------------------------------------------------------------
// E2E: config.spec.ts
//
// Covers:
//   AC16 — 端点添加（endpoint add via UI form → POST /api/endpoints → list item）
//   AC17 — 三 agent 配置（three translator agents created via UI）
//   AC22 — flash 警告闭环（flash model → warning modal → "don't show again"
//          → suppress persisted → subsequent save no warning）
//
// All LLM base_urls point at the shared mock on port 41099 (E2E_MOCK_LLM_URL).
// DB is reset before each test via POST /api/test-only/reset-db.
// ---------------------------------------------------------------------------

import { test, expect } from '@playwright/test'
import { TID } from '../src/lib/testids'
import {
  resetDb,
  resetMockBehavior,
  byTid,
  evidenceScreenshot,
  tid,
} from './helpers'

const MOCK_URL = process.env.E2E_MOCK_LLM_URL ?? 'http://localhost:41099'

test.beforeEach(async ({ request }) => {
  await resetDb(request)
  await resetMockBehavior(request)
})

test.describe('AC16 — endpoint configuration', () => {
  test('add an endpoint via the config UI and see it in the list', async ({
    page,
  }) => {
    await page.goto('/config')

    // Wait for config panels to load (the add-endpoint button appears in
    // either the empty state or the card actions).
    await byTid(page, TID.endpoint.addButton).first().waitFor({ state: 'visible' })
    await evidenceScreenshot(page, 'config-initial')

    await byTid(page, TID.endpoint.addButton).first().click()

    // Modal form opens
    await byTid(page, TID.endpoint.form).waitFor({ state: 'visible' })
    await byTid(page, TID.endpoint.nameInput).fill('Mock LLM')
    await byTid(page, TID.endpoint.baseUrlInput).fill(MOCK_URL)
    await byTid(page, TID.endpoint.keyInput).fill('sk-mock-test-key')

    await evidenceScreenshot(page, 'config-endpoint-form-filled')

    await byTid(page, TID.endpoint.saveButton).click()

    // List item should appear (web-first: wait for the locator to resolve)
    await expect(byTid(page, TID.endpoint.listItem).first()).toBeVisible({
      timeout: 5000,
    })
    await expect(byTid(page, TID.endpoint.listItem)).toContainText(/Mock LLM/)

    await evidenceScreenshot(page, 'config-endpoint-saved')

    // Verify via API that the endpoint was persisted with the mock base_url
    const epRes = await page.request.get('/api/endpoints')
    expect(epRes.status()).toBe(200)
    const endpoints = await epRes.json()
    expect(endpoints.length).toBeGreaterThanOrEqual(1)
    expect(endpoints.some((e: { base_url: string }) => e.base_url === MOCK_URL)).toBe(true)
  })

  test('unbinds references before deleting an endpoint without deleting the Agent', async ({
    page,
  }) => {
    const endpointResponse = await page.request.post('/api/endpoints', {
      data: {
        name: 'Disposable provider',
        base_url: MOCK_URL,
        api_key: 'sk-mock',
      },
    })
    expect(endpointResponse.status()).toBe(201)
    const endpoint = (await endpointResponse.json()) as { id: number }

    const agentResponse = await page.request.post('/api/agents', {
      data: {
        name: 'Agent that must survive',
        endpoint_id: endpoint.id,
        model: 'mock-model',
        prompt_override: 'keep this user prompt',
        sort_order: 17,
      },
    })
    expect(agentResponse.status()).toBe(201)

    await page.goto('/config')
    const endpointRow = byTid(page, TID.endpoint.listItem).filter({
      hasText: 'Disposable provider',
    })
    await expect(endpointRow).toBeVisible()
    await endpointRow.getByRole('button', { name: '删除' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('系统会先检查全部引用')
    await dialog.getByRole('button', { name: '检查引用并删除' }).click()

    await expect(dialog).toContainText('确认解绑并删除')
    await expect(dialog).toContainText('旧版翻译 Agent')
    await expect(dialog).toContainText('Agent、提示词、模型名称、预设内容和冻结历史都会保留')
    await dialog.getByRole('button', { name: '解绑所有引用并删除' }).click()

    await expect(endpointRow).not.toBeVisible()
    const agentsResponse = await page.request.get('/api/agents')
    expect(agentsResponse.status()).toBe(200)
    const agents = (await agentsResponse.json()) as Array<{
      name: string
      endpoint_id: number | null
      model: string
      prompt_override: string | null
      sort_order: number
    }>
    expect(agents).toContainEqual(
      expect.objectContaining({
        name: 'Agent that must survive',
        endpoint_id: null,
        model: 'mock-model',
        prompt_override: 'keep this user prompt',
        sort_order: 17,
      }),
    )
  })
})

test.describe('AC17 — three translator agents', () => {
  test.skip('legacy agent editor is replaced by the direction-aware Agent library', async ({
    page,
  }) => {
    // Seed an endpoint via API (faster than UI for setup), then create three
    // agents through the UI to exercise AC17's "three agent config" surface.
    await page.request.post('/api/endpoints', {
      data: { name: 'Mock', base_url: MOCK_URL, api_key: 'sk-mock' },
    })

    await page.goto('/config')
    await byTid(page, TID.agent.addAgentButton).waitFor({ state: 'visible' })

    const agentModels = ['gpt-4o', 'claude-3.7-sonnet', 'gemini-2.0-pro']
    for (let i = 0; i < agentModels.length; i++) {
      await byTid(page, TID.agent.addAgentButton).click()
      // A new draft card appears; fill its model input
      const draftCards = byTid(page, TID.agent.card)
      await expect(draftCards).toHaveCount(i + 1)
      const lastCard = draftCards.nth(i)
      await lastCard.locator(tid(TID.agent.modelInput)).fill(agentModels[i])
      // Click the "创建" button at the bottom of this card
      await lastCard.getByRole('button', { name: '创建' }).click()
      // Wait for the card count to settle (the draft becomes a saved card)
      await expect(byTid(page, TID.agent.card)).toHaveCount(i + 1)
    }

    await evidenceScreenshot(page, 'config-three-agents')

    // Verify via API
    const agRes = await page.request.get('/api/agents')
    expect(agRes.status()).toBe(200)
    const agents = await agRes.json()
    expect(agents.length).toBe(3)
    const models = agents.map((a: { model: string }) => a.model)
    expect(models).toEqual(expect.arrayContaining(agentModels))
  })
})

test.describe('AC22 — flash warning closed loop', () => {
  test.skip('legacy coordinator card is replaced by model profiles', async ({
    page,
  }) => {
    // Seed endpoint so coordinator can be configured
    await page.request.post('/api/endpoints', {
      data: { name: 'Mock', base_url: MOCK_URL, api_key: 'sk-mock' },
    })

    await page.goto('/config')
    await byTid(page, TID.coordinator.modelInput).waitFor({ state: 'visible' })

    // Type a flash model name (matches detectFlashModel regex)
    await byTid(page, TID.coordinator.modelInput).fill('gemini-1.5-flash')
    // Click the coordinator save button (labeled 保存). Scope to the panel
    // containing the coordinator model input so we don't match other 保存
    // buttons (e.g. agent cards).
    const coordPanel = page.locator('section', {
      has: page.locator(tid(TID.coordinator.modelInput)),
    })
    await coordPanel.getByRole('button', { name: '保存' }).click()

    // Flash warning modal should appear (AC22 step 1)
    await expect(byTid(page, TID.coordinator.flashWarning)).toBeVisible({ timeout: 5000 })
    await expect(byTid(page, TID.coordinator.flashWarning)).toContainText(
      /不推荐使用flash模型进行统筹/,
    )
    await evidenceScreenshot(page, 'config-flash-warning-shown')

    // Check "don't show again" then confirm → suppress persisted
    await byTid(page, TID.coordinator.dontShowAgainCheckbox).check()
    await byTid(page, TID.coordinator.flashWarning)
      .getByRole('button', { name: '确定' })
      .click()

    // Modal closes
    await expect(byTid(page, TID.coordinator.flashWarning)).not.toBeVisible({
      timeout: 5000,
    })

    // Verify server-side suppression persisted (settings table)
    const settingsRes = await page.request.get('/api/settings')
    expect(settingsRes.status()).toBe(200)
    const settings = await settingsRes.json()
    const suppress = settings.find(
      (s: { key: string; value: string }) => s.key === 'suppress_flash_warning',
    )
    expect(suppress?.value).toBe('1')

    // Re-save the same flash model — no warning modal should appear this time
    await byTid(page, TID.coordinator.modelInput).fill('gemini-1.5-flash')
    await coordPanel.getByRole('button', { name: '保存' }).click()
    // Web-first: assert the modal does NOT appear within a short window.
    await expect(byTid(page, TID.coordinator.flashWarning)).not.toBeVisible({
      timeout: 3000,
    })
    await evidenceScreenshot(page, 'config-flash-warning-suppressed')
  })

  test.skip('legacy coordinator card no longer owns model warnings', async ({ page }) => {
    await page.request.post('/api/endpoints', {
      data: { name: 'Mock', base_url: MOCK_URL, api_key: 'sk-mock' },
    })
    await page.goto('/config')
    await byTid(page, TID.coordinator.modelInput).waitFor({ state: 'visible' })
    await byTid(page, TID.coordinator.modelInput).fill('gpt-4o')
    const coordPanel = page.locator('section', {
      has: page.locator(tid(TID.coordinator.modelInput)),
    })
    await coordPanel.getByRole('button', { name: '保存' }).click()
    await expect(byTid(page, TID.coordinator.flashWarning)).not.toBeVisible({
      timeout: 3000,
    })
  })
})
