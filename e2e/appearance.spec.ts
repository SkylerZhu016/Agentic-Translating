import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'

const KEY = 'agentic-translating.appearance.v1'
const OUT = process.env.ACCEPTANCE_EVIDENCE_DIR ?? path.join(process.cwd(), '.omo', 'evidence', 'appearance')
const THEMES = ['blue', 'violet', 'coral', 'graphite'] as const

test.use({ viewport: { width: 1440, height: 1000 } })
test.beforeAll(async () => { await fs.mkdir(OUT, { recursive: true }) })

async function openAppearance(page: Page) {
  await page.goto('/config#appearance')
  await expect(page.getByTestId('appearance-panel')).toBeVisible()
}
async function choose(page: Page, theme: typeof THEMES[number]) {
  await page.getByTestId('appearance-theme-' + theme).locator('..').click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', theme)
}
async function colors(page: Page) {
  return page.evaluate(() => {
    const style = getComputedStyle(document.documentElement)
    return Object.fromEntries(['pine', 'moss', 'paper', 'paper-raise', 'paper-sink'].map(k => [k, style.getPropertyValue('--color-' + k).trim()]))
  })
}
function contrast(a: string, b: string) {
  const lum = (hex: string) => {
    const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722
  }
  const x = lum(a), y = lum(b)
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05)
}
async function stableScreenshot(page: Page, name: string) {
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined))); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))) })
  await page.screenshot({ path: path.join(OUT, name), fullPage: true })
}

test('Appearance themes apply immediately, preserve per-theme custom colors and survive reload', async ({ page, context }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await page.addInitScript(() => localStorage.setItem('ui_locale', 'zh-CN'))
  await openAppearance(page)
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'blue')
  const report: Array<{ theme: string; colors: Record<string, string>; ratios: number[] }> = []
  for (const theme of THEMES) {
    await choose(page, theme)
    const before = await colors(page)
    const ratios = ['#FFFFFF', before.paper, before['paper-raise'], before['paper-sink']].map(bg => contrast(before.pine, bg))
    expect(Math.min(...ratios)).toBeGreaterThanOrEqual(4.5)
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-appearance', theme)
    expect(await colors(page)).toEqual(before)
    report.push({ theme, colors: before, ratios })
    await stableScreenshot(page, 'appearance-' + theme + '.png')
  }
  await choose(page, 'blue')
  const input = page.getByTestId('appearance-accent-hex')
  await input.fill('#123'); await input.press('Enter')
  await expect(input).toHaveValue('#112233')
  await choose(page, 'coral')
  await input.fill('#654321'); await input.press('Tab')
  await choose(page, 'blue'); await expect(input).toHaveValue('#112233')
  await choose(page, 'coral'); await expect(input).toHaveValue('#654321')
  await page.getByTestId('appearance-reset-accent').click()
  await choose(page, 'blue'); await expect(input).toHaveValue('#112233')
  const second = await context.newPage()
  await openAppearance(second)
  await choose(page, 'violet')
  await expect(second.locator('html')).toHaveAttribute('data-appearance', 'violet')
  await second.close()
  await fs.writeFile(path.join(OUT, 'appearance-theme-contrast.json'), JSON.stringify({ report, perThemeColorsPreserved: true, resetAffectsOnlyCurrent: true, crossTabSync: true, consoleErrors: errors }, null, 2))
  expect(errors).toEqual([])
})

test('Appearance hex validation, extreme-color contrast, keyboard and narrow layout', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ui_locale', 'zh-CN'))
  await openAppearance(page)
  const panel = page.getByTestId('appearance-panel')
  const input = page.getByTestId('appearance-accent-hex')
  const valid = await input.inputValue()
  await input.fill('#1')
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await input.press('Tab')
  await expect(input).toHaveAttribute('aria-invalid', 'true')
  await expect(panel.getByRole('alert')).toBeVisible()
  const validCss = (await colors(page)).pine
  await input.focus(); await input.press('Escape')
  await expect(input).toHaveValue(valid)
  await expect(panel.getByRole('alert')).toHaveCount(0)
  expect((await colors(page)).pine).toBe(validCss)
  const extremes: Array<{ requested: string; effective: string; ratios: number[] }> = []
  for (const color of ['#FFFFFF', '#000000', '#FFFF00', '#F0F']) {
    await input.fill(color); await input.press('Enter')
    const actual = await colors(page)
    const ratios = ['#FFFFFF', actual.paper, actual['paper-raise'], actual['paper-sink']].map(bg => contrast(actual.pine, bg))
    expect(Math.min(...ratios)).toBeGreaterThanOrEqual(4.5)
    extremes.push({ requested: color, effective: actual.pine, ratios })
  }
  await choose(page, 'blue')
  await page.getByTestId('appearance-theme-blue').focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'violet')
  await page.keyboard.press('ArrowLeft')
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'blue')
  await page.getByTestId('appearance-reset-accent').click()
  await stableScreenshot(page, 'appearance-settings-default-blue-1440.png')
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  await stableScreenshot(page, 'appearance-settings-390.png')
  await fs.writeFile(path.join(OUT, 'appearance-extreme-colors.json'), JSON.stringify({ extremes, keyboardRadioNavigation: true, narrowHorizontalOverflow: false }, null, 2))
})

test('Appearance malformed storage recovers and blocked storage stays usable', async ({ browser }) => {
  for (const mode of ['malformed', 'blocked'] as const) {
    const context = await browser.newContext({ baseURL: 'http://localhost:' + (process.env.E2E_PORT ?? 3100), locale: 'zh-CN', viewport: { width: 390, height: 844 } })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    await page.addInitScript(({ key, mode }) => {
      if (mode === 'malformed') localStorage.setItem(key, '{broken-json')
      else Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Storage blocked for acceptance', 'SecurityError') } })
    }, { key: KEY, mode })
    await openAppearance(page)
    await expect(page.locator('html')).toHaveAttribute('data-appearance', 'blue')
    await choose(page, 'coral')
    if (mode === 'blocked') await expect(page.getByTestId('appearance-save-status')).toHaveClass(/text-cinnabar/)
    expect(errors).toEqual([])
    await stableScreenshot(page, 'appearance-storage-' + mode + '.png')
    await context.close()
  }
})

test('Appearance saved theme is applied before the first rendered frame', async ({ page }) => {
  await page.addInitScript(({ key }) => {
    localStorage.setItem(key, JSON.stringify({ version: 1, themeId: 'violet', accents: { violet: '#123ABC' } }))
    requestAnimationFrame(() => { (window as any).__appearanceFirstFrame = { theme: document.documentElement.dataset.appearance, accent: getComputedStyle(document.documentElement).getPropertyValue('--color-pine').trim() } })
  }, { key: KEY })
  await openAppearance(page)
  await expect.poll(() => page.evaluate(() => (window as any).__appearanceFirstFrame)).toBeTruthy()
  const first = await page.evaluate(() => (window as any).__appearanceFirstFrame)
  expect(first.theme).toBe('violet')
  expect(first.accent).toBe((await colors(page)).pine)
  await fs.writeFile(path.join(OUT, 'appearance-first-frame.json'), JSON.stringify({ firstFrame: first, hydratedTheme: await page.locator('html').getAttribute('data-appearance'), matchedHydratedAccent: true }, null, 2))
})
