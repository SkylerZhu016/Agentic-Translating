import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../../src/lib/db/migrate'
import { seed } from '../../src/lib/db/seed'
import { createRepositories } from '../../src/lib/db/repositories'
import { createVNextRepositories } from '../../src/lib/db/vnext-repositories'

vi.mock('../../src/lib/llm/client', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../src/lib/llm/client')>()
  return {
    ...original,
    chatCompletion: vi.fn(),
  }
})

import { chatCompletion } from '../../src/lib/llm/client'
import { POST as testSavedAgent } from '../../app/api/agent-catalog/[id]/test/route'
import { POST as previewAgent } from '../../app/api/agent-catalog/preview/route'

function request(body: unknown) {
  return new Request('http://localhost/api/agent-catalog/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('independent Agent text testing', () => {
  let db: Database.Database
  let endpointId: number

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    seed(db)
    endpointId = Number(
      createRepositories(db).endpoints.insert({
        name: 'test endpoint',
        base_url: 'https://example.invalid',
        chat_completions_path: '/v1/chat/completions',
        api_key: 'temporary-test-key',
      }).lastInsertRowid,
    )
    globalThis.__db = db
    vi.mocked(chatCompletion).mockReset()
  })

  afterEach(() => {
    delete globalThis.__db
    db.close()
  })

  it('rejects an empty source before making a model request', async () => {
    const response = await testSavedAgent(request({
      sourceText: '',
      endpointId,
      model: 'test-model',
    }), {
      params: Promise.resolve({ id: 'semantic-fidelity.en-to-zh' }),
    })

    expect(response.status).toBe(400)
    expect(chatCompletion).not.toHaveBeenCalled()
  })

  it('tests a built-in Agent and preserves the FSBP body boundary', async () => {
    vi.mocked(chatCompletion).mockResolvedValue({
      content: '独立测试译文\n---\n只供用户查看的说明',
    })

    const response = await testSavedAgent(request({
      sourceText: 'A source passage.',
      taskBrief: '保持克制。',
      additionalInstruction: '重点检查动作施受。',
      endpointId,
      model: 'test-model',
    }), {
      params: Promise.resolve({ id: 'semantic-fidelity.en-to-zh' }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      raw: '独立测试译文\n---\n只供用户查看的说明',
      body: '独立测试译文',
      annotation: '只供用户查看的说明',
    })
    const [, llmRequest] = vi.mocked(chatCompletion).mock.calls[0]
    expect(llmRequest.messages[0].content).toContain('# 工作重点')
    expect(llmRequest.messages[1].content).toContain('A source passage.')
    expect(llmRequest.messages[1].content).toContain('重点检查动作施受。')
  })

  it('uses the same saved-Agent route for a custom Agent', async () => {
    createVNextRepositories(db).agents.createCustom(
      {
        id: 'custom-agent-test',
        slug: 'custom-agent-test',
        displayNameZh: '自定义审慎译者',
        category: 'expression',
        tags: ['test'],
        isBuiltin: false,
      },
      [{
        id: 'custom-agent-test.en-to-zh.1',
        archetypeId: 'custom-agent-test',
        direction: 'en_to_zh',
        catalogName: '自定义审慎译者',
        catalogDescription: '用于测试自定义提示词',
        rolePrompt: '这是用户保存的完整自定义准则。',
        promptLanguage: 'zh',
        promptVersion: 1,
        enabled: true,
        endpointOverrideId: endpointId,
        modelOverride: 'custom-model',
        sortOrder: 1000,
      }],
    )
    vi.mocked(chatCompletion).mockResolvedValue({ content: '自定义结果' })

    const response = await testSavedAgent(request({
      sourceText: 'Custom source.',
      endpointId,
      model: 'custom-model',
    }), {
      params: Promise.resolve({ id: 'custom-agent-test.en-to-zh.1' }),
    })

    expect(response.status).toBe(200)
    expect((await response.json()).body).toBe('自定义结果')
    const [, llmRequest] = vi.mocked(chatCompletion).mock.calls[0]
    expect(llmRequest.messages[0].content).toContain(
      '这是用户保存的完整自定义准则。',
    )
  })

  it('previews an unsaved custom prompt without creating an Agent', async () => {
    vi.mocked(chatCompletion).mockResolvedValue({ content: '预览结果' })
    const before = db.prepare(
      'SELECT COUNT(*) AS count FROM agent_archetypes WHERE is_builtin = 0',
    ).get() as { count: number }

    const response = await previewAgent(request({
      direction: 'en_to_zh',
      promptLanguage: 'zh',
      rolePrompt: '这是尚未保存的角色准则。',
      sourceText: 'Preview source.',
      taskBrief: '保持原文语气。',
      additionalInstruction: '',
      endpointId,
      model: 'preview-model',
    }))

    expect(response.status).toBe(200)
    expect((await response.json()).body).toBe('预览结果')
    const after = db.prepare(
      'SELECT COUNT(*) AS count FROM agent_archetypes WHERE is_builtin = 0',
    ).get() as { count: number }
    expect(after.count).toBe(before.count)
    const [, llmRequest] = vi.mocked(chatCompletion).mock.calls[0]
    expect(llmRequest.messages[0].content).toContain(
      '这是尚未保存的角色准则。',
    )
  })
})
