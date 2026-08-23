import { test, expect, type APIRequestContext } from '@playwright/test'
import { TID } from '../src/lib/testids'
import { byTid, resetDb } from './helpers'

const MOCK_URL = process.env.E2E_MOCK_LLM_URL ?? 'http://localhost:41099'
let presetFixtureSequence = 0

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

async function seedZhToEnPreset(
  request: APIRequestContext,
  options: {
    name?: string
    taskBriefTemplate?: string
    mainEditorRunMode?: 'fixed_pipeline' | 'tool_enabled'
  } = {},
) {
  const endpoints = await (await request.get('/api/endpoints')).json()
  const endpoint = endpoints[0] as { id: number }
  const catalogResponse = await request.get(
    '/api/agent-catalog?direction=zh_to_en',
  )
  expect(catalogResponse.status()).toBe(200)
  const catalog = await catalogResponse.json()
  const variants = catalog.variants.slice(0, 2)
  expect(variants).toHaveLength(2)
  const binding = {
    endpointId: endpoint.id,
    model: 'direction-preset-model',
    contextWindow: 128000,
  }
  const response = await request.post('/api/workflow-presets', {
    data: {
      name:
        options.name ??
        `中译英草稿竞态回归预设-${++presetFixtureSequence}`,
      description: '',
      direction: 'zh_to_en',
      contract: {
        sourceLang: '中文',
        targetLang: '英文',
        taskBriefTemplate:
          options.taskBriefTemplate ??
          'Preserve the selected preset across locale changes.',
        teamPolicy: 'fixed',
        reviewMode: 'main_editor',
        mainEditorRunMode: options.mainEditorRunMode ?? 'fixed_pipeline',
        agentVariantIds: variants.map((variant: { id: string }) => variant.id),
        agentVariantSnapshots: variants,
        defaultWorkerBinding: binding,
        agentBindingOverrides: {},
        mainAgentBinding: binding,
        editingAgentBinding: binding,
        promptBundleVersion: 1,
        maxAgentCalls: 5,
        batchConcurrency: 2,
        constraints: {},
      },
    },
  })
  expect(response.status()).toBe(201)
  const payload = await response.json()
  return {
    presetId: payload.preset.id as string,
    revisionId: payload.revision.id as string,
  }
}

async function seedModelProfile(
  request: APIRequestContext,
  direction: 'en_to_zh' | 'zh_to_en',
) {
  const endpoints = await (await request.get('/api/endpoints')).json()
  const endpoint = endpoints[0] as { id: number }
  const binding = {
    endpointId: endpoint.id,
    model: 'direction-history-model',
    contextWindow: 128000,
    maxOutputTokens: 4096,
  }
  const response = await request.put(`/api/model-profiles/${direction}`, {
    data: {
      defaultWorker: binding,
      mainAgent: binding,
      editingAgent: binding,
    },
  })
  expect(response.status()).toBe(200)
}

test.beforeEach(async ({ request, page }) => {
  presetFixtureSequence = 0
  await resetDb(request)
  await seedEndpoint(request)
  const locale = await request.put('/api/settings', {
    data: { key: 'ui_locale', value: 'zh-CN' },
  })
  expect(locale.status()).toBe(200)
  await page.addInitScript(() => {
    window.localStorage.setItem('ui_locale', 'zh-CN')
  })
})

test.describe('bidirectional workspace switching', () => {
  test('blank workspace switches immediately without a warning', async ({
    page,
  }) => {
    await page.goto('/')
    await byTid(page, TID.translate.sourceInput).waitFor()

    await byTid(page, TID.direction.zhToEnButton).click()

    await expect(page).toHaveURL(/\?direction=zh_to_en(?:&fresh=1)?$/)
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

    await expect(page).toHaveURL(/\?direction=zh_to_en&fresh=1$/)
    await expect(source).toHaveValue('')
    await expect(byTid(page, TID.translate.draftRestoreButton)).toBeVisible()
    await byTid(page, TID.translate.draftRestoreButton).click()
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
    await expect(page).toHaveURL(/\?direction=en_to_zh(?:&fresh=1)?$/)
    await expect(byTid(page, TID.direction.warningDialog)).toHaveCount(0)
  })

  test('fresh recovery preserves settings-only drafts until restore or ignore resolves them', async ({
    page,
    request,
  }) => {
    const preset = await seedZhToEnPreset(request)
    const catalog = await (
      await request.get('/api/agent-catalog?direction=zh_to_en')
    ).json()
    const allowedAgentVariantIds = catalog.variants.map(
      (variant: { id: string }) => variant.id,
    )
    const savedDraft = {
      sourceText: '',
      taskBrief: '',
      selectedProjectId: null,
      selectedPresetRevisionId: preset.revisionId,
      allowedAgentVariantIds,
      reviewMode: 'main_editor',
      mainEditorRunMode: 'tool_enabled',
      promptBundleRevisionId: null,
      constraints: {},
    }
    expect(
      (await request.put('/api/workspace-drafts/zh_to_en', {
        data: savedDraft,
      })).status(),
    ).toBe(200)

    await page.goto('/?direction=zh_to_en&fresh=1')
    const restore = byTid(page, TID.translate.draftRestoreButton)
    await expect(restore).toBeVisible()
    await expect(byTid(page, TID.translate.sourceInput)).toHaveValue('')

    // The previous regression overwrote the saved row after this debounce.
    await page.waitForTimeout(750)
    expect(
      (await (
        await request.get('/api/workspace-drafts/zh_to_en')
      ).json()).mainEditorRunMode,
    ).toBe('tool_enabled')

    await restore.click()
    await byTid(page, TID.translate.requirementsDetails).click()
    await expect(byTid(page, TID.translate.currentPreset)).toHaveValue(
      preset.presetId,
    )
    const toolMode = byTid(page, TID.translate.mainEditorToolMode)
    await expect(toolMode).toBeChecked()
    await byTid(page, TID.translate.mainEditorFixedMode).check()
    await expect.poll(async () => (
      await (await request.get('/api/workspace-drafts/zh_to_en')).json()
    ).mainEditorRunMode).toBe('fixed_pipeline')

    expect(
      (await request.put('/api/workspace-drafts/zh_to_en', {
        data: savedDraft,
      })).status(),
    ).toBe(200)
    await page.goto('/?direction=zh_to_en&fresh=1')
    let releaseIgnore!: () => void
    const ignoreGate = new Promise<void>((resolve) => {
      releaseIgnore = resolve
    })
    let ignoreStarted!: () => void
    const pendingIgnore = new Promise<void>((resolve) => {
      ignoreStarted = resolve
    })
    await page.route('**/api/workspace-drafts/zh_to_en', async (route) => {
      if (route.request().method() === 'PUT') {
        ignoreStarted()
        await ignoreGate
      }
      await route.continue()
    })
    const ignored = page.waitForResponse((response) =>
      response.url().includes('/api/workspace-drafts/zh_to_en') &&
      response.request().method() === 'PUT' &&
      response.ok(),
    )
    await byTid(page, TID.translate.draftIgnoreButton).click()
    await pendingIgnore
    await expect(byTid(page, TID.translate.sourceInput)).toBeDisabled()
    await byTid(page, TID.direction.enToZhButton).click({ force: true })
    await expect(page).toHaveURL(/\?direction=zh_to_en&fresh=1$/)
    await expect(byTid(page, TID.direction.warningDialog)).toHaveCount(0)
    releaseIgnore()
    await ignored
    await page.reload()
    await expect(byTid(page, TID.translate.draftRestoreButton)).toHaveCount(0)
    expect((
      await (await request.get('/api/workspace-drafts/zh_to_en')).json()
    ).mainEditorRunMode).toBe('fixed_pipeline')
  })

  test('a failed draft load pauses autosave until a successful retry', async ({
    page,
    request,
  }) => {
    expect((await request.put('/api/workspace-drafts/en_to_zh', {
      data: {
        sourceText: 'This persisted draft must survive a temporary read failure.',
        taskBrief: '',
        selectedPresetRevisionId: null,
        allowedAgentVariantIds: [],
        reviewMode: 'main_editor',
      },
    })).status()).toBe(200)

    let failReads = true
    let putCount = 0
    await page.route('**/api/workspace-drafts/en_to_zh', async (route) => {
      if (route.request().method() === 'GET' && failReads) {
        await route.fulfill({ status: 503, body: 'draft store unavailable' })
        return
      }
      if (route.request().method() === 'PUT') putCount += 1
      await route.continue()
    })

    await page.goto('/?direction=en_to_zh')
    await expect(byTid(page, TID.translate.draftLoadError)).toBeVisible()
    await page.waitForTimeout(750)
    expect(putCount).toBe(0)

    failReads = false
    await byTid(page, TID.translate.draftLoadRetry).click()
    await expect(byTid(page, TID.translate.sourceInput)).toHaveValue(
      'This persisted draft must survive a temporary read failure.',
    )
  })

  test('serialized autosaves keep the newest edit when the first request is slow', async ({
    page,
    request,
  }) => {
    const initialAutosave = page.waitForResponse((response) =>
      response.url().includes('/api/workspace-drafts/en_to_zh') &&
      response.request().method() === 'PUT' &&
      response.ok(),
    )
    await page.goto('/?direction=en_to_zh')
    const source = byTid(page, TID.translate.sourceInput)
    await source.waitFor()
    await initialAutosave

    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstStarted!: () => void
    const firstRequest = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    const savedBodies: Array<{ sourceText: string }> = []
    await page.route('**/api/workspace-drafts/en_to_zh', async (route) => {
      if (route.request().method() !== 'PUT') {
        await route.continue()
        return
      }
      savedBodies.push(JSON.parse(route.request().postData() ?? '{}'))
      if (savedBodies.length === 1) {
        firstStarted()
        await firstGate
      }
      await route.continue()
    })

    await source.fill('older edit')
    await firstRequest
    await source.fill('newest edit')
    await page.waitForTimeout(750)
    expect(savedBodies.map((body) => body.sourceText)).toEqual(['older edit'])

    releaseFirst()
    await expect.poll(() => savedBodies.map((body) => body.sourceText)).toEqual([
      'older edit',
      'newest edit',
    ])
    await expect.poll(async () => (
      await (await request.get('/api/workspace-drafts/en_to_zh')).json()
    ).sourceText).toBe('newest edit')
  })

  test('submission locks draft editing and direction changes through save and create', async ({
    page,
    request,
  }) => {
    await seedModelProfile(request, 'en_to_zh')
    const initialAutosave = page.waitForResponse((response) =>
      response.url().includes('/api/workspace-drafts/en_to_zh') &&
      response.request().method() === 'PUT' &&
      response.ok(),
    )
    await page.goto('/?direction=en_to_zh')
    await initialAutosave
    const source = byTid(page, TID.translate.sourceInput)
    await source.fill('Snapshot A must be the submitted source.')

    let releaseSave!: () => void
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve
    })
    let saveStarted!: () => void
    const pendingSave = new Promise<void>((resolve) => {
      saveStarted = resolve
    })
    await page.route('**/api/workspace-drafts/en_to_zh', async (route) => {
      if (route.request().method() === 'PUT') {
        saveStarted()
        await saveGate
      }
      await route.continue()
    })

    const sessionCreated = page.waitForResponse((response) =>
      response.url().endsWith('/api/sessions') &&
      response.request().method() === 'POST',
    )
    await byTid(page, TID.translate.translateButton).click()
    await pendingSave
    await expect(source).toBeDisabled()
    await byTid(page, TID.direction.zhToEnButton).click({ force: true })
    await expect(page).toHaveURL(/\?direction=en_to_zh$/)
    await expect(byTid(page, TID.direction.warningDialog)).toHaveCount(0)

    releaseSave()
    expect((await sessionCreated).status()).toBe(200)
    await expect(source).toHaveValue('Snapshot A must be the submitted source.')
  })

  test('preset revision lookup failures are visible after draft recovery', async ({
    page,
    request,
  }) => {
    const preset = await seedZhToEnPreset(request)
    const catalog = await (
      await request.get('/api/agent-catalog?direction=zh_to_en')
    ).json()
    expect((await request.put('/api/workspace-drafts/zh_to_en', {
      data: {
        sourceText: '',
        taskBrief: '',
        selectedPresetRevisionId: preset.revisionId,
        allowedAgentVariantIds: catalog.variants.map(
          (variant: { id: string }) => variant.id,
        ),
        reviewMode: 'main_editor',
      },
    })).status()).toBe(200)
    await page.route(`**/api/workflow-presets/${preset.presetId}`, (route) =>
      route.fulfill({ status: 503, body: 'preset store unavailable' }),
    )

    await page.goto('/?direction=zh_to_en&fresh=1')
    await byTid(page, TID.translate.draftRestoreButton).click()
    await expect(byTid(page, TID.translate.draftPresetLookupError)).toBeVisible()
  })

  test('a stale preset lookup cannot overwrite a later preset choice', async ({
    page,
    request,
  }) => {
    const firstPreset = await seedZhToEnPreset(request)
    const laterPreset = await seedZhToEnPreset(request)
    const catalog = await (
      await request.get('/api/agent-catalog?direction=zh_to_en')
    ).json()
    expect((await request.put('/api/workspace-drafts/zh_to_en', {
      data: {
        sourceText: '',
        taskBrief: '',
        selectedPresetRevisionId: firstPreset.revisionId,
        allowedAgentVariantIds: catalog.variants.map(
          (variant: { id: string }) => variant.id,
        ),
        reviewMode: 'main_editor',
      },
    })).status()).toBe(200)

    let releaseLookup!: () => void
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve
    })
    let lookupStarted!: () => void
    const pendingLookup = new Promise<void>((resolve) => {
      lookupStarted = resolve
    })
    await page.route(
      `**/api/workflow-presets/${firstPreset.presetId}`,
      async (route) => {
        lookupStarted()
        await lookupGate
        await route.continue()
      },
    )

    await page.goto('/?direction=zh_to_en&fresh=1')
    await byTid(page, TID.translate.draftRestoreButton).click()
    await pendingLookup
    await byTid(page, TID.translate.requirementsDetails).click()
    await byTid(page, TID.translate.currentPreset).selectOption(
      laterPreset.presetId,
    )
    await expect(byTid(page, TID.translate.currentPreset)).toHaveValue(
      laterPreset.presetId,
    )

    releaseLookup()
    await expect.poll(async () =>
      byTid(page, TID.translate.currentPreset).inputValue(),
    ).toBe(laterPreset.presetId)
    await expect(byTid(page, TID.translate.draftPresetLookupError)).toHaveCount(0)
  })

  test('rapid manual preset selections keep the latest contract and persisted revision', async ({
    page,
    request,
  }) => {
    const slowPreset = await seedZhToEnPreset(request, {
      name: '慢速预设 A',
      taskBriefTemplate: 'contract A',
      mainEditorRunMode: 'fixed_pipeline',
    })
    const latestPreset = await seedZhToEnPreset(request, {
      name: '快速预设 B',
      taskBriefTemplate: 'contract B',
      mainEditorRunMode: 'tool_enabled',
    })
    const initialAutosave = page.waitForResponse((response) =>
      response.url().includes('/api/workspace-drafts/zh_to_en') &&
      response.request().method() === 'PUT' &&
      response.ok(),
    )
    await page.goto('/?direction=zh_to_en')
    await initialAutosave
    await byTid(page, TID.translate.requirementsDetails).click()

    let releaseSlow!: () => void
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    let slowStarted!: () => void
    const pendingSlow = new Promise<void>((resolve) => {
      slowStarted = resolve
    })
    await page.route(
      `**/api/workflow-presets/${slowPreset.presetId}`,
      async (route) => {
        slowStarted()
        await slowGate
        await route.continue()
      },
    )

    const presetSelect = byTid(page, TID.translate.currentPreset)
    await presetSelect.selectOption(slowPreset.presetId)
    await pendingSlow
    await presetSelect.selectOption(latestPreset.presetId)
    await expect(presetSelect).toHaveValue(latestPreset.presetId)
    await expect.poll(async () => {
      const draft = await (
        await request.get('/api/workspace-drafts/zh_to_en')
      ).json()
      return {
        revision: draft.selectedPresetRevisionId,
        brief: draft.taskBrief,
        mode: draft.mainEditorRunMode,
      }
    }).toEqual({
      revision: latestPreset.revisionId,
      brief: 'contract B',
      mode: 'tool_enabled',
    })

    releaseSlow()
    await expect.poll(async () => {
      const draft = await (
        await request.get('/api/workspace-drafts/zh_to_en')
      ).json()
      return {
        revision: draft.selectedPresetRevisionId,
        brief: draft.taskBrief,
        mode: draft.mainEditorRunMode,
      }
    }).toEqual({
      revision: latestPreset.revisionId,
      brief: 'contract B',
      mode: 'tool_enabled',
    })
    await expect(presetSelect).toHaveValue(latestPreset.presetId)
  })

  test('a pending manual preset blocks direction switching and hybrid autosaves', async ({
    page,
    request,
  }) => {
    const slowPreset = await seedZhToEnPreset(request, {
      name: '方向锁定慢速预设',
      taskBriefTemplate: 'resolved preset contract',
      mainEditorRunMode: 'tool_enabled',
    })
    const initialAutosave = page.waitForResponse((response) =>
      response.url().includes('/api/workspace-drafts/zh_to_en') &&
      response.request().method() === 'PUT' &&
      response.ok(),
    )
    await page.goto('/?direction=zh_to_en')
    await initialAutosave
    await byTid(page, TID.translate.requirementsDetails).click()

    const savedBodies: Array<{
      taskBrief: string
      selectedPresetRevisionId: string | null
    }> = []
    await page.route('**/api/workspace-drafts/zh_to_en', async (route) => {
      if (route.request().method() === 'PUT') {
        const body = JSON.parse(route.request().postData() ?? '{}')
        savedBodies.push({
          taskBrief: body.taskBrief,
          selectedPresetRevisionId: body.selectedPresetRevisionId,
        })
      }
      await route.continue()
    })
    let releasePreset!: () => void
    const presetGate = new Promise<void>((resolve) => {
      releasePreset = resolve
    })
    let presetStarted!: () => void
    const pendingPreset = new Promise<void>((resolve) => {
      presetStarted = resolve
    })
    await page.route(
      `**/api/workflow-presets/${slowPreset.presetId}`,
      async (route) => {
        presetStarted()
        await presetGate
        await route.continue()
      },
    )

    await byTid(page, TID.translate.currentPreset).selectOption(
      slowPreset.presetId,
    )
    await pendingPreset
    await byTid(page, TID.direction.enToZhButton).click({ force: true })
    await expect(page).toHaveURL(/\?direction=zh_to_en$/)
    await expect(byTid(page, TID.direction.warningDialog)).toHaveCount(0)
    await page.waitForTimeout(750)
    expect(savedBodies).toEqual([])

    releasePreset()
    await expect.poll(() => savedBodies[savedBodies.length - 1]).toEqual({
      taskBrief: 'resolved preset contract',
      selectedPresetRevisionId: slowPreset.revisionId,
    })
    await byTid(page, TID.direction.enToZhButton).click()
    await expect(byTid(page, TID.direction.warningDialog)).toBeVisible()
  })

  test('failed preset recovery locks exit until continuing without a preset saves edits', async ({
    page,
    request,
  }) => {
    const failedPreset = await seedZhToEnPreset(request, {
      name: '需要显式恢复的失败预设',
    })
    const initialAutosave = page.waitForResponse((response) =>
      response.url().includes('/api/workspace-drafts/zh_to_en') &&
      response.request().method() === 'PUT' &&
      response.ok(),
    )
    await page.goto('/?direction=zh_to_en')
    await initialAutosave
    await byTid(page, TID.translate.requirementsDetails).click()

    const savedBodies: Array<{
      sourceText: string
      selectedPresetRevisionId: string | null
    }> = []
    await page.route('**/api/workspace-drafts/zh_to_en', async (route) => {
      if (route.request().method() === 'PUT') {
        const body = JSON.parse(route.request().postData() ?? '{}')
        savedBodies.push({
          sourceText: body.sourceText,
          selectedPresetRevisionId: body.selectedPresetRevisionId,
        })
      }
      await route.continue()
    })
    await page.route(
      `**/api/workflow-presets/${failedPreset.presetId}`,
      (route) => route.fulfill({ status: 503, body: 'preset unavailable' }),
    )

    await byTid(page, TID.translate.currentPreset).selectOption(
      failedPreset.presetId,
    )
    await expect(byTid(page, TID.translate.draftPresetLookupError)).toBeVisible()
    const source = byTid(page, TID.translate.sourceInput)
    await source.fill('错误恢复期间仍需保留的编辑')
    await byTid(page, TID.direction.enToZhButton).click({ force: true })
    await expect(page).toHaveURL(/\?direction=zh_to_en$/)
    await expect(byTid(page, TID.direction.warningDialog)).toHaveCount(0)
    await page.waitForTimeout(750)
    expect(savedBodies).toEqual([])

    await byTid(page, TID.translate.draftPresetContinueWithout).click()
    await expect(byTid(page, TID.translate.draftPresetLookupError)).toHaveCount(0)
    await expect.poll(() => savedBodies[savedBodies.length - 1]).toEqual({
      sourceText: '错误恢复期间仍需保留的编辑',
      selectedPresetRevisionId: null,
    })
    await byTid(page, TID.direction.enToZhButton).click()
    await expect(byTid(page, TID.direction.warningDialog)).toBeVisible()
    await byTid(page, TID.direction.confirmButton).click()
    await expect(page).toHaveURL(/\?direction=en_to_zh&fresh=1$/)
  })

  test('failed manual preset selection clears hidden revision before a valid submitted contract', async ({
    page,
    request,
  }) => {
    await seedModelProfile(request, 'zh_to_en')
    const failedPreset = await seedZhToEnPreset(request, {
      name: '读取失败预设',
      taskBriefTemplate: 'must never submit',
    })
    const validPreset = await seedZhToEnPreset(request, {
      name: '有效提交预设',
      taskBriefTemplate: 'valid submitted contract',
      mainEditorRunMode: 'tool_enabled',
    })
    const initialAutosave = page.waitForResponse((response) =>
      response.url().includes('/api/workspace-drafts/zh_to_en') &&
      response.request().method() === 'PUT' &&
      response.ok(),
    )
    await page.goto('/?direction=zh_to_en')
    await initialAutosave
    await byTid(page, TID.translate.requirementsDetails).click()
    await page.route(
      `**/api/workflow-presets/${failedPreset.presetId}`,
      (route) => route.fulfill({ status: 503, body: 'preset unavailable' }),
    )

    const presetSelect = byTid(page, TID.translate.currentPreset)
    await presetSelect.selectOption(failedPreset.presetId)
    await expect(byTid(page, TID.translate.draftPresetLookupError)).toBeVisible()
    await expect(presetSelect).toHaveValue('')
    await expect.poll(async () => (
      await (await request.get('/api/workspace-drafts/zh_to_en')).json()
    ).selectedPresetRevisionId).toBeNull()

    await presetSelect.selectOption(validPreset.presetId)
    await expect(presetSelect).toHaveValue(validPreset.presetId)
    await expect.poll(async () => (
      await (await request.get('/api/workspace-drafts/zh_to_en')).json()
    ).selectedPresetRevisionId).toBe(validPreset.revisionId)

    const source = byTid(page, TID.translate.sourceInput)
    await source.fill('待提交的有效预设合同')
    const sessionRequest = page.waitForRequest((request) =>
      request.url().endsWith('/api/sessions') && request.method() === 'POST',
    )
    await byTid(page, TID.translate.translateButton).click()
    const submitted = (await sessionRequest).postDataJSON()
    expect(submitted).toEqual(expect.objectContaining({
      sourceText: '待提交的有效预设合同',
      taskBrief: 'valid submitted contract',
      presetRevisionId: validPreset.revisionId,
      mainEditorRunMode: 'tool_enabled',
    }))
  })

  test('a rejected draft save keeps the user in the current workspace', async ({
    page,
  }) => {
    await page.goto('/?direction=en_to_zh')
    const source = byTid(page, TID.translate.sourceInput)
    await page.route('**/api/workspace-drafts/en_to_zh', async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({ status: 503, body: 'draft store unavailable' })
        return
      }
      await route.continue()
    })
    await source.fill('This text must remain visible when persistence fails.')

    await byTid(page, TID.direction.zhToEnButton).click()
    await byTid(page, TID.direction.confirmButton).click()

    await expect(page).toHaveURL(/\?direction=en_to_zh$/)
    await expect(source).toHaveValue(
      'This text must remain visible when persistence fails.',
    )
    await expect(byTid(page, TID.translate.draftSaveError)).toContainText(
      '草稿保存失败',
    )
  })

  test('opening history session synchronizes its frozen direction without warning', async ({
    page,
    request,
  }) => {
    await seedModelProfile(request, 'zh_to_en')
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

  test('switching the UI locale does not reload or erase an unsaved direction draft', async ({
    page,
    request,
  }) => {
    await seedZhToEnPreset(request)
    await page.goto('/')
    const source = byTid(page, TID.translate.sourceInput)
    await source.waitFor()

    // Reproduce the first-time direction journey, which intentionally carries
    // a fresh marker until an older draft is restored or dismissed.
    await byTid(page, TID.direction.zhToEnButton).click()
    await expect(page).toHaveURL(/\?direction=zh_to_en&fresh=1$/)

    await byTid(page, TID.translate.requirementsDetails).click()
    const preset = byTid(page, TID.translate.currentPreset)
    const presetId = await preset
      .locator('option:not([value=""])')
      .first()
      .getAttribute('value')
    expect(presetId).toBeTruthy()
    await preset.selectOption(presetId!)
    await expect(preset).toHaveValue(presetId!)

    const pendingText = '语言切换时仍必须保留的未提交草稿。'
    await source.fill(pendingText)

    // Switch before the 500 ms draft debounce has a chance to fire.
    await page.getByTestId('locale-en').click()
    await expect(page.getByTestId('locale-en')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(source).toHaveValue(pendingText)
    await expect(byTid(page, TID.direction.zhToEnButton)).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(byTid(page, TID.translate.currentPreset)).toHaveValue(presetId!)
    await expect(
      page.getByText('An unsubmitted draft is available for this direction'),
    ).toHaveCount(0)

    await expect
      .poll(async () => {
        const response = await request.get('/api/workspace-drafts/zh_to_en')
        const draft = await response.json() as {
          sourceText: string
          selectedPresetRevisionId: string | null
        } | null
        return {
          sourceText: draft?.sourceText ?? null,
          selectedPresetRevisionId:
            draft?.selectedPresetRevisionId ?? null,
        }
      })
      .toEqual({
        sourceText: pendingText,
        selectedPresetRevisionId: expect.any(String),
      })

    // A normal revisit and reload must recover the persisted state.
    await page.goto('/?direction=zh_to_en')
    await expect(source).toHaveValue(pendingText)
    await expect(byTid(page, TID.translate.currentPreset)).toHaveValue(presetId!)
    await page.reload()
    await expect(source).toHaveValue(pendingText)
    await expect(byTid(page, TID.translate.currentPreset)).toHaveValue(presetId!)
  })
})
