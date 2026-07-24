import { expect, test } from '@playwright/test'
import { TID } from '../src/lib/testids'
import { byTid, evidenceScreenshot, resetDb } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetDb(request)
  const endpoint = await request.post('/api/endpoints', {
    data: {
      name: 'Visual Mock',
      base_url:
        process.env.E2E_MOCK_LLM_URL ?? 'http://localhost:41099',
      api_key: 'sk-visual',
    },
  })
  expect(endpoint.status()).toBe(201)
})

test.describe('paper-and-ink responsive shell', () => {
  test('desktop workbench preserves the two-column shell and design tokens', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto('/?direction=en_to_zh')
    await byTid(page, TID.translate.sourceInput).waitFor()

    const tokens = await page.evaluate(() => {
      const styles = getComputedStyle(document.documentElement)
      return {
        paper: styles.getPropertyValue('--color-paper').trim(),
        ink: styles.getPropertyValue('--color-ink').trim(),
        line: styles.getPropertyValue('--color-line').trim(),
        radius: styles.getPropertyValue('--radius-sm').trim(),
      }
    })
    expect(tokens).toMatchObject({
      paper: '#f7f4ec',
      ink: '#1c1a15',
      line: '#e3ddcb',
    })
    expect(Number.parseFloat(tokens.radius)).toBe(0.25)
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true)
    await evidenceScreenshot(page, 'visual-desktop-workbench')
  })

  test('mobile shell keeps navigation and both direction controls usable', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/?direction=zh_to_en')
    await byTid(page, TID.translate.sourceInput).waitFor()

    await expect(byTid(page, TID.direction.enToZhButton)).toBeVisible()
    await expect(byTid(page, TID.direction.zhToEnButton)).toBeVisible()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true)
    await evidenceScreenshot(page, 'visual-mobile-workbench')
  })
})
