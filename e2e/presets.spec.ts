// ---------------------------------------------------------------------------
// E2E: presets.spec.ts
//
// Covers:
//   - Preset CRUD full flow: create → list → load → verify config change →
//     copy → verify independence → delete → verify gone
//   - Load confirmation dialog: click load → modal appears → cancel (config
//     unchanged) → confirm (config changes)
//   - Save current config as preset ("另存为当前配置") via create modal
//   - Built-in preset delete disabled (UI button disabled + API returns 400)
//   - Orphan endpoint warning + force load
//
// Notes:
//   - The PresetPanel component has no data-testid attributes, so we use
//     role-based selectors (getByRole) and text content throughout.
//   - The preset list is a <ul> with <li> items; modals use role="dialog";
//     the create-mode dropdown is a native <select>.
//   - The reset-db endpoint does NOT clear config_presets, so beforeEach
//     manually deletes all non-builtin presets via API to isolate tests.
//   - All LLM calls are mocked via the shared mock LLM server (port 41099).
//     Preset tests don't trigger LLM calls, but we reset mock behavior for
//     hygiene.
// ---------------------------------------------------------------------------

import { test, expect, type APIRequestContext } from '@playwright/test'
import { TID } from '../src/lib/testids'
import { resetDb, resetMockBehavior, byTid, evidenceScreenshot } from './helpers'

const MOCK_URL = process.env.E2E_MOCK_LLM_URL ?? 'http://localhost:41099'

test.beforeEach(async ({ request }) => {
  await resetDb(request)
  await resetMockBehavior(request)
  // reset-db does not clear config_presets — manually delete all custom
  // presets so each test starts with only the seeded 默认预设.
  await deleteAllCustomPresets(request)
})

/** Delete all non-builtin presets via API (test isolation helper). */
async function deleteAllCustomPresets(request: APIRequestContext): Promise<void> {
  const res = await request.get('/api/presets')
  expect(res.status()).toBe(200)
  const presets = await res.json()
  for (const p of presets as Array<{ id: number; is_builtin: number }>) {
    if (!p.is_builtin) {
      const del = await request.delete(`/api/presets/${p.id}`)
      expect(del.status()).toBe(200)
    }
  }
}

/** Seed one endpoint + two agents + coordinator pointing at mock. */
async function seedFullConfig(
  request: APIRequestContext,
  coordModel = 'coord-original',
): Promise<{ endpointId: number }> {
  const epRes = await request.post('/api/endpoints', {
    data: { name: 'Mock', base_url: MOCK_URL, api_key: 'sk-mock' },
  })
  expect(epRes.status()).toBe(201)
  const ep = await epRes.json()
  await request.post('/api/agents', {
    data: { name: 'Agent A', endpoint_id: ep.id, model: 'model-a', prompt_override: null, sort_order: 0 },
  })
  await request.post('/api/agents', {
    data: { name: 'Agent B', endpoint_id: ep.id, model: 'model-b', prompt_override: null, sort_order: 1 },
  })
  const coRes = await request.put('/api/coordinator', {
    data: { endpoint_id: ep.id, model: coordModel },
  })
  expect(coRes.status()).toBe(200)
  return { endpointId: ep.id }
}

/** Wait for /config page to finish loading (add-endpoint button visible). */
async function waitForConfigLoaded(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/config')
  await byTid(page, TID.endpoint.addButton).first().waitFor({ state: 'visible' })
}

/** Locator for the <li> containing a preset name. */
function presetListItem(
  page: import('@playwright/test').Page,
  name: string,
) {
  return page.locator('li', { has: page.locator(`text=${name}`) }).first()
}

// ---------------------------------------------------------------------------

test.describe('Task17 — Preset CRUD full flow', () => {
  test('create → list → load → verify config change → copy → verify independence → delete → verify gone', async ({
    page,
    request,
  }) => {
    // ── 1. Seed config + save as preset via API ──
    await seedFullConfig(request, 'coord-v1')
    const presetRes = await request.post('/api/presets', {
      data: { name: 'CRUD测试预设', fromCurrentConfig: true },
    })
    expect(presetRes.status()).toBe(201)
    const preset = await presetRes.json()

    // ── 2. Visit /config — verify preset appears in list ──
    await waitForConfigLoaded(page)
    await expect(presetListItem(page, 'CRUD测试预设')).toBeVisible({ timeout: 5_000 })
    await evidenceScreenshot(page, 'presets-crud-listed')

    // ── 3. Change coordinator model so we can verify load reverts it ──
    await request.put('/api/coordinator', {
      data: { endpoint_id: await getCoordinatorEndpointId(request), model: 'coord-CHANGED' },
    })
    const coordChanged = await (await request.get('/api/coordinator')).json()
    expect(coordChanged.model).toBe('coord-CHANGED')

    // ── 4. Click 加载 → load confirm modal appears ──
    await presetListItem(page, 'CRUD测试预设').getByRole('button', { name: '加载' }).click()
    await expect(page.getByText(/确定加载预设/)).toBeVisible({ timeout: 5_000 })
    await expect(page.getByRole('button', { name: '确认加载' })).toBeVisible()

    // ── 5. Confirm load → coordinator model reverts to preset's ──
    await page.getByRole('button', { name: '确认加载' }).click()
    // Modal closes; coordinator config is reloaded by the page
    await expect(page.getByText(/确定加载预设/)).not.toBeVisible({ timeout: 5_000 })
    const coordRestored = await (await request.get('/api/coordinator')).json()
    expect(coordRestored.model).toBe('coord-v1')
    await evidenceScreenshot(page, 'presets-crud-loaded')

    // ── 6. Copy preset via UI → "CRUD测试预设 副本" appears ──
    await presetListItem(page, 'CRUD测试预设').getByRole('button', { name: '复制' }).click()
    await expect(presetListItem(page, 'CRUD测试预设 副本')).toBeVisible({ timeout: 5_000 })
    await evidenceScreenshot(page, 'presets-crud-copied')

    // ── 7. Verify independence: rename copy via UI, original unchanged ──
    const copyItem = presetListItem(page, 'CRUD测试预设 副本')
    await copyItem.getByRole('button', { name: '编辑' }).click()
    const editDialog = page.getByRole('dialog')
    await expect(editDialog).toBeVisible({ timeout: 5_000 })
    // The edit modal has two inputs: name + description. Fill the first.
    await editDialog.locator('input').first().fill('副本已改名')
    await editDialog.getByRole('button', { name: '保存' }).click()
    await expect(editDialog).not.toBeVisible({ timeout: 5_000 })

    // Renamed copy visible; original still present
    await expect(presetListItem(page, '副本已改名')).toBeVisible({ timeout: 5_000 })
    await expect(presetListItem(page, 'CRUD测试预设')).toBeVisible()

    // ── 8. Independence via API: modifying copy's content doesn't affect original ──
    const presets = await (await request.get('/api/presets')).json()
    const copyPreset = presets.find((p: { name: string }) => p.name === '副本已改名')
    const origPreset = presets.find((p: { name: string }) => p.name === 'CRUD测试预设')
    // Modify copy's coordinator model via API
    const copyFull = await (await request.get(`/api/presets/${copyPreset.id}`)).json()
    const putRes = await request.put(`/api/presets/${copyPreset.id}`, {
      data: {
        coordinator: {
          endpoint_id: copyFull.coordinator?.endpoint_id ?? null,
          model: 'coord-modified-copy',
          chat_endpoint_id: copyFull.coordinator?.chat_endpoint_id ?? null,
          chat_model: copyFull.coordinator?.chat_model ?? '',
        },
      },
    })
    expect(putRes.status()).toBe(200)
    // Original preset's coordinator model unchanged
    const origFull = await (await request.get(`/api/presets/${origPreset.id}`)).json()
    expect(origFull.coordinator?.model).toBe('coord-v1')
    // Copy's coordinator model changed
    const copyFullAfter = await (await request.get(`/api/presets/${copyPreset.id}`)).json()
    expect(copyFullAfter.coordinator?.model).toBe('coord-modified-copy')

    // ── 9. Delete the copy via UI ──
    await presetListItem(page, '副本已改名').getByRole('button', { name: '删除' }).click()
    await expect(page.getByRole('button', { name: '确认删除' })).toBeVisible({ timeout: 5_000 })
    await page.getByRole('button', { name: '确认删除' }).click()
    await expect(presetListItem(page, '副本已改名')).not.toBeVisible({ timeout: 5_000 })

    // ── 10. Delete the original via UI ──
    await presetListItem(page, 'CRUD测试预设').getByRole('button', { name: '删除' }).click()
    await expect(page.getByRole('button', { name: '确认删除' })).toBeVisible({ timeout: 5_000 })
    await page.getByRole('button', { name: '确认删除' }).click()
    await expect(presetListItem(page, 'CRUD测试预设')).not.toBeVisible({ timeout: 5_000 })
    await evidenceScreenshot(page, 'presets-crud-both-deleted')

    // ── 11. Verify via API both are gone ──
    const presetsAfter = await (await request.get('/api/presets')).json()
    expect(
      (presetsAfter as Array<{ name: string }>).find((p) => p.name === 'CRUD测试预设'),
    ).toBeUndefined()
    expect(
      (presetsAfter as Array<{ name: string }>).find((p) => p.name === '副本已改名'),
    ).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------

test.describe('Task17 — Load confirmation dialog', () => {
  test('cancel keeps config unchanged; confirm applies preset config', async ({
    page,
    request,
  }) => {
    // Seed config with model 'preset-model' and save as preset
    await seedFullConfig(request, 'preset-model')
    await request.post('/api/presets', {
      data: { name: '载入确认测试', fromCurrentConfig: true },
    })

    // Change coordinator model to 'current-model' (so load would revert it)
    const epId = await getCoordinatorEndpointId(request)
    await request.put('/api/coordinator', {
      data: { endpoint_id: epId, model: 'current-model' },
    })
    const beforeLoad = await (await request.get('/api/coordinator')).json()
    expect(beforeLoad.model).toBe('current-model')

    await waitForConfigLoaded(page)
    const item = presetListItem(page, '载入确认测试')

    // ── Click 加载 → modal appears ──
    await item.getByRole('button', { name: '加载' }).click()
    await expect(page.getByText(/确定加载预设/)).toBeVisible({ timeout: 5_000 })

    // ── Click 取消 → modal closes, config unchanged ──
    await page.getByRole('button', { name: '取消' }).click()
    await expect(page.getByText(/确定加载预设/)).not.toBeVisible({ timeout: 3_000 })
    const afterCancel = await (await request.get('/api/coordinator')).json()
    expect(afterCancel.model).toBe('current-model')

    // ── Click 加载 again → modal appears → 确认加载 → config changes ──
    await item.getByRole('button', { name: '加载' }).click()
    await expect(page.getByText(/确定加载预设/)).toBeVisible({ timeout: 5_000 })
    await page.getByRole('button', { name: '确认加载' }).click()
    await expect(page.getByText(/确定加载预设/)).not.toBeVisible({ timeout: 5_000 })

    const afterConfirm = await (await request.get('/api/coordinator')).json()
    expect(afterConfirm.model).toBe('preset-model')
    await evidenceScreenshot(page, 'presets-load-confirmed')
  })
})

// ---------------------------------------------------------------------------

test.describe('Task17 — Save current config as preset ("另存为当前配置")', () => {
  test('create modal: select 另存为当前配置 → new preset contains current config', async ({
    page,
    request,
  }) => {
    // Seed config with distinctive values so we can verify they're snapshotted
    await seedFullConfig(request, 'coord-save-snapshot')
    // Add one more agent with a distinctive model name
    const epId = await getCoordinatorEndpointId(request)
    await request.post('/api/agents', {
      data: {
        name: 'Snapshot Agent',
        endpoint_id: epId,
        model: 'snapshot-model-xyz',
        prompt_override: null,
        sort_order: 99,
      },
    })

    await waitForConfigLoaded(page)

    // Open the create modal (the 新建预设 button lives in the PresetPanel
    // card actions, which is the first one on the page).
    await page.getByRole('button', { name: '新建预设' }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5_000 })

    // Fill name
    await dialog.locator('input').first().fill('另存快照预设')

    // Select "另存为当前配置" in the create-mode <select>
    // The create modal has one visible <select> (create mode). When mode is
    // not 'copy', there is no second select. Use the first select in dialog.
    const modeSelect = dialog.locator('select').first()
    await modeSelect.selectOption({ label: '另存为当前配置' })

    // Submit
    await dialog.getByRole('button', { name: '创建' }).click()
    await expect(dialog).not.toBeVisible({ timeout: 5_000 })

    // Verify preset appears in list
    await expect(presetListItem(page, '另存快照预设')).toBeVisible({ timeout: 5_000 })
    await evidenceScreenshot(page, 'presets-save-current-created')

    // Verify via API that the preset captured the current config
    const presets = await (await request.get('/api/presets')).json()
    const created = (presets as Array<{ id: number; name: string }>).find(
      (p) => p.name === '另存快照预设',
    )
    expect(created).toBeDefined()

    const full = await (await request.get(`/api/presets/${created!.id}`)).json()
    // Should have the Snapshot Agent with the distinctive model
    expect(
      (full.agents as Array<{ model: string }>).some((a) => a.model === 'snapshot-model-xyz'),
    ).toBe(true)
    // Should have the coordinator with the distinctive model
    expect(full.coordinator?.model).toBe('coord-save-snapshot')
  })
})

// ---------------------------------------------------------------------------

test.describe('Task17 — Built-in preset delete disabled', () => {
  test('默认预设 delete button is disabled in UI; API returns 400', async ({
    page,
    request,
  }) => {
    await waitForConfigLoaded(page)

    // The seeded 默认预设 should be present
    const builtinItem = presetListItem(page, '默认预设')
    await expect(builtinItem).toBeVisible({ timeout: 5_000 })

    // The 删除 button on the built-in item should be disabled
    const deleteBtn = builtinItem.getByRole('button', { name: '删除' })
    await expect(deleteBtn).toBeDisabled()

    // The 内置 badge should be visible on the built-in item. Use exact:true
    // to match only the badge text, not the description "系统内置默认配置".
    await expect(builtinItem.getByText('内置', { exact: true })).toBeVisible()
    await evidenceScreenshot(page, 'presets-builtin-delete-disabled')

    // API-level guard: DELETE returns 400
    const presets = await (await request.get('/api/presets')).json()
    const builtin = (presets as Array<{ name: string; is_builtin: number; id: number }>).find(
      (p) => p.name === '默认预设' && p.is_builtin === 1,
    )
    expect(builtin).toBeDefined()
    const delRes = await request.delete(`/api/presets/${builtin!.id}`)
    expect(delRes.status()).toBe(400)
    const delBody = await delRes.json()
    expect(delBody.error).toContain('builtin')
  })
})

// ---------------------------------------------------------------------------

test.describe('Task17 — Orphan endpoint warning + force load', () => {
  test('load preset with orphaned endpoint → warning modal → force load applies', async ({
    page,
    request,
  }) => {
    // Seed config (endpoint + agent + coordinator all referencing the endpoint)
    const { endpointId } = await seedFullConfig(request, 'coord-orphan')
    await request.post('/api/agents', {
      data: {
        name: 'Orphan Agent',
        endpoint_id: endpointId,
        model: 'orphan-model',
        prompt_override: null,
        sort_order: 50,
      },
    })
    await request.post('/api/presets', {
      data: { name: '孤儿端点预设', fromCurrentConfig: true },
    })

    // Delete the endpoint → preset now references a non-existent endpoint_id.
    // Use ?force=1 to bypass FK enforcement from config_preset_agents (preset
    // snapshot tables intentionally retain stale endpoint_ids so the orphan
    // check can detect them on load).
    const delEpRes = await request.delete(`/api/endpoints/${endpointId}?force=1`)
    expect(delEpRes.status()).toBe(200)

    await waitForConfigLoaded(page)
    const item = presetListItem(page, '孤儿端点预设')

    // ── Click 加载 → confirm modal ──
    await item.getByRole('button', { name: '加载' }).click()
    await expect(page.getByText(/确定加载预设/)).toBeVisible({ timeout: 5_000 })
    await page.getByRole('button', { name: '确认加载' }).click()

    // ── Orphan warning modal appears ──
    await expect(page.getByText(/预设包含无效端点引用/)).toBeVisible({ timeout: 5_000 })
    await expect(page.getByRole('button', { name: '强制加载' })).toBeVisible()
    await evidenceScreenshot(page, 'presets-orphan-warning')

    // ── Click 强制加载 → applies, skipping orphaned references ──
    await page.getByRole('button', { name: '强制加载' }).click()
    await expect(page.getByText(/预设包含无效端点引用/)).not.toBeVisible({ timeout: 5_000 })

    // Verify: coordinator endpoint_id is cleared (orphaned), model preserved
    const coordAfter = await (await request.get('/api/coordinator')).json()
    expect(coordAfter.endpoint_id).toBeNull()
    expect(coordAfter.model).toBe('coord-orphan')

    // Verify: agents referencing the orphaned endpoint were skipped
    const agentsAfter = await (await request.get('/api/agents')).json()
    // No agent should reference the deleted endpoint_id
    expect(
      (agentsAfter as Array<{ endpoint_id: number | null }>).every(
        (a) => a.endpoint_id !== endpointId,
      ),
    ).toBe(true)
    await evidenceScreenshot(page, 'presets-force-loaded')
  })
})

// ---------------------------------------------------------------------------

/** Helper: fetch the current coordinator's endpoint_id (for re-PUT merges). */
async function getCoordinatorEndpointId(request: APIRequestContext): Promise<number | null> {
  const res = await request.get('/api/coordinator')
  if (res.status() === 404) return null
  const coord = await res.json()
  return coord.endpoint_id ?? null
}
