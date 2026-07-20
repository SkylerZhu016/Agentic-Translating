// ---------------------------------------------------------------------------
// E2E: card-centering.spec.ts
//
// Covers:
//   - /config page grid container has mx-auto (cards horizontally centered)
//   - /history page container has mx-auto
//
// The config page renders <ConfigPanels> whose inner card grid uses
//   className="mx-auto grid max-w-3xl grid-cols-1 gap-5"
// The history page wraps its card container with
//   className="mx-auto max-w-3xl"
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

    // The inner card container has classes "mx-auto max-w-3xl".
    const container = page.locator('div.mx-auto.max-w-3xl').first()
    await expect(container).toBeVisible()

    const className = await container.getAttribute('class')
    expect(className, 'history container must have mx-auto').toContain('mx-auto')
    expect(className, 'history container must have max-w-3xl').toContain('max-w-3xl')
  })
})
