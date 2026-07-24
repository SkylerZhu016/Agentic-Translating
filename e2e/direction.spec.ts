import { test, expect, type APIRequestContext } from '@playwright/test'
import { TID } from '../src/lib/testids'
import { byTid, resetDb } from './helpers'

const MOCK_URL = process.env.E2E_MOCK_LLM_URL ?? 'http://localhost:41099'

async function seedEndpoint(request: APIRequestContext) {
  const response = await request.post('/api/endpoints', {
    data: {
      name: 'Direction Mock',
      base_url: MOCK_URL,
      api_key: 'sk-direction',
    },
  })
  expect(response.status()).toBe(201)
}

test.beforeEach(async ({ request }) => {
  await resetDb(request)
  await seedEndpoint(request)
})

test.describe('bidirectional workspace switching', () => {
  test('blank workspace switches immediately without a warning', async ({
    page,
  }) => {
    await page.goto('/')
    await byTid(page, TID.translate.sourceInput).waitFor()

    await byTid(page, TID.direction.zhToEnButton).click()

    await expect(page).toHaveURL(/\?direction=zh_to_en$/)
    await expect(byTid(page, TID.direction.warningDialog)).toHaveCount(0)
    await expect(byTid(page, TID.direction.zhToEnButton)).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  test('draft warning can cancel, confirm, suppress, and restore the other draft', async ({
    page,
    request,
  }) => {
    await request.put('/api/workspace-drafts/zh_to_en', {
      data: {
        sourceText: '目标方向中已保存的草稿',
        taskBrief: 'Use concise literary English.',
        selectedPresetRevisionId: null,
        allowedAgentVariantIds: [],
        reviewMode: 'main_editor',
      },
    })

    await page.goto('/?direction=en_to_zh')
    const source = byTid(page, TID.translate.sourceInput)
    await source.fill('Switching must save this draft.')
    await byTid(page, TID.direction.zhToEnButton).click()

    const dialog = byTid(page, TID.direction.warningDialog)
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('切换翻译模式？')
    await expect(dialog).toContainText(
      '切换模式会自动切换会话。旧会话进度已自动保存。',
    )

    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(page).toHaveURL(/\?direction=en_to_zh$/)
    await expect(dialog).toHaveCount(0)

    let settings = await (await request.get('/api/settings')).json()
    expect(
      settings.find(
        (item: { key: string }) =>
          item.key === 'suppress_direction_switch_warning',
      )?.value,
    ).not.toBe('1')

    await byTid(page, TID.direction.zhToEnButton).click()
    await byTid(page, TID.direction.suppressCheckbox).check()
    await byTid(page, TID.direction.confirmButton).click()

    await expect(page).toHaveURL(/\?direction=zh_to_en$/)
    await expect(source).toHaveValue('目标方向中已保存的草稿')
    settings = await (await request.get('/api/settings')).json()
    expect(
      settings.find(
        (item: { key: string }) =>
          item.key === 'suppress_direction_switch_warning',
      )?.value,
    ).toBe('1')
    const oldDraft = await (
      await request.get('/api/workspace-drafts/en_to_zh')
    ).json()
    expect(oldDraft.sourceText).toBe('Switching must save this draft.')

    await page.reload()
    await byTid(page, TID.translate.sourceInput).waitFor()
    await byTid(page, TID.direction.enToZhButton).click()
    await expect(page).toHaveURL(/\?direction=en_to_zh$/)
    await expect(byTid(page, TID.direction.warningDialog)).toHaveCount(0)
  })

  test('opening history session synchronizes its frozen direction without warning', async ({
    page,
    request,
  }) => {
    const catalog = await (
      await request.get('/api/agent-catalog?direction=zh_to_en')
    ).json()
    const response = await request.post('/api/sessions', {
      data: {
        sourceText: '山中相送罢',
        direction: 'zh_to_en',
        taskBrief: 'Preserve the restrained tone.',
        reviewMode: 'main_editor',
        allowedAgentVariantIds: catalog.variants
          .slice(0, 2)
          .map((variant: { id: string }) => variant.id),
      },
    })
    expect(response.status()).toBe(200)
    const session = await response.json()

    await page.goto(`/?session=${session.id}`)

    await expect(byTid(page, TID.direction.zhToEnButton)).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(byTid(page, TID.direction.warningDialog)).toHaveCount(0)
    await expect(byTid(page, TID.translate.sourceInput)).toHaveValue('山中相送罢')
  })
})
