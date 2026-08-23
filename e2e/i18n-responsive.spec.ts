import { expect, test } from '@playwright/test'

test.describe('i18n hydration and narrow configuration layout', () => {
  test('reopens Chinese server markup with a persisted English locale without recovery', async ({ page }) => {
    const serverResponse = await page.request.get('/')
    expect(serverResponse.ok()).toBe(true)
    expect(await serverResponse.text()).toContain('正在恢复工作台……')

    await page.addInitScript(() => {
      window.localStorage.setItem('ui_locale', 'en')
    })
    await page.route('**/api/settings', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: route.request().method() === 'GET'
          ? JSON.stringify([{ key: 'ui_locale', value: 'en' }])
          : JSON.stringify({}),
      })
    })
    const recoverableErrors: string[] = []
    page.on('pageerror', (error) => recoverableErrors.push(error.message))

    await page.goto('/')
    await expect(page.getByTestId('locale-en')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')

    // A fresh document with the same browser storage reproduces the Electron
    // reopen path: SSR remains Chinese and English is restored after hydration.
    await page.reload()
    await expect(page.getByTestId('locale-en')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')

    expect(recoverableErrors.filter((message) => (
      message.includes('Hydration failed') || message.includes('hydration mismatch')
    ))).toEqual([])
  })

  test('keeps the English configuration page inside a 330px viewport', async ({ page }) => {
    await page.setViewportSize({ width: 330, height: 720 })
    await page.addInitScript(() => {
      window.localStorage.setItem('ui_locale', 'en')
    })
    await page.route('**/api/settings', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: route.request().method() === 'GET'
          ? JSON.stringify([{ key: 'ui_locale', value: 'en' }])
          : JSON.stringify({}),
      })
    })

    await page.goto('/config')
    await expect(page.getByTestId('locale-en')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('direction-settings-actions')).toBeVisible()

    const metrics = await page.evaluate(() => {
      const describeElement = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect()
        return {
          tag: element.tagName,
          className: element.className,
          text: element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 120),
          left: rect.left,
          right: rect.right,
          width: rect.width,
          parentClassName: element.parentElement?.className,
        }
      }
      const visibleElements = Array.from(document.body.querySelectorAll<HTMLElement>('*'))
        .filter((element) => {
          const rect = element.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        })

      return {
        innerWidth: window.innerWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        actionRight: document
          .querySelector('[data-testid="direction-settings-actions"]')
          ?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY,
        workflowActionsRight: document
          .querySelector('[data-testid="first-run-workflow-actions"]')
          ?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY,
        offenders: visibleElements
          .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 0.5)
          .slice(0, 12)
          .map(describeElement),
      }
    })

    expect(metrics.innerWidth).toBe(330)
    expect(
      metrics.documentScrollWidth,
      `Elements outside the viewport:\n${JSON.stringify(metrics.offenders, null, 2)}`,
    ).toBeLessThanOrEqual(metrics.innerWidth)
    expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.innerWidth)
    expect(metrics.actionRight).toBeLessThanOrEqual(metrics.innerWidth)
    expect(metrics.workflowActionsRight).toBeLessThanOrEqual(metrics.innerWidth)
  })

  test('reflows the configuration header at simulated 200 percent zoom', async ({ page }) => {
    await page.setViewportSize({ width: 780, height: 720 })
    await page.addInitScript(() => {
      window.localStorage.setItem('ui_locale', 'en')
    })
    await page.route('**/api/settings', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: route.request().method() === 'GET'
          ? JSON.stringify([{ key: 'ui_locale', value: 'en' }])
          : JSON.stringify({}),
      })
    })

    await page.goto('/config')
    await expect(page.getByTestId('locale-en')).toHaveAttribute('aria-pressed', 'true')
    await page.evaluate(() => {
      document.documentElement.style.zoom = '2'
    })

    const metrics = await page.evaluate(() => {
      const visibleElements = Array.from(document.body.querySelectorAll<HTMLElement>('*'))
        .filter((element) => {
          const rect = element.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        })
      const topNav = document.querySelector<HTMLElement>('.top-nav-shell')
      const compatibilityFields = document.querySelector<HTMLElement>(
        '[data-testid="compatibility-model-fields"]',
      )

      return {
        innerWidth: window.innerWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        topNavRight: topNav?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY,
        compatibilityFieldsRight:
          compatibilityFields?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY,
        offenders: visibleElements
          .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 0.5)
          .slice(0, 12)
          .map((element) => {
            const rect = element.getBoundingClientRect()
            return {
              tag: element.tagName,
              className: element.className,
              text: element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 120),
              left: rect.left,
              right: rect.right,
              width: rect.width,
            }
          }),
      }
    })

    expect(metrics.innerWidth).toBe(780)
    expect(
      metrics.documentScrollWidth,
      `Elements outside the zoomed viewport:\n${JSON.stringify(metrics.offenders, null, 2)}`,
    ).toBeLessThanOrEqual(metrics.innerWidth)
    expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.innerWidth)
    expect(metrics.topNavRight).toBeLessThanOrEqual(metrics.innerWidth)
    expect(metrics.compatibilityFieldsRight).toBeLessThanOrEqual(metrics.innerWidth)
  })
})
