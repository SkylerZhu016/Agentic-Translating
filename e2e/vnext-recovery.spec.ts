import { expect, test } from '@playwright/test'
import { TID } from '../src/lib/testids'
import {
  byTid,
  resetDb,
  resetMockBehavior,
  setMockBehavior,
  tid,
} from './helpers'

const MOCK_URL = process.env.E2E_MOCK_LLM_URL ?? 'http://localhost:41099'

test.beforeEach(async ({ request }) => {
  await resetDb(request)
  await resetMockBehavior(request)
})

test('pause after candidates, then resume without repeating Agent calls', async ({
  page,
  request,
}) => {
  const endpointResponse = await request.post('/api/endpoints', {
    data: {
      name: 'vNext recovery mock',
      base_url: MOCK_URL,
      api_key: 'sk-mock',
    },
  })
  expect(endpointResponse.status()).toBe(201)
  const endpoint = await endpointResponse.json()
  const binding = (model: string) => ({
    endpointId: endpoint.id,
    model,
    contextWindow: 128000,
  })
  const profileResponse = await request.put('/api/model-profiles/en_to_zh', {
    data: {
      defaultWorker: binding('worker-model'),
      mainAgent: binding('main-model'),
      editingAgent: binding('analysis-model'),
    },
  })
  expect(profileResponse.status()).toBe(200)

  await setMockBehavior(request, {
    behavior: 'stream',
    model: 'worker-model',
    delayMs: 250,
  })
  await setMockBehavior(request, {
    behavior: 'tool_call',
    model: 'main-model',
    stream: true,
  })
  await setMockBehavior(request, {
    behavior: 'stream',
    model: 'analysis-model',
    delayMs: 5,
  })

  await page.goto('/')
  await byTid(page, TID.translate.sourceInput).fill(
    'A difficult literary sentence whose imagery and voice both matter.',
  )
  await byTid(page, TID.translate.translateButton).click()

  const candidateCards = page.locator(
    `${tid(TID.translate.agentStreamCard)}[data-agent-kind="translation"]`,
  )
  await expect(candidateCards).toHaveCount(2, { timeout: 30_000 })
  await page.getByRole('button', { name: '暂停自动成稿' }).click()

  await expect(
    page.getByRole('button', { name: '从候选继续运行' }),
  ).toBeVisible({ timeout: 60_000 })
  const sessionId = new URL(page.url()).searchParams.get('session')
  expect(sessionId).toBeTruthy()
  const paused = await (
    await request.get(`/api/sessions/${sessionId}`)
  ).json()
  expect(paused.finalVersion).toBeNull()
  expect(paused.runs.at(-1).phase).toBe('paused')
  const invocationCount = paused.invocations.length
  expect(invocationCount).toBeGreaterThanOrEqual(4)

  await page.getByRole('button', { name: '从候选继续运行' }).click()
  await expect(page.getByText('v1 · 主 Agent 成稿')).toBeVisible({
    timeout: 60_000,
  })

  const completed = await (
    await request.get(`/api/sessions/${sessionId}`)
  ).json()
  expect(completed.finalVersion).not.toBeNull()
  expect(completed.invocations).toHaveLength(invocationCount)
  expect(
    completed.events.some(
      (event: { event_type: string }) => event.event_type === 'run.resumed',
    ),
  ).toBe(true)
  expect(
    completed.events.some((event: { event_type: string; payload_json: string }) =>
      event.event_type === 'tool.called' &&
      JSON.parse(event.payload_json).name === 'call_agents',
    ),
  ).toBe(true)
})

test('poetry task runs one auxiliary rhyme plan without counting it as a candidate', async ({
  request,
}) => {
  const endpointResponse = await request.post('/api/endpoints', {
    data: {
      name: 'Poetry planning mock',
      base_url: MOCK_URL,
      api_key: 'sk-mock',
    },
  })
  expect(endpointResponse.status()).toBe(201)
  const endpoint = await endpointResponse.json()
  const binding = (model: string) => ({
    endpointId: endpoint.id,
    model,
    contextWindow: 128000,
  })
  const profileResponse = await request.put('/api/model-profiles/zh_to_en', {
    data: {
      defaultWorker: binding('worker-model'),
      mainAgent: binding('main-model'),
      editingAgent: binding('analysis-model'),
    },
  })
  expect(profileResponse.status()).toBe(200)

  await setMockBehavior(request, {
    behavior: 'stream',
    model: 'worker-model',
    delayMs: 5,
  })
  await setMockBehavior(request, {
    behavior: 'tool_call',
    model: 'main-model',
    stream: true,
  })
  await setMockBehavior(request, {
    behavior: 'stream',
    model: 'analysis-model',
    delayMs: 5,
  })

  const sessionResponse = await request.post('/api/sessions', {
    data: {
      clientRequestId: crypto.randomUUID(),
      direction: 'zh_to_en',
      sourceText:
        '相见时难别亦难，东风无力百花残。春蚕到死丝方尽，蜡炬成灰泪始干。晓镜但愁云鬓改，夜吟应觉月光寒。蓬山此去无多路，青鸟殷勤为探看。',
      taskBrief: 'Translate as a poem while preserving line relationships.',
      reviewMode: 'main_editor',
      constraints: {
        poetryMode: 'on',
        poetryTargetForm: 'preserve',
        englishRhymeMode: 'natural',
        rhymePositions: 'auto',
        firstLineRhyme: 'auto',
        rhymeChange: 'source',
        poetryPriority: 'balanced',
        rhymeEvidence: true,
      },
    },
  })
  expect(sessionResponse.status()).toBe(200)
  const session = await sessionResponse.json()

  const runResponse = await request.post(`/api/sessions/${session.id}/run`)
  expect([200, 202]).toContain(runResponse.status())

  let detail: {
    finalVersion: unknown
    invocations: Array<{
      agent_snapshot: string
    }>
    events: Array<{ event_type: string }>
  } | null = null
  await expect.poll(async () => {
    const response = await request.get(`/api/sessions/${session.id}`)
    detail = await response.json()
    return Boolean(detail?.finalVersion)
  }, { timeout: 60_000 }).toBe(true)

  const invocations = detail!.invocations
  const roleKindOf = (item: typeof invocations[number]) =>
    (
      JSON.parse(item.agent_snapshot) as {
        roleKind?: string
      }
    ).roleKind
  const poetryPlans = invocations.filter(
    (item) => roleKindOf(item) === 'poetry_plan',
  )
  const candidates = invocations.filter(
    (item) =>
      !['context_analysis', 'poetry_plan'].includes(
        roleKindOf(item) ?? 'translation',
      ),
  )
  expect(poetryPlans).toHaveLength(1)
  expect(candidates.length).toBeGreaterThanOrEqual(2)
  expect(
    detail!.events.some(
      (event) => event.event_type === 'poetry.plan.completed',
    ),
  ).toBe(true)
})
