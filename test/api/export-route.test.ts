import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

import { migrate } from '../../src/lib/db/migrate'
import { createRepositories } from '../../src/lib/db/repositories'

const { mockGetDb } = vi.hoisted(() => ({
  mockGetDb: vi.fn<() => Database.Database>(),
}))

vi.mock('@/src/lib/db', () => ({
  getDb: mockGetDb,
}))

import { GET } from '../../app/api/sessions/[id]/export/route'

describe('GET /api/sessions/:id/export error redaction', () => {
  let db: Database.Database
  let repos: ReturnType<typeof createRepositories>

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    mockGetDb.mockReturnValue(db)
    repos = createRepositories(db)
    repos.sessions.insert({
      id: 'session-export-redaction',
      source_text: 'Safe source text',
      source_lang: 'English',
      target_lang: 'Chinese',
      state: 'draft',
      config_snapshot: '{}',
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
  })

  it('redacts historical result and stage errors in JSON and Markdown without rewriting the database', async () => {
    const rawResultError =
      'Bearer sk-export-result https://result.private/v1 LEAKED_RESULT_SOURCE LEAKED_RESULT_PROMPT'
    const rawStageError =
      'Bearer sk-export-stage https://stage.private/v1 LEAKED_STAGE_SOURCE LEAKED_STAGE_PROMPT'

    repos.translationResults.insert({
      session_id: 'session-export-redaction',
      agent_key: 'agent-alpha',
      agent_snapshot: '{}',
      status: 'error',
      output_text: null,
      error: rawResultError,
      latency_ms: 15,
      attempt: 1,
    })
    repos.stageOutputs.insert({
      session_id: 'session-export-redaction',
      stage: 'review',
      status: 'failed',
      prompt_used: null,
      raw_output: null,
      error: rawStageError,
    })

    const jsonResponse = await GET(
      new Request(
        'http://localhost/api/sessions/session-export-redaction/export?format=json',
      ),
      { params: Promise.resolve({ id: 'session-export-redaction' }) },
    )
    expect(jsonResponse.status).toBe(200)
    const exported = await jsonResponse.json()
    expect(exported.legacy_results[0]).toEqual(
      expect.objectContaining({
        error: '该历史翻译错误的原始详情已隐藏。',
        errorDiagnostic: expect.objectContaining({
          error: 'legacy_translation_error_redacted',
          message: '该历史翻译错误的原始详情已隐藏。',
          diagnosticId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          ),
        }),
      }),
    )
    expect(exported.stages[0]).toEqual(
      expect.objectContaining({
        error: '该历史统筹错误的原始详情已隐藏。',
        errorDiagnostic: expect.objectContaining({
          error: 'legacy_stage_error_redacted',
          message: '该历史统筹错误的原始详情已隐藏。',
          diagnosticId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          ),
        }),
      }),
    )

    const markdownResponse = await GET(
      new Request(
        'http://localhost/api/sessions/session-export-redaction/export?format=md',
      ),
      { params: Promise.resolve({ id: 'session-export-redaction' }) },
    )
    expect(markdownResponse.status).toBe(200)
    const markdown = await markdownResponse.text()
    expect(markdown).toContain('该历史统筹错误的原始详情已隐藏。')
    expect(markdown).toContain('- 错误代码：legacy_stage_error_redacted')
    expect(markdown).toContain(
      `- diagnosticId：${exported.stages[0].errorDiagnostic.diagnosticId}`,
    )

    const publicExports = `${JSON.stringify(exported)}\n${markdown}`
    for (const sensitive of [
      rawResultError,
      rawStageError,
      'sk-export-result',
      'sk-export-stage',
      'https://result.private/v1',
      'https://stage.private/v1',
      'LEAKED_RESULT_SOURCE',
      'LEAKED_RESULT_PROMPT',
      'LEAKED_STAGE_SOURCE',
      'LEAKED_STAGE_PROMPT',
    ]) {
      expect(publicExports).not.toContain(sensitive)
    }

    expect(
      repos.translationResults.getBySessionAndAgent(
        'session-export-redaction',
        'agent-alpha',
      )!.error,
    ).toBe(rawResultError)
    expect(
      repos.stageOutputs.getBySessionAndStage(
        'session-export-redaction',
        'review',
      )!.error,
    ).toBe(rawStageError)
  })
})
