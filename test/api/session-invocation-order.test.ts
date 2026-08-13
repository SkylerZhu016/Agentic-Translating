import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'

import { createHandlers } from '../../app/api/sessions/[id]/handlers'
import { migrate } from '../../src/lib/db/migrate'

describe('GET /api/sessions/:id invocation retry order', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
  })

  afterEach(() => {
    db.close()
  })

  it('uses insertion order when retry attempts have identical timestamps', async () => {
    const sessionId = 'session-invocation-order'
    const runId = 'run-invocation-order'
    const createdAt = '2026-08-11 12:00:00'
    const failedInvocationId = 'ffffffff-ffff-4fff-bfff-ffffffffffff'
    const retryInvocationId = '00000000-0000-4000-8000-000000000001'

    // The earlier attempt deliberately sorts after its retry by UUID.
    expect(failedInvocationId > retryInvocationId).toBe(true)

    db.prepare(`
      INSERT INTO sessions (id, source_text, config_snapshot)
      VALUES (?, 'Source text', '{}')
    `).run(sessionId)
    db.prepare(`
      INSERT INTO orchestration_runs (id, session_id, status, phase)
      VALUES (?, ?, 'complete', 'team')
    `).run(runId, sessionId)

    const insertInvocation = db.prepare(`
      INSERT INTO agent_invocations (
        id, session_id, parent_run_id, agent_variant_id, agent_snapshot,
        endpoint_id, model, status, body_output, replaces_invocation_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'translator-a', '{}', 1, 'test-model', ?, ?, ?, ?, ?)
    `)

    insertInvocation.run(
      failedInvocationId,
      sessionId,
      runId,
      'failed',
      null,
      null,
      createdAt,
      createdAt,
    )
    insertInvocation.run(
      retryInvocationId,
      sessionId,
      runId,
      'complete',
      'Completed retry',
      failedInvocationId,
      createdAt,
      createdAt,
    )

    const response = await createHandlers(db).GET(
      new NextRequest(`http://localhost/api/sessions/${sessionId}`),
      { params: Promise.resolve({ id: sessionId }) },
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.invocationChains).toHaveLength(1)
    expect(body.invocationChains[0]).toEqual(
      expect.objectContaining({
        rootInvocationId: failedInvocationId,
        attemptCount: 2,
        attempts: [
          expect.objectContaining({
            id: failedInvocationId,
            status: 'failed',
            replaces_invocation_id: null,
          }),
          expect.objectContaining({
            id: retryInvocationId,
            status: 'complete',
            replaces_invocation_id: failedInvocationId,
          }),
        ],
        currentInvocation: expect.objectContaining({
          id: retryInvocationId,
          status: 'complete',
          replaces_invocation_id: failedInvocationId,
        }),
      }),
    )
  })
})
