import { test, expect, type APIRequestContext } from '@playwright/test'
import { resetDb } from './helpers'

const MOCK_URL = process.env.E2E_MOCK_LLM_URL ?? 'http://localhost:41099'

test.beforeEach(async ({ request }) => {
  await resetDb(request)
})

async function createEndpoint(request: APIRequestContext) {
  const response = await request.post('/api/endpoints', {
    data: { name: 'Preset Mock', base_url: MOCK_URL, api_key: 'sk-e2e' },
  })
  expect(response.status()).toBe(201)
  return response.json()
}

async function contract(
  request: APIRequestContext,
  endpointId: number,
  direction: 'en_to_zh' | 'zh_to_en' = 'en_to_zh',
) {
  const catalogResponse = await request.get(
    `/api/agent-catalog?direction=${direction}`,
  )
  expect(catalogResponse.status()).toBe(200)
  const catalog = await catalogResponse.json()
  const variants = catalog.variants.slice(0, 2)
  expect(variants).toHaveLength(2)
  const binding = {
    endpointId,
    model: 'preset-model-v1',
    contextWindow: 128000,
  }
  return {
    sourceLang: direction === 'en_to_zh' ? '英文' : '中文',
    targetLang: direction === 'en_to_zh' ? '中文' : '英文',
    taskBriefTemplate: '处理 {{file_name}}，保持段落。',
    teamPolicy: 'fixed',
    reviewMode: 'main_editor',
    agentVariantIds: variants.map((item: { id: string }) => item.id),
    agentVariantSnapshots: variants,
    defaultWorkerBinding: binding,
    agentBindingOverrides: {},
    mainAgentBinding: binding,
    editingAgentBinding: binding,
    promptBundleVersion: 1,
    maxAgentCalls: 5,
    batchConcurrency: 2,
    constraints: { preserveParagraphs: true },
  }
}

test.describe('vNext workflow preset revisions', () => {
  test('create revision 1, rename without revision, edit and restore append revisions', async ({
    request,
  }) => {
    const endpoint = await createEndpoint(request)
    const v1 = await contract(request, endpoint.id)
    const createResponse = await request.post('/api/workflow-presets', {
      data: {
        name: '批量英译中',
        description: 'revision test',
        direction: 'en_to_zh',
        contract: v1,
      },
    })
    expect(createResponse.status()).toBe(201)
    const created = await createResponse.json()
    const presetId = created.preset.id
    expect(created.preset.currentRevisionNo).toBe(1)

    const renameResponse = await request.patch(
      `/api/workflow-presets/${presetId}`,
      {
        data: { name: '批量英译中（已改名）', description: 'metadata only' },
      },
    )
    expect(renameResponse.status()).toBe(200)
    let detail = await (
      await request.get(`/api/workflow-presets/${presetId}`)
    ).json()
    expect(detail.preset.currentRevisionNo).toBe(1)
    expect(detail.revisions).toHaveLength(1)

    const v2 = {
      ...v1,
      teamPolicy: 'dynamic',
      defaultWorkerBinding: {
        ...v1.defaultWorkerBinding,
        model: 'preset-model-v2',
      },
    }
    const revisionResponse = await request.post(
      `/api/workflow-presets/${presetId}/revisions`,
      { data: v2 },
    )
    expect(revisionResponse.status()).toBe(201)
    detail = await (
      await request.get(`/api/workflow-presets/${presetId}`)
    ).json()
    expect(detail.preset.currentRevisionNo).toBe(2)
    expect(detail.revisions).toHaveLength(2)

    const restoreResponse = await request.post(
      `/api/workflow-presets/${presetId}/restore`,
      { data: { revisionNo: 1 } },
    )
    expect(restoreResponse.status()).toBe(201)
    detail = await (
      await request.get(`/api/workflow-presets/${presetId}`)
    ).json()
    expect(detail.preset.currentRevisionNo).toBe(3)
    expect(detail.revisions).toHaveLength(3)
    expect(detail.revisions[0].contract.teamPolicy).toBe('fixed')
  })

  test('direction filters and soft deletion retain revision history', async ({
    request,
  }) => {
    const endpoint = await createEndpoint(request)
    const enContract = await contract(request, endpoint.id, 'en_to_zh')
    const zhContract = await contract(request, endpoint.id, 'zh_to_en')
    const enCreated = await (
      await request.post('/api/workflow-presets', {
        data: {
          name: 'EN-ZH',
          description: '',
          direction: 'en_to_zh',
          contract: enContract,
        },
      })
    ).json()
    await request.post('/api/workflow-presets', {
      data: {
        name: 'ZH-EN',
        description: '',
        direction: 'zh_to_en',
        contract: zhContract,
      },
    })

    const enList = await (
      await request.get('/api/workflow-presets?direction=en_to_zh')
    ).json()
    const zhList = await (
      await request.get('/api/workflow-presets?direction=zh_to_en')
    ).json()
    expect(enList.map((item: { name: string }) => item.name)).toEqual(['EN-ZH'])
    expect(zhList.map((item: { name: string }) => item.name)).toEqual(['ZH-EN'])

    const deleteResponse = await request.delete(
      `/api/workflow-presets/${enCreated.preset.id}`,
    )
    expect(deleteResponse.status()).toBe(204)
    const visible = await (
      await request.get('/api/workflow-presets?direction=en_to_zh')
    ).json()
    const withDeleted = await (
      await request.get(
        '/api/workflow-presets?direction=en_to_zh&includeDeleted=1',
      )
    ).json()
    expect(visible).toHaveLength(0)
    expect(withDeleted).toHaveLength(1)
    const detail = await (
      await request.get(`/api/workflow-presets/${enCreated.preset.id}`)
    ).json()
    expect(detail.revisions).toHaveLength(1)
  })

  test('export contains no API key and mixed directions are rejected', async ({
    request,
  }) => {
    const endpoint = await createEndpoint(request)
    const value = await contract(request, endpoint.id, 'en_to_zh')
    const createResponse = await request.post('/api/workflow-presets', {
      data: {
        name: '安全导出',
        description: '',
        direction: 'en_to_zh',
        contract: value,
      },
    })
    const created = await createResponse.json()
    const exportResponse = await request.get(
      `/api/workflow-presets/${created.preset.id}/export`,
    )
    expect(exportResponse.status()).toBe(200)
    expect(await exportResponse.text()).not.toContain('sk-e2e')

    const opposite = await contract(request, endpoint.id, 'zh_to_en')
    const invalid = await request.post('/api/workflow-presets', {
      data: {
        name: '错误混向',
        description: '',
        direction: 'en_to_zh',
        contract: opposite,
      },
    })
    expect(invalid.status()).toBe(400)
  })
})
