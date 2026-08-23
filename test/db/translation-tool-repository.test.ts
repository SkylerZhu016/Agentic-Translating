import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import { migrate } from '../../src/lib/db/migrate'
import {
  createTranslationToolRepository,
  TranslationToolRepositoryError,
} from '../../src/lib/db/translation-tool-repository'

describe('translation tool trace and issue repository', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    db.prepare(`
      INSERT INTO sessions (id, source_text, config_snapshot)
      VALUES ('session-1', 'source', '{}')
    `).run()
    db.prepare(`
      INSERT INTO orchestration_runs (id, session_id, status, phase)
      VALUES ('run-1', 'session-1', 'running', 'review')
    `).run()
    db.prepare(`
      INSERT INTO agent_invocations (
        id, session_id, parent_run_id, agent_variant_id, agent_snapshot,
        endpoint_id, model, status
      ) VALUES (
        'invocation-1', 'session-1', 'run-1', 'agent-1', '{}', 1,
        'model-1', 'running'
      )
    `).run()
  })

  afterEach(() => db.close())

  it('migrates tool traces and issues with their audit indexes', () => {
    expect(
      db.prepare('SELECT name FROM migrations WHERE version = 15').pluck().get(),
    ).toBe('0015_translation_tool_traces.sql')
    expect(
      db.prepare('SELECT name FROM migrations WHERE version = 16').pluck().get(),
    ).toBe('0016_translation_tool_trace_upgrade.sql')
    expect(
      db.prepare('SELECT name FROM migrations WHERE version = 17').pluck().get(),
    ).toBe('0017_session_snapshot_credential_cleanup.sql')
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agent_tool_calls','review_issues') ORDER BY name",
      )
      .pluck()
      .all()
    expect(tables).toEqual(['agent_tool_calls', 'review_issues'])
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('agent_tool_calls','review_issues')",
      )
      .pluck()
      .all()
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_agent_tool_calls_run_stage_created',
        'idx_agent_tool_calls_invocation_created',
        'idx_agent_tool_calls_parent_created',
        'uq_agent_tool_calls_run_logical_call',
        'uq_agent_tool_calls_invocation_provider_call',
        'uq_agent_tool_calls_one_completed_write',
        'idx_review_issues_session_status_created',
        'idx_review_issues_source_tool',
      ]),
    )
  })

  it('persists invocation linkage, parentage, arguments, result and evidence', () => {
    const repository = createTranslationToolRepository(db)
    const parent = repository.beginCall({
      id: 'tool-parent',
      sessionId: 'session-1',
      runId: 'run-1',
      invocationId: 'invocation-1',
      stage: 'review',
      actor: 'main_agent',
      depth: 0,
      toolName: 'request_review',
      arguments: {
        segment: 'translated segment',
        question: 'Check agency.',
        evidenceIds: ['evidence-1'],
      },
      evidenceIds: ['evidence-1'],
    })
    expect(parent.status).toBe('running')
    expect(repository.countReviewRequests({
      sessionId: 'session-1',
      runId: 'run-1',
      stage: 'review',
    })).toBe(1)

    repository.beginCall({
      id: 'tool-child',
      sessionId: 'session-1',
      runId: 'run-1',
      invocationId: 'invocation-1',
      parentToolCallId: parent.id,
      stage: 'review',
      actor: 'review_subagent',
      depth: 1,
      toolName: 'inspect_evidence',
      arguments: {
        evidenceIds: ['evidence-1'],
        inheritanceMode: 'body_only',
      },
      evidenceIds: ['evidence-1'],
    })
    const completed = repository.completeCall('tool-child', {
      result: {
        inheritanceMode: 'body_only',
        items: [{ evidenceId: 'evidence-1', body: 'body' }],
      },
      evidenceIds: ['evidence-1'],
    })

    expect(completed).toMatchObject({
      sessionId: 'session-1',
      runId: 'run-1',
      invocationId: 'invocation-1',
      parentToolCallId: 'tool-parent',
      toolName: 'inspect_evidence',
      actor: 'review_subagent',
      depth: 1,
      status: 'complete',
      evidenceIds: ['evidence-1'],
    })
    expect(completed.input).toEqual({
      evidenceIds: ['evidence-1'],
      inheritanceMode: 'body_only',
    })
    expect(completed.output).toEqual({
      inheritanceMode: 'body_only',
      items: [{ evidenceId: 'evidence-1', body: 'body' }],
    })
    expect(completed.completedAt).not.toBeNull()
  })

  it('records and resolves located review issues without rewriting history', () => {
    const repository = createTranslationToolRepository(db)
    repository.beginCall({
      id: 'tool-issue',
      sessionId: 'session-1',
      runId: 'run-1',
      invocationId: 'invocation-1',
      stage: 'review',
      actor: 'main_agent',
      depth: 0,
      toolName: 'record_issue',
      arguments: { title: 'Agency shift' },
      evidenceIds: ['evidence-1'],
    })
    const issue = repository.createIssue({
      id: 'issue-1',
      sessionId: 'session-1',
      runId: 'run-1',
      invocationId: 'invocation-1',
      sourceToolCallId: 'tool-issue',
      stage: 'review',
      title: 'Agency shift',
      details: 'The subject and object are reversed.',
      location: { quote: 'translated segment', startOffset: 4, endOffset: 22 },
      category: 'fidelity',
      severity: 'high',
      evidenceIds: ['evidence-1'],
    })
    expect(issue).toMatchObject({
      id: 'issue-1',
      status: 'open',
      sourceToolCallId: 'tool-issue',
      evidenceIds: ['evidence-1'],
    })

    const resolved = repository.updateIssueStatus({
      id: issue.id,
      status: 'resolved',
      resolution: 'Accepted patch proposal tool-patch.',
    })
    expect(resolved.status).toBe('resolved')
    expect(resolved.resolution).toBe('Accepted patch proposal tool-patch.')
    expect(resolved.resolvedAt).not.toBeNull()
    expect(repository.listIssues({ sessionId: 'session-1', status: 'resolved' }))
      .toHaveLength(1)
  })

  it('allows each running call to reach exactly one terminal state', () => {
    const repository = createTranslationToolRepository(db)
    repository.beginCall({
      id: 'tool-failed',
      sessionId: 'session-1',
      runId: 'run-1',
      stage: 'review',
      actor: 'main_agent',
      depth: 0,
      toolName: 'search_project_memory',
      arguments: { query: 'name' },
    })
    const failed = repository.failCall('tool-failed', {
      errorCode: 'memory_lookup_failed',
      errorMessage: 'Frozen project context is unavailable.',
    })
    expect(failed).toMatchObject({
      status: 'failed',
      errorCode: 'memory_lookup_failed',
      errorMessage: 'Frozen project context is unavailable.',
      output: null,
    })

    expect(() =>
      repository.completeCall('tool-failed', { result: { items: [] } }),
    ).toThrowError(TranslationToolRepositoryError)

    repository.beginCall({
      id: 'tool-cancelled',
      sessionId: 'session-1',
      runId: 'run-1',
      stage: 'review',
      actor: 'main_agent',
      depth: 0,
      toolName: 'search_project_memory',
      arguments: { query: 'cancelled lookup' },
    })
    repository.failCall('tool-cancelled', {
      status: 'cancelled',
      errorCode: 'tool_cancelled',
    })
    expect(() =>
      repository.completeCall('tool-cancelled', { result: { items: [] } }),
    ).toThrowError(TranslationToolRepositoryError)
    expect(() => db.prepare(`
      UPDATE agent_tool_calls SET status='complete', output_json='{}'
      WHERE id='tool-cancelled'
    `).run()).toThrow(/terminal agent tool calls are immutable/)
  })

  it('redacts the current endpoint credential before persisting a tool failure', () => {
    const currentKey = 'CURRENT-TOOL-KEY-SENTINEL-982734'
    db.prepare('UPDATE endpoints SET api_key=? WHERE id=1').run(currentKey)
    const repository = createTranslationToolRepository(db)
    repository.beginCall({
      id: 'tool-secret-failure',
      sessionId: 'session-1',
      runId: 'run-1',
      invocationId: 'invocation-1',
      stage: 'review',
      actor: 'main_agent',
      depth: 0,
      toolName: 'request_review',
      arguments: {
        segment: 'translated segment',
        question: 'Check this segment.',
        evidenceIds: [],
      },
    })

    const failed = repository.failCall('tool-secret-failure', {
      errorCode: 'review_provider_failed',
      errorMessage: `provider rejected Authorization: Bearer ${currentKey}`,
    })
    const persisted = db.prepare(
      'SELECT error_message FROM agent_tool_calls WHERE id=?',
    ).get('tool-secret-failure') as { error_message: string }

    expect(failed.errorMessage).toContain('[REDACTED_CREDENTIAL]')
    expect(failed.errorMessage).not.toContain(currentKey)
    expect(persisted.error_message).toBe(failed.errorMessage)
  })

  it('stores replayable payloads, versioned handlers and exact patch hashes', () => {
    const repository = createTranslationToolRepository(db)
    const input = {
      baseVersionId: 7,
      oldText: 'exact source span',
      replacement: 'exact replacement',
      reason: 'Evidence-backed correction.',
      evidenceIds: ['evidence-1'],
    }
    repository.beginCall({
      id: 'tool-proposal',
      sessionId: 'session-1',
      runId: 'run-1',
      stage: 'edit',
      actor: 'main_agent',
      depth: 0,
      toolName: 'propose_patch',
      arguments: input,
      evidenceIds: input.evidenceIds,
      providerSeed: 42,
      determinismLevel: 'seeded_best_effort',
      providerToolCallId: 'provider-call-proposal',
      logicalCallKey: 'proposal-logical-call',
    })
    const completed = repository.completeCall('tool-proposal', {
      result: { proposalId: 'tool-proposal', status: 'proposed' },
    })

    expect(completed.input).toEqual(input)
    expect(completed.output).toEqual({
      proposalId: 'tool-proposal',
      status: 'proposed',
    })
    expect(completed.schemaVersion).toBe('translation-tools/v1')
    expect(completed.handlerVersion).toBe('translation-tool-runtime/v1')
    expect(completed.inputSummary).not.toContain(input.oldText)
    expect(completed.outputSummary).not.toContain('tool-proposal')
    expect(completed).toMatchObject({
      baseVersionId: 7,
      oldTextHash: createHash('sha256').update(input.oldText).digest('hex'),
      oldTextLength: input.oldText.length,
      replacementHash: createHash('sha256')
        .update(input.replacement)
        .digest('hex'),
      replacementLength: input.replacement.length,
      providerSeed: 42,
      determinismLevel: 'seeded_best_effort',
      providerToolCallId: 'provider-call-proposal',
      logicalCallKey: 'proposal-logical-call',
    })
  })

  it('recovers one run-scoped logical call and rejects conflicting replay input', () => {
    const repository = createTranslationToolRepository(db)
    const original = repository.beginCall({
      id: 'tool-logical-original',
      sessionId: 'session-1',
      runId: 'run-1',
      invocationId: 'invocation-1',
      providerToolCallId: 'provider-logical-original',
      logicalCallKey: 'logical-call-1',
      stage: 'review',
      actor: 'main_agent',
      depth: 0,
      toolName: 'search_project_memory',
      arguments: { query: 'term' },
    })
    const recovered = repository.beginCall({
      id: 'tool-logical-retry',
      sessionId: 'session-1',
      runId: 'run-1',
      invocationId: 'invocation-1',
      providerToolCallId: 'provider-logical-retry',
      logicalCallKey: 'logical-call-1',
      stage: 'review',
      actor: 'main_agent',
      depth: 0,
      toolName: 'search_project_memory',
      arguments: { query: 'term' },
    })
    expect(recovered.id).toBe(original.id)
    expect(recovered.providerToolCallId).toBe('provider-logical-original')
    expect(() => repository.beginCall({
      id: 'tool-logical-conflict',
      sessionId: 'session-1',
      runId: 'run-1',
      invocationId: 'invocation-1',
      logicalCallKey: 'logical-call-1',
      stage: 'review',
      actor: 'main_agent',
      depth: 0,
      toolName: 'search_project_memory',
      arguments: { query: 'different term' },
    })).toThrowError(TranslationToolRepositoryError)
  })

  it('retains audit rows while deleted orchestration links become null', () => {
    const repository = createTranslationToolRepository(db)
    repository.beginCall({
      id: 'tool-audit',
      sessionId: 'session-1',
      runId: 'run-1',
      invocationId: 'invocation-1',
      stage: 'review',
      actor: 'main_agent',
      depth: 0,
      toolName: 'search_project_memory',
      arguments: { query: 'term' },
    })
    repository.completeCall('tool-audit', { result: { items: [] } })

    db.prepare("DELETE FROM sessions WHERE id = 'session-1'").run()
    expect(repository.getCall('tool-audit')).toMatchObject({
      id: 'tool-audit',
      sessionId: null,
      runId: null,
      invocationId: null,
      status: 'complete',
    })
  })
})

function migrateThroughHistoricalV15(db: Database.Database): void {
  const migrationsDir = path.join(
    process.cwd(),
    'src',
    'lib',
    'db',
    'migrations',
  )
  db.exec(`
    CREATE TABLE migrations (
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `)
  const files = fs.readdirSync(migrationsDir)
    .filter((file) => /^\d+_.*\.sql$/u.test(file))
    .sort()
  for (const file of files) {
    const version = Number.parseInt(file.slice(0, 4), 10)
    if (version > 15) break
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
    db.transaction(() => {
      db.exec(sql)
      db.prepare(
        'INSERT INTO migrations (version, name) VALUES (?, ?)',
      ).run(version, file)
    })()
  }
}

describe('translation tool migration 16 compatibility', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrateThroughHistoricalV15(db)
    db.prepare(`
      INSERT INTO sessions (id, source_text, config_snapshot)
      VALUES ('legacy-session', 'source', '{}')
    `).run()
    db.prepare(`
      INSERT INTO orchestration_runs (id, session_id, status, phase)
      VALUES ('legacy-run', 'legacy-session', 'running', 'review')
    `).run()
    const endpointId = Number(db.prepare(`
      INSERT INTO endpoints (name, base_url, api_key)
      VALUES ('legacy-endpoint', 'https://example.invalid', '')
    `).run().lastInsertRowid)
    db.prepare(`
      INSERT INTO agent_invocations (
        id, session_id, parent_run_id, agent_variant_id, agent_snapshot,
        endpoint_id, model, status
      ) VALUES (
        'legacy-invocation', 'legacy-session', 'legacy-run', 'agent-1',
        '{}', ?, 'model-1', 'running'
      )
    `).run(endpointId)
    db.prepare(`
      INSERT INTO agent_tool_calls (
        id, session_id, run_id, invocation_id, parent_tool_call_id,
        stage, actor, depth, schema_version, handler_version, tool_name,
        input_json, output_json, input_summary, output_summary, status,
        error_code, error_message, evidence_ids_json, provider_seed,
        determinism_level, base_version_id, old_text_hash, old_text_length,
        replacement_hash, replacement_length, completed_at
      ) VALUES (
        'legacy-complete-call', 'legacy-session', 'legacy-run',
        'legacy-invocation', NULL, 'review', 'main_agent', 0,
        'translation-tools/v1', 'translation-tool-runtime/v1',
        'search_project_memory', '{"query":"legacy term"}',
        '{"items":[]}', 'legacy input', 'legacy output', 'complete',
        NULL, NULL, '[]', NULL, 'provider_default', NULL, NULL, NULL,
        NULL, NULL, datetime('now')
      )
    `).run()
  })

  afterEach(() => db.close())

  it('upgrades an applied historical v15 without losing traces or links', () => {
    const before = (db.prepare(
      "PRAGMA table_info('agent_tool_calls')",
    ).all() as Array<{ name: string }>).map((column) => column.name)
    expect(before).not.toContain('provider_tool_call_id')
    expect(before).not.toContain('logical_call_key')

    migrate(db)

    const after = (db.prepare(
      "PRAGMA table_info('agent_tool_calls')",
    ).all() as Array<{ name: string }>).map((column) => column.name)
    expect(after).toEqual(expect.arrayContaining([
      'provider_tool_call_id',
      'logical_call_key',
    ]))
    expect(db.prepare(
      'SELECT MAX(version) FROM migrations',
    ).pluck().get()).toBe(18)

    const repository = createTranslationToolRepository(db)
    expect(repository.getCall('legacy-complete-call')).toMatchObject({
      sessionId: 'legacy-session',
      runId: 'legacy-run',
      invocationId: 'legacy-invocation',
      providerToolCallId: null,
      logicalCallKey: null,
      status: 'complete',
      input: { query: 'legacy term' },
      output: { items: [] },
    })

    const begun = repository.beginCall({
      id: 'upgraded-new-call',
      sessionId: 'legacy-session',
      runId: 'legacy-run',
      invocationId: 'legacy-invocation',
      providerToolCallId: 'provider-new-call',
      logicalCallKey: 'logical-new-call',
      stage: 'review',
      actor: 'main_agent',
      depth: 0,
      toolName: 'search_project_memory',
      arguments: { query: 'new term' },
      determinismLevel: 'provider_default',
    })
    expect(begun).toMatchObject({
      providerToolCallId: 'provider-new-call',
      logicalCallKey: 'logical-new-call',
      status: 'running',
    })
    expect(repository.completeCall(begun.id, {
      result: { items: [] },
    })).toMatchObject({ status: 'complete' })
  })
})
