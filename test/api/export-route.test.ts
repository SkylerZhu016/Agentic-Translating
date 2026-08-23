import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

import { migrate } from '../../src/lib/db/migrate'
import { createRepositories } from '../../src/lib/db/repositories'
import { createTranslationToolRepository } from '../../src/lib/db/translation-tool-repository'

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
    const currentToolKey = 'CURRENT-EXPORT-TOOL-KEY-SENTINEL-873245'
    const rawToolError =
      `review provider echoed Authorization: Bearer ${currentToolKey}`
    const rawStageOutput =
      `# Fidelity audit\nSafe audit body.\n\n---\nUnavailable audit passes:\ntask_specific: ${rawToolError}`

    repos.endpoints.insert({
      name: 'export-redaction-endpoint',
      base_url: 'https://redaction.invalid',
      api_key: currentToolKey,
    })
    db.prepare(`
      INSERT INTO orchestration_runs (id, session_id, status, phase)
      VALUES ('export-redaction-run', 'session-export-redaction', 'running', 'review')
    `).run()
    const toolRepo = createTranslationToolRepository(db)
    toolRepo.beginCall({
      id: 'export-secret-tool',
      sessionId: 'session-export-redaction',
      runId: 'export-redaction-run',
      stage: 'review',
      actor: 'main_agent',
      depth: 0,
      toolName: 'request_review',
      arguments: {
        segment: 'Safe audit body.',
        question: 'Check fidelity.',
        evidenceIds: [],
      },
    })
    // Simulate a historical row written before error redaction existed. Public
    // export remains the final defense even for already-persisted legacy data.
    db.prepare(`
      UPDATE agent_tool_calls
      SET status='failed', error_code='review_provider_failed',
          error_message=?, completed_at=datetime('now')
      WHERE id='export-secret-tool'
    `).run(rawToolError)

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
      stage: 'filter',
      status: 'failed',
      prompt_used: null,
      raw_output: null,
      error: rawStageError,
    })
    repos.stageOutputs.insert({
      session_id: 'session-export-redaction',
      stage: 'review',
      status: 'complete',
      prompt_used: null,
      raw_output: rawStageOutput,
      error: null,
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
      rawToolError,
      rawStageOutput,
      currentToolKey,
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
        'filter',
      )!.error,
    ).toBe(rawStageError)
  })

  it('never exports legacy credentials embedded in a historical session snapshot', async () => {
    const historicalSnapshot = {
      version: 3,
      endpoint: {
        id: 1,
        base_url: 'https://frozen.invalid',
        api_key: 'LEGACY_API_KEY_SENTINEL',
      },
      endpointSnapshots: [{
        id: 1,
        baseUrl: 'https://frozen.invalid',
        apiKey: 'LEGACY_CAMEL_KEY_SENTINEL',
      }],
    }
    db.prepare('UPDATE sessions SET config_snapshot=? WHERE id=?').run(
      JSON.stringify(historicalSnapshot),
      'session-export-redaction',
    )

    const jsonResponse = await GET(
      new Request(
        'http://localhost/api/sessions/session-export-redaction/export?format=json',
      ),
      { params: Promise.resolve({ id: 'session-export-redaction' }) },
    )
    const exported = await jsonResponse.json()
    const markdownResponse = await GET(
      new Request(
        'http://localhost/api/sessions/session-export-redaction/export?format=md',
      ),
      { params: Promise.resolve({ id: 'session-export-redaction' }) },
    )
    const publicPayload = `${JSON.stringify(exported)}\n${await markdownResponse.text()}`

    expect(publicPayload).not.toContain('LEGACY_API_KEY_SENTINEL')
    expect(publicPayload).not.toContain('LEGACY_CAMEL_KEY_SENTINEL')
    expect(exported.config_snapshot.endpoint).toEqual({
      id: 1,
      base_url: 'https://frozen.invalid',
    })
  })

  it('exports replayable translation tool traces and located review issues', async () => {
    db.prepare(`
      INSERT INTO orchestration_runs (id, session_id, status, phase)
      VALUES ('export-run', 'session-export-redaction', 'running', 'edit')
    `).run()
    const toolRepo = createTranslationToolRepository(db)
    toolRepo.beginCall({
      id: 'export-tool',
      sessionId: 'session-export-redaction',
      runId: 'export-run',
      stage: 'edit',
      actor: 'main_agent',
      depth: 0,
      toolName: 'record_issue',
      arguments: {
        title: 'Subject drift',
        details: 'The translated subject changed.',
        location: { quote: 'Safe source text' },
        category: 'fidelity',
        severity: 'high',
        evidenceIds: ['evidence-1'],
      },
      evidenceIds: ['evidence-1'],
    })
    toolRepo.createIssue({
      id: 'export-issue',
      sessionId: 'session-export-redaction',
      runId: 'export-run',
      sourceToolCallId: 'export-tool',
      stage: 'edit',
      title: 'Subject drift',
      details: 'The translated subject changed.',
      location: { quote: 'Safe source text' },
      category: 'fidelity',
      severity: 'high',
      evidenceIds: ['evidence-1'],
    })
    toolRepo.completeCall('export-tool', {
      result: { issueId: 'export-issue', status: 'open' },
    })

    const response = await GET(
      new Request(
        'http://localhost/api/sessions/session-export-redaction/export?format=json',
      ),
      { params: Promise.resolve({ id: 'session-export-redaction' }) },
    )
    const exported = await response.json()
    expect(exported.tool_calls[0]).toMatchObject({
      id: 'export-tool',
      status: 'complete',
      input: expect.objectContaining({ title: 'Subject drift' }),
      output: { issueId: 'export-issue', status: 'open' },
    })
    expect(exported.review_issues[0]).toMatchObject({
      id: 'export-issue',
      sourceToolCallId: 'export-tool',
    })
  })
})
