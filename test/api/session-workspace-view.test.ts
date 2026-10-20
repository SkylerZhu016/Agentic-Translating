import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../src/lib/db/migrate'
import { createHandlers } from '../../app/api/sessions/[id]/handlers'

describe('lightweight workspace session view', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    db.prepare(`
      INSERT INTO sessions (id, source_text, config_snapshot)
      VALUES ('session', 'Source text', '{}')
    `).run()
    db.prepare(`
      INSERT INTO orchestration_runs (id, session_id, status)
      VALUES ('run', 'session', 'complete')
    `).run()
    const insert = db.prepare(`
      INSERT INTO run_events (session_id, run_id, seq, event_type, payload_json)
      VALUES ('session', 'run', ?, ?, ?)
    `)
    insert.run(1, 'tool.called', JSON.stringify({
      name: 'call_agents', calls: [{ agentVariantId: 'old-choice' }],
    }))
    insert.run(2, 'tool.called', JSON.stringify({
      name: 'call_agents', calls: [{ agentVariantId: 'latest-choice' }],
    }))
    for (let seq = 3; seq <= 200; seq++) {
      insert.run(seq, 'agent.delta', JSON.stringify({ text: `chunk ${seq}` }))
    }
    insert.run(201, 'tool.called', '{"malformed')
    insert.run(202, 'tool.called', JSON.stringify({
      name: 'write_draft', reason: 'call_agents was used before',
    }))
  })

  afterEach(() => db.close())

  function get(query = '') {
    return createHandlers(db).GET(
      new NextRequest(`http://localhost/api/sessions/session${query}`),
      { params: Promise.resolve({ id: 'session' }) },
    )
  }

  it('keeps default session retrieval compatible with complete persisted event history', async () => {
    const response = await get()
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.events).toHaveLength(202)
    expect(body.events[0].seq).toBe(1)
    expect(body.events.at(-1).seq).toBe(202)
  })

  it('returns only the latest team decision after a long token stream, preserving other state', async () => {
    const response = await get('?view=workspace')
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.events).toHaveLength(1)
    expect(JSON.parse(body.events[0].payload_json)).toMatchObject({
      name: 'call_agents', calls: [{ agentVariantId: 'latest-choice' }],
    })
    expect(body.session.id).toBe('session')
    expect(body.runs).toHaveLength(1)
    expect(body).toHaveProperty('versions')
    expect(body).toHaveProperty('messages')
    expect(body).toHaveProperty('final_evidence')
  })

  it('returns an empty events list when no team decision was persisted', async () => {
    db.prepare("DELETE FROM run_events WHERE seq IN (1, 2)").run()
    const body = await (await get('?view=workspace')).json()
    expect(body.events).toEqual([])
  })

  it('uses the event type index to avoid scanning token events during polling', () => {
    const plan = db.prepare(`
      EXPLAIN QUERY PLAN SELECT id, event_type, payload_json FROM run_events
      WHERE session_id=? AND event_type='tool.called'
        AND CASE WHEN json_valid(payload_json)
          THEN json_extract(payload_json, '$.name') END = 'call_agents'
      ORDER BY id DESC LIMIT 1
    `).all('session') as Array<{ detail: string }>
    expect(plan.map((row) => row.detail).join('\n')).toContain('idx_run_events_session_type')
  })
})
