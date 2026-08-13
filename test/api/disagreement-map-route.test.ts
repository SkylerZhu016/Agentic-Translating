import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createHandlers } from '../../app/api/sessions/[id]/disagreement-map/handlers'
import { migrate } from '../../src/lib/db/migrate'

interface InvocationSeed {
  id: string
  body: string | null
  createdAt: string
  status?: 'queued' | 'running' | 'complete' | 'failed' | 'interrupted'
  replaces?: string | null
  catalogName?: string
  archetypeId?: string
  roleKind?: string
  snapshotModel?: string
  rowModel?: string
  annotation?: string | null
  rawOutput?: string | null
  snapshotExtras?: Record<string, unknown>
}

describe('GET /api/sessions/:id/disagreement-map', () => {
  let db: Database.Database
  const sessionId = 'disagreement-session'

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    db.prepare(`
      INSERT INTO sessions (
        id, source_text, source_lang, target_lang, state, config_snapshot,
        direction, task_brief, review_mode
      ) VALUES (?, ?, 'English', 'Chinese', 'assembled', ?, 'en_to_zh', '', 'main_editor')
    `).run(
      sessionId,
      'One source sentence.',
      JSON.stringify({ apiKey: 'SESSION_API_KEY_MUST_NOT_LEAK' }),
    )
    db.prepare(`
      INSERT INTO orchestration_runs (id, session_id, status, phase)
      VALUES ('map-run', ?, 'complete', 'team')
    `).run(sessionId)
  })

  afterEach(() => {
    db.close()
  })

  function setFinal(text: string) {
    const inserted = db.prepare(`
      INSERT INTO final_versions (session_id, version_no, text, source)
      VALUES (?, 1, ?, 'assemble')
    `).run(sessionId, text)
    db.prepare('UPDATE sessions SET final_version_id = ? WHERE id = ?').run(
      Number(inserted.lastInsertRowid),
      sessionId,
    )
  }

  function addInvocation(seed: InvocationSeed) {
    const snapshot = {
      id: `variant-${seed.id}`,
      archetypeId: seed.archetypeId ?? `archetype-${seed.id}`,
      catalogName: seed.catalogName ?? `Agent ${seed.id}`,
      roleKind: seed.roleKind,
      model: seed.snapshotModel,
      rolePrompt: 'ROLE_PROMPT_MUST_NOT_LEAK',
      ...seed.snapshotExtras,
    }
    db.prepare(`
      INSERT INTO agent_invocations (
        id, session_id, parent_run_id, agent_variant_id, agent_snapshot,
        endpoint_id, model, status, raw_output, body_output,
        annotation_output, replaces_invocation_id, created_at, updated_at
      ) VALUES (?, ?, 'map-run', ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      seed.id,
      sessionId,
      `variant-${seed.id}`,
      JSON.stringify(snapshot),
      seed.rowModel ?? `row-model-${seed.id}`,
      seed.status ?? 'complete',
      seed.rawOutput ?? seed.body,
      seed.body,
      seed.annotation ?? null,
      seed.replaces ?? null,
      seed.createdAt,
      seed.createdAt,
    )
  }

  async function get(id = sessionId) {
    return createHandlers(db).GET(
      new Request(`http://localhost/api/sessions/${id}/disagreement-map`),
      { params: Promise.resolve({ id }) },
    )
  }

  it('keeps only the latest successful non-empty candidate in each retry chain', async () => {
    setFinal('The newest alpha wording.')
    addInvocation({
      id: 'alpha-root',
      body: 'The obsolete alpha wording.',
      createdAt: '2026-08-09 00:00:01',
    })
    addInvocation({
      id: 'alpha-retry',
      body: 'The newest alpha wording.',
      replaces: 'alpha-root',
      // SQLite timestamps have second precision. The retry must still win when
      // its UUID sorts before the ancestor and both share one timestamp.
      createdAt: '2026-08-09 00:00:01',
      catalogName: 'Alpha translator',
      snapshotModel: 'snapshot-alpha-model',
    })
    addInvocation({
      id: 'alpha-failed-after-success',
      body: 'A failed body must not replace the success.',
      status: 'failed',
      replaces: 'alpha-retry',
      createdAt: '2026-08-09 00:00:02',
    })
    addInvocation({
      id: 'beta-root',
      body: 'Moonlight turns the sentence pale.',
      createdAt: '2026-08-09 00:00:03',
      catalogName: 'Beta translator',
    })
    addInvocation({
      id: 'context-row',
      body: 'Context analysis is not a translation candidate.',
      createdAt: '2026-08-09 00:00:04',
      roleKind: 'context_analysis',
    })
    addInvocation({
      id: 'poetry-plan-row',
      body: 'A poetry plan is not a translation candidate.',
      createdAt: '2026-08-09 00:00:05',
      roleKind: 'poetry_plan',
    })
    addInvocation({
      id: 'cultural-row',
      body: 'Cultural context is not a translation candidate.',
      createdAt: '2026-08-09 00:00:06',
      archetypeId: 'cultural-context',
    })
    addInvocation({
      id: 'blank-row',
      body: '   ',
      createdAt: '2026-08-09 00:00:07',
    })

    const response = await get()
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('ready')

    const visibleCandidates = body.hotspots.flatMap(
      (hotspot: { candidates: unknown[] }) => hotspot.candidates,
    ) as Array<{
      invocationId: string
      agentName: string
      model: string
      bodySegment: string
    }>
    expect(new Set(visibleCandidates.map((candidate) => candidate.invocationId))).toEqual(
      new Set(['alpha-retry', 'beta-root']),
    )
    expect(visibleCandidates).toContainEqual(
      expect.objectContaining({
        invocationId: 'alpha-retry',
        agentName: 'Alpha translator',
        model: 'snapshot-alpha-model',
        bodySegment: 'The newest alpha wording.',
      }),
    )
    expect(JSON.stringify(body)).not.toContain('obsolete alpha')
    expect(JSON.stringify(body)).not.toContain('failed body')
    expect(JSON.stringify(body)).not.toContain('Context analysis')
    expect(JSON.stringify(body)).not.toContain('poetry plan')
    expect(JSON.stringify(body)).not.toContain('Cultural context')
  })

  it('never exposes annotations, raw output, prompts, snapshots, or keys', async () => {
    setFinal('Public final text.')
    addInvocation({
      id: 'safe-a',
      body: 'Public candidate A.',
      rawOutput: 'Public candidate A.\n---\nRAW_PRIVATE_NOTE_MUST_NOT_LEAK',
      annotation: 'ANNOTATION_SECRET_MUST_NOT_LEAK',
      createdAt: '2026-08-09 00:00:01',
      snapshotExtras: { apiKey: 'SNAPSHOT_API_KEY_MUST_NOT_LEAK' },
    })
    addInvocation({
      id: 'safe-b',
      body: 'A distinctly public candidate B.',
      annotation: 'SECOND_ANNOTATION_MUST_NOT_LEAK',
      createdAt: '2026-08-09 00:00:02',
    })

    const response = await get()
    const serialized = JSON.stringify(await response.json())

    expect(response.status).toBe(200)
    expect(serialized).toContain('Public candidate A.')
    expect(serialized).not.toContain('ANNOTATION_SECRET')
    expect(serialized).not.toContain('RAW_PRIVATE_NOTE')
    expect(serialized).not.toContain('ROLE_PROMPT')
    expect(serialized).not.toContain('API_KEY_MUST_NOT_LEAK')
    expect(serialized).not.toMatch(
      /annotation_output|raw_output|rolePrompt|agent_snapshot|apiKey|api_key/,
    )
  })

  it('returns the algorithm full-text fallback with status 200', async () => {
    setFinal('Current final translation.')
    addInvocation({
      id: 'only-candidate',
      body: 'Only available candidate.',
      createdAt: '2026-08-09 00:00:01',
    })

    const response = await get()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.status).toBe('full_text_fallback')
    expect(body.fallback).toEqual(
      expect.objectContaining({
        reason: 'insufficient_candidates',
        message: '本次只能按全文比较',
        sourceText: 'One source sentence.',
        finalText: 'Current final translation.',
        candidates: [
          expect.objectContaining({
            invocationId: 'only-candidate',
            body: 'Only available candidate.',
          }),
        ],
      }),
    )
  })

  it('returns 404 when the session does not exist', async () => {
    const response = await get('missing-session')

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({
      error: 'session_not_found',
    })
  })
})
