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
import {
  createProjectRepositories,
  estimateProjectContextTokens,
} from '../../src/lib/db/project-repositories'

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
const MIGRATION_SQL_0009 = fs.readFileSync(
  path.join(
    process.cwd(),
    'src/lib/db/migrations/0009_project_translation_memory.sql',
  ),
  'utf8',
)

function addFrozenProjectTerm(
  db: Database.Database,
  sessionId: string,
): void {
  const sessionColumns = new Set(
    (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>)
      .map((column) => column.name),
  )
  if (!sessionColumns.has('direction')) {
    db.exec("ALTER TABLE sessions ADD COLUMN direction TEXT NOT NULL DEFAULT 'en_to_zh'")
  }
  if (!sessionColumns.has('task_brief')) {
    db.exec("ALTER TABLE sessions ADD COLUMN task_brief TEXT NOT NULL DEFAULT ''")
  }
  db.prepare(
    "UPDATE sessions SET direction='en_to_zh', task_brief=? WHERE id=?",
  ).run('保持叙事语气。', sessionId)

  const projectRepos = createProjectRepositories(db)
  const project = projectRepos.projects.create({
    name: 'Frozen terminology project',
    description: 'User-approved terminology for this translation.',
    direction: 'en_to_zh',
    sourceLang: 'English',
    targetLang: 'Chinese',
  })
  const resource = projectRepos.resources.create(project.id, {
    kind: 'term',
    content: {
      sourceText: 'Moon Gate',
      targetText: '月门',
      instruction: null,
      note: '沿用用户批准的既有译名。',
    },
  })
  const approved = projectRepos.resources.approve(
    project.id,
    resource.resource.id,
    { revisionId: resource.currentRevision.id },
  )
  const frozenResources = projectRepos.snapshots.getResources(
    project.id,
    approved.snapshot.id,
  )
  projectRepos.sessionProjectContexts.freezeForSession({
    sessionId,
    projectId: project.id,
    projectSnapshotId: approved.snapshot.id,
    direction: 'en_to_zh',
    resourceRevisionIds: approved.snapshot.approvedResourceRevisionIds,
    tokenEstimate: estimateProjectContextTokens(frozenResources),
  })
}

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
    db.exec(MIGRATION_SQL_0009)
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
    expect(combinedMessages).not.toContain('用户已批准的项目翻译档案')
    expect(combinedMessages).not.toContain('secret-that-must-not-be-returned')
    expect(combinedMessages).not.toContain('https://example.invalid')
    const bilingualCall = vi
      .mocked(chatCompletion)
      .mock.calls.find(([, llmRequest]) =>
        llmRequest.messages[0]?.content.includes('双语核验者'),
      )
    expect(bilingualCall?.[1].messages[1]).toEqual({
      role: 'user',
      content:
        '用户的感受：\n读着有点绕。\n\n' +
        '任务要求：\n无\n\n' +
        '完整原文：\nA source sentence.\n\n' +
        '当前完整译文：\n当前正式译文。',
    })
  })

  it('injects the frozen archive only into user messages and remains read-only', async () => {
    repos.finalVersions.insert({
      session_id: sessionId,
      version_no: 1,
      text: '当前正式译文。',
      source: 'assemble',
    })
    addFrozenProjectTerm(db, sessionId)
    const versionCountBefore = (
      db.prepare('SELECT COUNT(*) AS count FROM final_versions WHERE session_id=?')
        .get(sessionId) as { count: number }
    ).count

    const response = await POST(request({ message: '术语读起来不一致。' }), {
      params: Promise.resolve({ id: sessionId }),
    })

    expect(response.status).toBe(200)
    const promptMessages = vi
      .mocked(chatCompletion)
      .mock.calls.flatMap(([, llmRequest]) => llmRequest.messages)
    const userText = promptMessages
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
      .join('\n')
    const systemText = promptMessages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n')
    const allPromptText = promptMessages
      .map((message) => message.content)
      .join('\n')
    const versionCountAfter = (
      db.prepare('SELECT COUNT(*) AS count FROM final_versions WHERE session_id=?')
        .get(sessionId) as { count: number }
    ).count

    expect(userText).toContain('用户已批准的项目翻译档案（本会话冻结快照）')
    expect(userText).toContain('Moon Gate → 月门')
    expect(systemText).not.toContain('Moon Gate')
    expect(systemText).not.toContain('月门')
    expect(allPromptText).not.toContain('secret-that-must-not-be-returned')
    expect(allPromptText).not.toContain('https://example.invalid')
    expect(versionCountAfter).toBe(versionCountBefore)
  })

  it('returns only a safe diagnostic when the provider error contains sensitive data', async () => {
    repos.finalVersions.insert({
      session_id: sessionId,
      version_no: 1,
      text: 'Current approved translation.',
      source: 'assemble',
    })
    const providerLeak =
      'upstream rejected key sk-live-secret at https://provider.invalid/v1: A source sentence.'
    vi.mocked(chatCompletion).mockRejectedValue(
      Object.assign(new Error(providerLeak), { code: 'sk-live-secret' }),
    )
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const response = await POST(request({ message: 'Please review this version.' }), {
        params: Promise.resolve({ id: sessionId }),
      })

      expect(response.status).toBe(502)
      const body = await response.json()
      expect(body).toMatchObject({
        error: 'suggestion_failed',
        message: '生成修订建议失败，请稍后重试。',
      })
      expect(body.diagnosticId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      )

      const publicPayload = JSON.stringify(body)
      const diagnostics = JSON.stringify(consoleError.mock.calls)
      for (const sensitive of [
        'sk-live-secret',
        'https://provider.invalid/v1',
        'A source sentence.',
      ]) {
        expect(publicPayload).not.toContain(sensitive)
        expect(diagnostics).not.toContain(sensitive)
      }
      expect(diagnostics).toContain(body.diagnosticId)
    } finally {
      consoleError.mockRestore()
    }
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
