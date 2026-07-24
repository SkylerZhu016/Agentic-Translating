import { test, expect } from '@playwright/test'
import JSZip from 'jszip'
import {
  resetDb,
  resetMockBehavior,
  setMockBehavior,
} from './helpers'

const MOCK_URL = process.env.E2E_MOCK_LLM_URL ?? 'http://localhost:41099'

test.beforeEach(async ({ request }) => {
  await resetDb(request)
  await resetMockBehavior(request)
})

test('100 UTF-8 TXT/Markdown files complete with frozen preset and mirrored ZIP paths', async ({
  request,
}) => {
  test.setTimeout(120_000)
  await setMockBehavior(request, {
    behavior: 'stream',
    model: 'batch-worker',
    delayMs: 0,
  })
  await setMockBehavior(request, {
    behavior: 'json_content',
    model: 'batch-stage',
    jsonContent: 'A stable translated batch result.\nSecond translated line.',
  })
  const endpointResponse = await request.post('/api/endpoints', {
    data: { name: 'Batch Mock', base_url: MOCK_URL, api_key: 'sk-batch' },
  })
  expect(endpointResponse.status()).toBe(201)
  const endpoint = await endpointResponse.json()
  const catalog = await (
    await request.get('/api/agent-catalog?direction=en_to_zh')
  ).json()
  const variants = catalog.variants.slice(0, 2)
  const workerBinding = {
    endpointId: endpoint.id,
    model: 'batch-worker',
    contextWindow: 128000,
  }
  const stageBinding = {
    endpointId: endpoint.id,
    model: 'batch-stage',
    contextWindow: 128000,
  }
  const presetResponse = await request.post('/api/workflow-presets', {
    data: {
      name: '100-file stable workflow',
      description: '',
      direction: 'en_to_zh',
      contract: {
        sourceLang: '英文',
        targetLang: '中文',
        taskBriefTemplate: 'Translate {{relative_path}} faithfully.',
        teamPolicy: 'fixed',
        reviewMode: 'four_stage',
        agentVariantIds: variants.map((variant: { id: string }) => variant.id),
        agentVariantSnapshots: variants,
        defaultWorkerBinding: workerBinding,
        agentBindingOverrides: {},
        mainAgentBinding: stageBinding,
        editingAgentBinding: stageBinding,
        promptBundleVersion: 1,
        maxAgentCalls: 5,
        batchConcurrency: 2,
        constraints: { preserveParagraphs: true },
      },
    },
  })
  expect(presetResponse.status()).toBe(201)
  const preset = await presetResponse.json()
  const files = Array.from({ length: 100 }, (_, index) => ({
    relativePath: `chapter-${Math.floor(index / 10)}/item-${index}.${
      index % 2 ? 'md' : 'txt'
    }`,
    sourceText: `Source document ${index}\nSecond line`,
    originalLineEnding: index % 3 === 0 ? 'crlf' : 'lf',
    hadBom: index % 4 === 0,
  }))
  const createResponse = await request.post('/api/batches', {
    data: {
      name: 'Hundred files',
      presetRevisionId: preset.revision.id,
      concurrency: 2,
      files,
    },
  })
  expect(createResponse.status()).toBe(201)
  const { id } = await createResponse.json()

  let job: {
    status: string
    total_count: number
    completed_count: number
    failed_count: number
  } | null = null
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const jobs = await (await request.get('/api/batches')).json()
    job = jobs.find((candidate: { id: string }) => candidate.id === id) ?? null
    if (job && ['completed', 'failed'].includes(job.status)) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  expect(job).toMatchObject({
    status: 'completed',
    total_count: 100,
    completed_count: 100,
    failed_count: 0,
  })

  const exportResponse = await request.get(`/api/batches/${id}/export?audit=1`)
  expect(exportResponse.status()).toBe(200)
  const zip = await JSZip.loadAsync(await exportResponse.body())
  expect(Object.keys(zip.files).filter((name) => !zip.files[name].dir)).toHaveLength(
    200,
  )
  expect(zip.file('chapter-0/item-0.txt')).not.toBeNull()
  expect(zip.file('chapter-0/item-0.txt.audit.json')).not.toBeNull()
  const first = await zip.file('chapter-0/item-0.txt')!.async('uint8array')
  expect(Array.from(first.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf])
  expect(new TextDecoder().decode(first)).toContain('\r\n')

  const unsafeResponse = await request.post('/api/batches', {
    data: {
      name: 'Unsafe',
      presetRevisionId: preset.revision.id,
      concurrency: 2,
      files: [
        {
          relativePath: '../escape.txt',
          sourceText: 'unsafe',
          originalLineEnding: 'lf',
          hadBom: false,
        },
      ],
    },
  })
  expect(unsafeResponse.status()).toBe(400)
})
