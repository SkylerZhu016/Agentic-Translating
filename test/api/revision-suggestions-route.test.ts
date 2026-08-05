import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

vi.mock('../../src/lib/llm/client', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../src/lib/llm/client')>()
  return {
    ...original,
    chatCompletion: vi.fn(),
  }
})

import { chatCompletion } from '../../src/lib/llm/client'
import { createRepositories } from '../../src/lib/db/repositories'
import { createSessionService } from '../../src/lib/services/session-service'
import { POST } from '../../app/api/sessions/[id]/revision-suggestions/route'

const MIGRATION_SQL_0001 = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/db/migrations/0001_init.sql'),
  'utf8',
)
const MIGRATION_SQL_0002 = fs.readFileSync(
  path.join(
    process.cwd(),
    'src/lib/db/migrations/0002_presets_and_drop_parsed_output.sql',
  ),
  'utf8',
)

function request(body: unknown) {
  return new Request('http://localhost/api/sessions/test/revision-suggestions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/sessions/:id/revision-suggestions', () => {
  let db: Database.Database
  let repos: ReturnType<typeof createRepositories>
  let sessionId: string

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(MIGRATION_SQL_0001)
    db.exec(MIGRATION_SQL_0002)
    repos = createRepositories(db)

    repos.endpoints.insert({
      name: 'test endpoint',
      base_url: 'https://example.invalid',
      api_key: 'secret-that-must-not-be-returned',
    })
    repos.coordinatorConfig.upsert({
      endpoint_id: 1,
      model: 'DeepSeek V4 Flash: Go',
      chat_endpoint_id: 1,
      chat_model: 'DeepSeek V4 Flash: Go',
    })
    repos.translatorAgents.insert({
      name: 'agent one',
      endpoint_id: 1,
      model: 'DeepSeek V4 Flash: Go',
      prompt_override: null,
      sort_order: 0,
    })
    repos.translatorAgents.insert({
      name: 'agent two',
      endpoint_id: 1,
      model: 'DeepSeek V4 Flash: Go',
      prompt_override: null,
      sort_order: 1,
    })
    repos.promptTemplates.insert({
      kind: 'translator',
      name: 'translator',
      content: 'Translate the text.',
      is_builtin: 1,
    })
    repos.promptTemplates.insert({
      kind: 'review',
      name: 'review',
      content: 'Review the candidates.',
      is_builtin: 1,
    })

    const session = createSessionService(db, repos).createSession({
      sourceText: 'A source sentence.',
      sourceLang: 'English',
      targetLang: 'Chinese',
      taskBrief: '保持叙事语气。',
    })
    sessionId = session.id
    globalThis.__db = db
    vi.mocked(chatCompletion).mockReset()
    vi.mocked(chatCompletion).mockImplementation(async (_endpoint, llmRequest) => {
      const system = llmRequest.messages[0]?.content ?? ''
      if (system.includes('把两份隔离意见整理成')) {
        return { content: '这句话读着有点绕，请只改最明显的一处。' }
      }
      if (system.includes('独立的中文成品读者')) {
        return { content: '目标语阅读意见' }
      }
      if (system.includes('双语核验者')) {
        return { content: '双语核验意见' }
      }
      throw new Error(`unexpected prompt: ${system}`)
    })
  })

  afterEach(() => {
    delete globalThis.__db
    db.close()
  })

  it('requires an existing final version', async () => {
    const response = await POST(request({ message: '读着有点绕。' }), {
      params: Promise.resolve({ id: sessionId }),
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: 'final_version_required',
    })
    expect(chatCompletion).not.toHaveBeenCalled()
  })

  it('uses the current final version and never returns endpoint credentials', async () => {
    repos.finalVersions.insert({
      session_id: sessionId,
      version_no: 1,
      text: '第一版译文。',
      source: 'assemble',
    })
    repos.finalVersions.insert({
      session_id: sessionId,
      version_no: 2,
      text: '当前正式译文。',
      source: 'edit',
    })

    const response = await POST(request({ message: '读着有点绕。' }), {
      params: Promise.resolve({ id: sessionId }),
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({
      feedback: '这句话读着有点绕，请只改最明显的一处。',
      targetReaderReport: '目标语阅读意见',
      bilingualReport: '双语核验意见',
    })
    expect(JSON.stringify(body)).not.toContain('secret-that-must-not-be-returned')
    expect(chatCompletion).toHaveBeenCalledTimes(3)
    const combinedMessages = vi
      .mocked(chatCompletion)
      .mock.calls.flatMap(([, llmRequest]) => llmRequest.messages)
      .map((message) => message.content)
      .join('\n')
    expect(combinedMessages).toContain('当前正式译文。')
    expect(combinedMessages).not.toContain('第一版译文。')
  })

  it('rejects a missing session and an empty message without model calls', async () => {
    const missing = await POST(request({ message: '检查一下。' }), {
      params: Promise.resolve({ id: 'missing-session' }),
    })
    expect(missing.status).toBe(404)

    const empty = await POST(request({ message: '   ' }), {
      params: Promise.resolve({ id: sessionId }),
    })
    expect(empty.status).toBe(400)
    expect(chatCompletion).not.toHaveBeenCalled()
  })
})
