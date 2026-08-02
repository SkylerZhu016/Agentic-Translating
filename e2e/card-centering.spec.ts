// ---------------------------------------------------------------------------
// E2E: card-centering.spec.ts
//
// Covers:
//   - /config page grid container has mx-auto (cards horizontally centered)
//   - /history page container has mx-auto
//
// The config page renders <ConfigPanels> whose inner card grid uses
//   className="mx-auto grid max-w-3xl grid-cols-1 gap-5"
// The history page wraps its wider history card with
//   className="mx-auto max-w-5xl"
//
// No data-testid attributes exist on these containers, so we select by CSS
// class combination (div.mx-auto.max-w-3xl) and verify the class attribute
// contains "mx-auto".
// ---------------------------------------------------------------------------

import { test, expect } from '@playwright/test'
import { TID } from '../src/lib/testids'
import { resetDb, byTid } from './helpers'

test.beforeEach(async ({ request }) => {
  // /config page loads endpoints/agents/etc from DB; reset to clean baseline
  // so the page reaches the loaded (non-skeleton) state quickly.
  await resetDb(request)
})

test.describe('Card centering — mx-auto on grid containers', () => {
  test('/config page grid container has mx-auto', async ({ page }) => {
    await page.goto('/config')

    // Wait for the config panels to finish loading — the add-endpoint button
    // only appears once the loaded (non-skeleton) state is rendered.
    await byTid(page, TID.endpoint.addButton).first().waitFor({ state: 'visible' })

    // The inner card grid container has classes "mx-auto grid max-w-3xl
    // grid-cols-1 gap-5". Select by the distinctive class combination.
    const gridContainer = page.locator('div.mx-auto.max-w-3xl.grid').first()
    await expect(gridContainer).toBeVisible()

    // Explicitly assert the class attribute contains mx-auto (human-readable
    // regression guard against accidental removal of the centering class).
    const className = await gridContainer.getAttribute('class')
    expect(className, 'config grid container must have mx-auto').toContain('mx-auto')
    expect(className, 'config grid container must have max-w-3xl').toContain('max-w-3xl')
  })

  test('/history page container has mx-auto', async ({ page }) => {
    await page.goto('/history')

    // The /history page is a server component with no async data fetch, so the
    // card container is rendered immediately. Wait for the page header to be
    // visible as a navigation-completion sentinel. Use exact:true to match
    // only the h1 "历史", not the h2 "历史会话" card title.
    await expect(page.getByRole('heading', { name: '历史', exact: true })).toBeVisible({
      timeout: 10_000,
    })

    // The inner history card container has classes "mx-auto max-w-5xl".
    const container = page.locator('div.mx-auto.max-w-5xl').first()
    await expect(container).toBeVisible()

    const className = await container.getAttribute('class')
    expect(className, 'history container must have mx-auto').toContain('mx-auto')
    expect(className, 'history container must have max-w-5xl').toContain('max-w-5xl')
  })

  test('default model role controls stay inside their card', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 900 })
    await page.goto('/config')
    await byTid(page, TID.endpoint.addButton).first().waitFor({ state: 'visible' })

    const panel = page.locator('details').filter({ hasText: '默认模型分工' }).first()
    await expect(panel).toBeVisible()
    const panelBox = await panel.boundingBox()
    expect(panelBox).not.toBeNull()

    const controls = [
      ...await panel.locator('select').all(),
      ...await panel.getByRole('button', { name: '刷新', exact: true }).all(),
      ...await panel.getByRole('button', { name: '手动', exact: true }).all(),
      ...await panel.getByRole('button', { name: '测试', exact: true }).all(),
      panel.getByRole('button', { name: '保存默认分工', exact: true }),
    ]
    expect(controls.length).toBeGreaterThanOrEqual(29)
    for (const control of controls) {
      const box = await control.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(panelBox!.x - 1)
      expect(box!.x + box!.width).toBeLessThanOrEqual(
        panelBox!.x + panelBox!.width + 1,
      )
    }

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(1)
  })

  test('model pickers wrap inside the card at a narrow desktop width', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 900 })
    await page.goto('/config')
    await byTid(page, TID.endpoint.addButton).first().waitFor({ state: 'visible' })

    const panel = page.locator('details').filter({ hasText: '默认模型分工' }).first()
    const panelBox = await panel.boundingBox()
    expect(panelBox).not.toBeNull()

    for (const control of await panel.locator('select, button').all()) {
      const box = await control.boundingBox()
      if (!box) continue
      expect(box.x).toBeGreaterThanOrEqual(panelBox!.x - 1)
      expect(box.x + box.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width + 1)
    }

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(1)
  })
})
