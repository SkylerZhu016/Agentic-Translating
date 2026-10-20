// Isolated browser acceptance. Run: node test/ui/output-budget.browser.mjs
// Bundles only UI components, mocks every fetch and blocks all browser network.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'
import { chromium, expect } from '@playwright/test'
import postcss from 'postcss'
import tailwindcss from '@tailwindcss/postcss'

const root = process.cwd()
const output = path.join(root, '.tmp', 'output-budget-ui')
await fs.mkdir(output, { recursive: true })
const bundle = await build({
  entryPoints: ['test/ui/fixtures/output-budget-app.tsx'],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{
    name: 'offline-ui',
    setup(builder) {
      builder.onResolve({ filter: /^next\/(navigation|link)$/ }, ({ path: specifier }) => ({ path: specifier, namespace: 'offline-ui' }))
      builder.onResolve({ filter: /components\/direction\/DirectionProvider$/ }, () => ({ path: 'direction', namespace: 'offline-ui' }))
      builder.onLoad({ filter: /.*/, namespace: 'offline-ui' }, ({ path: specifier }) => ({
        contents: specifier === 'next/navigation'
          ? `export const usePathname = () => '/config'`
          : specifier === 'direction'
            ? `export const useDirection = () => ({direction:'en_to_zh'})`
            : `import {createElement} from 'react'; export default function Link(p){ return createElement('a', p) }`,
        loader: 'js',
        resolveDir: root,
      }))
    },
  }],
})

const cssPath = path.join(root, 'app', 'globals.css')
const { css } = await postcss([tailwindcss({ base: root })]).process(
  await fs.readFile(cssPath, 'utf8'),
  { from: cssPath },
)
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } })
await context.route('**/*', (route) => route.abort())
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const budget = (role) => page.getByRole('textbox', { name: `${role}输出预算（token）`, exact: true })
const report = {
  profile: {},
  preset: {},
  screenshots: {
    desktop: path.join(output, 'profile.png'),
    mobile: path.join(output, 'profile-mobile.png'),
    preset: path.join(output, 'preset.png'),
    presetRoles: path.join(output, 'preset-roles.png'),
    presetMobile: path.join(output, 'preset-mobile.png'),
  },
}
const deepSeekHint = page.getByText('DeepSeek 长思考可尝试 32768，具体以所选模型支持的上限为准。', { exact: true })

try {
  await page.setContent('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>')
  if (css) await page.addStyleTag({ content: css })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.getByText('默认模型分工', { exact: true }).click()
  // Read labels from the actual UI, keeping this test compatible with role-name translations.
  const fields = page.getByRole('textbox', { name: /输出预算（token）$/ })
  await expect(fields).toHaveCount(7)
  const labels = await fields.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label').replace('输出预算（token）', '')))
  for (let index = 0; index < labels.length; index++) {
    await expect(budget(labels[index])).toHaveValue(String(8192 + index))
    await budget(labels[index]).fill(String(32768 + index))
  }
  const defaultModel = page.getByRole('combobox', { name: `${labels[0]}模型`, exact: true })
  const defaultEndpoint = page.getByRole('combobox', { name: `${labels[0]}端点`, exact: true })
  await defaultEndpoint.selectOption('2')
  await defaultModel.selectOption('deepseek-reasoner')
  await expect(budget(labels[0])).toHaveValue('32768')

  const saveProfile = page.getByRole('button', { name: '保存默认分工', exact: true })
  for (const value of ['0', '-1', '1.5', '1e4', 'invalid', '9007199254740992']) {
    await budget(labels[1]).fill(value)
    await expect(saveProfile).toBeDisabled()
    await expect(budget(labels[1])).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByRole('alert').filter({ hasText: '请输入大于 0 的整数' })).toBeVisible()
  }
  await budget(labels[1]).fill('32769')
  await budget(labels[6]).fill('')
  await saveProfile.click()
  await expect.poll(() => page.evaluate(() => window.__outputBudgetHarness.notifications.includes('默认模型分工已保存'))).toBe(true)
  const saved = await page.evaluate(() => window.__outputBudgetHarness.profile)
  const savedRoles = Object.values(saved)
  assert.deepEqual(savedRoles.map((binding) => binding.maxOutputTokens), [32768, 32769, 32770, 32771, 32772, 32773, null])
  assert.equal(saved.defaultWorker.endpointId, 2)
  assert.equal(saved.defaultWorker.contextWindow, 256000)
  assert.equal(saved.defaultWorker.model, 'deepseek-reasoner')
  await page.evaluate(() => window.__outputBudgetHarness.remount())
  await page.getByText('默认模型分工', { exact: true }).click()
  for (let index = 0; index < labels.length; index++) {
    await expect(budget(labels[index])).toHaveValue(index === 6 ? '' : String(32768 + index))
  }
  await expect(deepSeekHint).toHaveCount(1)
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: report.screenshots.mobile, fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1080 })
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: report.screenshots.desktop, fullPage: true })
  const modelBox = await defaultModel.boundingBox()
  const budgetBox = await budget(labels[0]).boundingBox()
  const nextBudgetBox = await budget(labels[1]).boundingBox()
  const modelBudgetGap = budgetBox.y - modelBox.y - modelBox.height
  assert.ok(modelBudgetGap >= 0 && modelBudgetGap <= 8)
  report.profile = {
    roleCount: 7, saveReload: 'passed', endpointSwitch: 'passed', invalidInputs: 6,
    blankAsNull: 'passed', mobileOverflow: 'passed', sharedHintCount: 1,
    modelBudgetGap, roleRowSpacing: nextBudgetBox.y - budgetBox.y,
    saveButtonY: (await saveProfile.boundingBox()).y,
  }

  await page.getByRole('button', { name: '预设配置', exact: true }).click()
  await page.getByRole('button', { name: '新建预设', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByPlaceholder('预设名称').fill('Offline output budgets')
  await dialog.getByRole('combobox', { name: '正式翻译模型', exact: true }).selectOption('deepseek-chat')
  await budget('正式翻译模型').fill('32768')
  for (const [label, value] of [['前置分析模型 A（可选）', '16384'], ['前置分析模型 B（可选）', '24576']]) {
    await dialog.getByRole('combobox', { name: label, exact: true }).selectOption('deepseek-chat')
    await budget(label).fill(value)
  }
  const roleEndpointSelectors = dialog.getByRole('combobox', { name: /端点$/ })
  await expect(roleEndpointSelectors).toHaveCount(6)
  const presetLabels = await roleEndpointSelectors.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label').replace('端点', '')))
  for (let index = 0; index < presetLabels.length; index++) {
    const label = presetLabels[index]
    await dialog.getByRole('combobox', { name: `${label}端点`, exact: true }).selectOption('1')
    await dialog.getByRole('combobox', { name: `${label}模型`, exact: true }).selectOption('deepseek-chat')
    await budget(label).fill(String(40000 + index))
  }
  const initialSave = dialog.getByRole('button', { name: '保存 revision 1', exact: true })
  await budget('前置分析模型 B（可选）').fill('-9')
  await expect(initialSave).toBeDisabled()
  await budget('前置分析模型 B（可选）').fill('24576')
  await dialog.getByRole('combobox', { name: '前置分析模型 A（可选）', exact: true }).selectOption('other-model')
  await expect(budget('前置分析模型 A（可选）')).toHaveValue('16384')
  await dialog.getByRole('combobox').first().selectOption('2')
  await dialog.getByRole('combobox', { name: '正式翻译模型', exact: true }).selectOption('deepseek-reasoner')
  await dialog.getByRole('combobox', { name: '前置分析模型 A（可选）', exact: true }).selectOption('other-model')
  await dialog.getByRole('combobox', { name: '前置分析模型 B（可选）', exact: true }).selectOption('deepseek-chat')
  await expect(budget('正式翻译模型')).toHaveValue('32768')
  await expect(budget('前置分析模型 A（可选）')).toHaveValue('16384')
  await expect(budget('前置分析模型 B（可选）')).toHaveValue('24576')
  await dialog.getByRole('combobox', { name: `${presetLabels[0]}端点`, exact: true }).selectOption('2')
  await dialog.getByRole('combobox', { name: `${presetLabels[0]}模型`, exact: true }).selectOption('deepseek-reasoner')
  await expect(budget(presetLabels[0])).toHaveValue('40000')
  await expect(deepSeekHint).toHaveCount(1)
  assert.equal(await dialog.locator('[data-modal-scroll-region]').evaluate((element) => element.scrollWidth <= element.clientWidth), true)
  await dialog.locator('[data-modal-scroll-region]').evaluate((element) => { element.scrollTop = 0 })
  await page.screenshot({ path: report.screenshots.preset })
  await budget(presetLabels.at(-1)).scrollIntoViewIfNeeded()
  await page.screenshot({ path: report.screenshots.presetRoles })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await dialog.locator('[data-modal-scroll-region]').evaluate((element) => element.scrollWidth <= element.clientWidth), true)
  await dialog.locator('[data-modal-scroll-region]').evaluate((element) => { element.scrollTop = 0 })
  await page.screenshot({ path: report.screenshots.presetMobile })
  await page.setViewportSize({ width: 1440, height: 1080 })
  await initialSave.click()
  await expect(dialog).not.toBeVisible()
  const created = await page.evaluate(() => window.__outputBudgetHarness.requests.find((request) => request.path === '/api/workflow-presets' && request.method === 'POST')?.body)
  assert.equal(created.contract.defaultWorkerBinding.maxOutputTokens, 32768)
  assert.equal(created.contract.defaultWorkerBinding.endpointId, 2)
  assert.deepEqual(created.contract.contextAnalysisBindings.map((binding) => binding.maxOutputTokens), [16384, 24576])
  assert.deepEqual(created.contract.contextAnalysisBindings.map((binding) => binding.endpointId), [2, 2])
  const executionKeys = ['mainAgentBinding', 'reviewAgentBinding', 'filterAgentBinding', 'orchestrateAgentBinding', 'assembleAgentBinding', 'editingAgentBinding']
  assert.deepEqual(executionKeys.map((key) => created.contract[key].maxOutputTokens), [40000, 40001, 40002, 40003, 40004, 40005])
  assert.equal(created.contract.mainAgentBinding.endpointId, 2)
  await page.getByRole('button', { name: 'revisions', exact: true }).click()
  await page.getByRole('button', { name: '恢复为新 revision', exact: true }).first().click()
  await expect.poll(() => page.evaluate(() => window.__outputBudgetHarness.presets[0].currentRevisionNo)).toBe(3)
  const restored = await page.evaluate(() => window.__outputBudgetHarness.revisions.at(-1).contract)
  assert.deepEqual(restored, created.contract)
  report.preset = { bindingCount: 9, createPayload: 'passed', analysisModelSwitch: 'passed', endpointSwitch: 'passed', invalidInput: 'passed', restoreRequest: 'passed', sharedHintCount: 1, desktopOverflow: 'passed', mobileOverflow: 'passed' }
  assert.deepEqual(errors, [])
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser.close()
}
