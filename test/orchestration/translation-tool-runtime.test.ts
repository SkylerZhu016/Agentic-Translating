import { createHash } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../../src/lib/db/migrate'
import { createTranslationToolRepository } from '../../src/lib/db/translation-tool-repository'
import {
  createTranslationToolRuntime,
  TranslationToolRuntimeError,
} from '../../src/lib/orchestration/translation-tool-runtime'

describe('translation tool runtime', () => {
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
  })

  afterEach(() => db.close())

  const context = () => ({
    sessionId: 'session-1',
    runId: 'run-1',
    invocationId: null,
    parentToolCallId: null,
    stage: 'review' as const,
    actor: 'main_agent' as const,
    depth: 0,
    allowedInheritanceMode: 'body_only' as const,
    knownEvidenceIds: ['evidence-1'],
    baseVersion: { id: 3, text: 'Current exact translation.' },
  })

  it('projects evidence before returning it and persists the completed trace', async () => {
    const repository = createTranslationToolRepository(db)
    const runtime = createTranslationToolRuntime({
      repository,
      handlers: {
        inspectEvidence: () => [{
          evidenceId: 'evidence-1',
          sourceType: 'agent_invocation',
          sourceId: 'candidate-1',
          raw: 'body\n---\nannotation-secret',
          body: 'body',
          annotation: 'annotation-secret',
          annotationMetadata: {
            source: 'candidate-1',
            version: 'fsbp-v1',
            hash: createHash('sha256').update('annotation-secret').digest('hex'),
          },
        }],
        searchProjectMemory: () => ({ items: [] }),
        requestReview: () => ({
          reviewInvocationId: 'review-invocation-1',
          evidence: {
            evidenceId: 'review-evidence-1',
            sourceType: 'agent_invocation',
            sourceId: 'review-invocation-1',
            raw: 'review body\n---\nreview annotation',
            body: 'review body',
            annotation: 'review annotation',
            annotationMetadata: {
              source: 'review-invocation-1',
              version: 'fsbp-v1',
              hash: createHash('sha256').update('review annotation').digest('hex'),
            },
          },
        }),
      },
    })

    const executed = await runtime.execute({
      id: 'tool-inspect',
      name: 'inspect_evidence',
      args: {
        evidenceIds: ['evidence-1'],
        inheritanceMode: 'body_only',
      },
      context: context(),
    })

    expect(executed.result).toEqual({
      inheritanceMode: 'body_only',
      items: [{
        evidenceId: 'evidence-1',
        sourceType: 'agent_invocation',
        sourceId: 'candidate-1',
        body: 'body',
      }],
    })
    expect(JSON.stringify(executed.result)).not.toContain('annotation-secret')
    expect(executed.trace).toMatchObject({
      id: 'tool-inspect',
      status: 'complete',
      evidenceIds: ['evidence-1'],
    })
  })

  it('dispatches at most two review requests in one stage and traces rejection', async () => {
    const repository = createTranslationToolRepository(db)
    const requestReview = vi.fn(() => ({
      reviewInvocationId: `review-invocation-${requestReview.mock.calls.length}`,
      evidence: {
        evidenceId: `review-evidence-${requestReview.mock.calls.length}`,
        sourceType: 'agent_invocation' as const,
        sourceId: `review-invocation-${requestReview.mock.calls.length}`,
        raw: 'review body\n---\nprivate note',
        body: 'review body',
        annotation: 'private note',
        annotationMetadata: {
          source: `review-invocation-${requestReview.mock.calls.length}`,
          version: 'fsbp-v1',
          hash: createHash('sha256').update('private note').digest('hex'),
        },
      },
    }))
    const runtime = createTranslationToolRuntime({
      repository,
      handlers: {
        inspectEvidence: () => [],
        searchProjectMemory: () => ({ items: [] }),
        requestReview,
      },
    })
    const args = {
      segment: 'Current exact translation.',
      question: 'Check the subject.',
      evidenceIds: ['evidence-1'],
    }

    await runtime.execute({
      id: 'review-tool-1',
      name: 'request_review',
      args,
      context: context(),
    })
    await runtime.execute({
      id: 'review-tool-2',
      name: 'request_review',
      args,
      context: context(),
    })

    let rejected: unknown
    try {
      await runtime.execute({
        id: 'review-tool-3',
        name: 'request_review',
        args,
        context: context(),
      })
    } catch (error) {
      rejected = error
    }
    expect(rejected).toBeInstanceOf(TranslationToolRuntimeError)
    expect(rejected).toMatchObject({ code: 'review_limit_exceeded' })
    expect(requestReview).toHaveBeenCalledTimes(2)
    expect(repository.getCall('review-tool-3')).toMatchObject({
      status: 'failed',
      errorCode: 'review_limit_exceeded',
    })
  })

  it('rejects request_review before its paid handler when any evidence ID is missing', async () => {
    const repository = createTranslationToolRepository(db)
    const requestReview = vi.fn()
    const runtime = createTranslationToolRuntime({
      repository,
      handlers: {
        inspectEvidence: () => [],
        searchProjectMemory: () => ({ items: [] }),
        requestReview,
      },
    })

    await expect(runtime.execute({
      id: 'review-missing-memory',
      name: 'request_review',
      args: {
        segment: 'Current exact translation.',
        question: 'Check this against project memory.',
        evidenceIds: ['evidence-1', 'missing-project-memory'],
      },
      context: context(),
    })).rejects.toMatchObject({ code: 'evidence_not_found' })
    expect(requestReview).not.toHaveBeenCalled()
    expect(repository.getCall('review-missing-memory')).toMatchObject({
      status: 'failed',
      errorCode: 'evidence_not_found',
    })
  })

  it('returns only the redacted persisted failure across the tool boundary', async () => {
    const currentKey = 'CURRENT-REVIEW-KEY-SENTINEL-463821'
    db.prepare('UPDATE endpoints SET api_key=? WHERE id=1').run(currentKey)
    const repository = createTranslationToolRepository(db)
    const runtime = createTranslationToolRuntime({
      repository,
      handlers: {
        inspectEvidence: () => [],
        searchProjectMemory: () => ({ items: [] }),
        requestReview: () => {
          throw new Error(`review upstream Authorization: Bearer ${currentKey}`)
        },
      },
    })

    let rejected: unknown
    try {
      await runtime.execute({
        id: 'review-secret-failure',
        name: 'request_review',
        args: {
          segment: 'Current exact translation.',
          question: 'Check the subject.',
          evidenceIds: ['evidence-1'],
        },
        context: context(),
      })
    } catch (error) {
      rejected = error
    }

    expect(rejected).toBeInstanceOf(TranslationToolRuntimeError)
    expect((rejected as Error).message).toContain('[REDACTED_CREDENTIAL]')
    expect((rejected as Error).message).not.toContain(currentKey)
    expect(repository.getCall('review-secret-failure')).toMatchObject({
      status: 'failed',
      errorMessage: expect.stringContaining('[REDACTED_CREDENTIAL]'),
    })
    expect(JSON.stringify(repository.getCall('review-secret-failure')))
      .not.toContain(currentKey)
  })

  it('records issues and keeps propose_patch non-applying by default', async () => {
    const repository = createTranslationToolRepository(db)
    const runtime = createTranslationToolRuntime({
      repository,
      handlers: {
        inspectEvidence: () => [],
        searchProjectMemory: () => ({ items: [] }),
        requestReview: () => ({
          reviewInvocationId: 'review-invocation',
          evidence: {
            evidenceId: 'review-evidence',
            sourceType: 'agent_invocation',
            sourceId: 'review-invocation',
            raw: 'body',
            body: 'body',
            annotation: null,
            annotationMetadata: null,
          },
        }),
      },
    })

    const issue = await runtime.execute({
      id: 'tool-record-issue',
      name: 'record_issue',
      args: {
        title: 'Agency shift',
        details: 'The translated subject differs from the source.',
        location: { quote: 'Current exact translation.' },
        category: 'fidelity',
        severity: 'high',
        evidenceIds: ['evidence-1'],
      },
      context: context(),
    })
    expect(issue.result).toEqual({ issueId: expect.any(String), status: 'open' })
    expect(repository.listIssues({ sessionId: 'session-1' })).toHaveLength(1)

    const proposal = await runtime.execute({
      id: 'tool-patch',
      name: 'propose_patch',
      args: {
        baseVersionId: 3,
        oldText: 'Current exact translation.',
        replacement: 'Revised exact translation.',
        reason: 'Restore the source subject.',
        evidenceIds: ['evidence-1'],
      },
      context: context(),
    })
    expect(proposal.result).toEqual({
      proposalId: 'tool-patch',
      status: 'proposed',
    })
    expect(context().baseVersion.text).toBe('Current exact translation.')
  })

  it('persists every replace_text batch outcome before validation and matching', async () => {
    const repository = createTranslationToolRepository(db)
    const runtime = createTranslationToolRuntime({
      repository,
      handlers: {
        inspectEvidence: () => [],
        searchProjectMemory: () => ({ items: [] }),
        requestReview: () => {
          throw new Error('not used')
        },
      },
    })

    const result = await runtime.executeReplaceTextBatch({
      context: context(),
      calls: [
        {
          id: 'replace-before',
          providerToolCallId: 'provider-before',
          args: {
            old_string: 'Current',
            new_string: 'Revised',
          },
        },
        {
          id: 'replace-failed',
          providerToolCallId: 'provider-failed',
          args: {
            old_string: 'missing exact passage',
            new_string: 'replacement',
          },
        },
        {
          id: 'replace-after',
          providerToolCallId: 'provider-after',
          args: {
            old_string: 'translation',
            new_string: 'rendering',
          },
        },
      ],
    })

    expect(result).toMatchObject({
      ok: false,
      failedIndex: 1,
      code: 'patch_target_not_found',
    })
    expect(repository.getCall('replace-before')).toMatchObject({
      providerToolCallId: 'provider-before',
      status: 'failed',
      errorCode: 'rolled_back',
    })
    expect(repository.getCall('replace-failed')).toMatchObject({
      status: 'failed',
      errorCode: 'patch_target_not_found',
    })
    expect(repository.getCall('replace-after')).toMatchObject({
      status: 'failed',
      errorCode: 'not_attempted',
    })
  })

  it('rolls back every rejected batch trace when one terminal write fails', () => {
    const repository = createTranslationToolRepository(db)
    const runtime = createTranslationToolRuntime({
      repository,
      handlers: {
        inspectEvidence: () => [],
        searchProjectMemory: () => ({ items: [] }),
        requestReview: () => {
          throw new Error('not used')
        },
      },
    })
    db.exec(`
      CREATE TRIGGER fail_second_rejected_trace
      BEFORE UPDATE OF status ON agent_tool_calls
      WHEN OLD.provider_tool_call_id = 'provider-reject-2'
      BEGIN
        SELECT RAISE(ABORT, 'injected reject persistence failure');
      END;
    `)

    expect(() => runtime.rejectReplaceTextBatch({
      context: context(),
      reason: 'The entire edit batch was rejected.',
      calls: [
        {
          id: 'reject-atomic-1',
          providerToolCallId: 'provider-reject-1',
          args: { old_string: 'Current', new_string: 'Revised' },
        },
        {
          id: 'reject-atomic-2',
          providerToolCallId: 'provider-reject-2',
          args: { invalidJsonArguments: '{broken' },
        },
        {
          id: 'reject-atomic-3',
          providerToolCallId: 'provider-reject-3',
          args: { old_string: 'translation', new_string: 'rendering' },
        },
      ],
    })).toThrow(/injected reject persistence failure/)
    expect(repository.listCalls({ sessionId: 'session-1' })).toHaveLength(0)
  })

  it('makes write_draft persistence and trace completion atomic and replayable', async () => {
    const repository = createTranslationToolRepository(db)
    let handlerCalls = 0
    const runtime = createTranslationToolRuntime({
      repository,
      handlers: {
        inspectEvidence: () => [],
        searchProjectMemory: () => ({ items: [] }),
        requestReview: () => {
          throw new Error('not used')
        },
        writeDraft: (args) => {
          handlerCalls += 1
          const inserted = db.prepare(`
            INSERT INTO final_versions
              (session_id, version_no, text, source, content_hash)
            VALUES ('session-1', 1, ?, 'main_draft', ?)
          `).run(
            args.text,
            createHash('sha256').update(args.text).digest('hex'),
          )
          return { versionId: Number(inserted.lastInsertRowid), versionNo: 1 }
        },
      },
    })
    const request = {
      id: 'write-trace',
      providerToolCallId: 'provider-write-1',
      logicalCallKey: 'write-draft-logical-1',
      name: 'write_draft',
      args: {
        text: 'First draft.',
        reason: 'Two candidates agree.',
        evidenceInvocationIds: ['candidate-1', 'candidate-2'],
      },
      context: {
        ...context(),
        knownEvidenceIds: ['candidate-1', 'candidate-2'],
      },
    }
    const first = await runtime.execute(request)
    const replay = await runtime.execute({ ...request, id: 'ignored-replay-id' })

    expect(handlerCalls).toBe(1)
    expect(replay.callId).toBe(first.callId)
    expect(replay.result).toEqual(first.result)
    expect(repository.getCall(first.callId)).toMatchObject({
      providerToolCallId: 'provider-write-1',
      logicalCallKey: 'write-draft-logical-1',
      status: 'complete',
    })
    expect(db.prepare(
      "SELECT count(*) FROM final_versions WHERE session_id='session-1'",
    ).pluck().get()).toBe(1)
  })

  it('rolls back a write handler mutation when the atomic write fails', async () => {
    const repository = createTranslationToolRepository(db)
    const runtime = createTranslationToolRuntime({
      repository,
      handlers: {
        inspectEvidence: () => [],
        searchProjectMemory: () => ({ items: [] }),
        requestReview: () => {
          throw new Error('not used')
        },
        writeDraft: (args) => {
          db.prepare(`
            INSERT INTO final_versions
              (session_id, version_no, text, source, content_hash)
            VALUES ('session-1', 1, ?, 'main_draft', ?)
          `).run(
            args.text,
            createHash('sha256').update(args.text).digest('hex'),
          )
          throw new Error('event persistence failed')
        },
      },
    })

    await expect(runtime.execute({
      id: 'write-rollback',
      logicalCallKey: 'write-draft-rollback',
      name: 'write_draft',
      args: {
        text: 'Draft that must roll back.',
        reason: 'Test rollback.',
        evidenceInvocationIds: ['candidate-1', 'candidate-2'],
      },
      context: {
        ...context(),
        knownEvidenceIds: ['candidate-1', 'candidate-2'],
      },
    })).rejects.toMatchObject({ code: 'tool_execution_failed' })
    expect(db.prepare(
      "SELECT count(*) FROM final_versions WHERE session_id='session-1'",
    ).pluck().get()).toBe(0)
    expect(repository.getCall('write-rollback')).toMatchObject({
      status: 'failed',
      errorCode: 'tool_execution_failed',
    })
  })
})
