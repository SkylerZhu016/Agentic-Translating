import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrate } from '../../src/lib/db/migrate'
import { requestVNextPause } from '../../src/lib/orchestration/vnext-runner'

function createDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  db.prepare(`
    INSERT INTO sessions
      (id, source_text, source_lang, target_lang, state, config_snapshot)
    VALUES ('session-1', 'source', 'English', 'Chinese', 'translating', '{}')
  `).run()
  return db
}

describe('vNext run controls', () => {
  it('persists a cooperative pause request and audit event', () => {
    const db = createDb()
    db.prepare(`
      INSERT INTO orchestration_runs
        (id, session_id, status, phase)
      VALUES ('run-1', 'session-1', 'running', 'team')
    `).run()

    expect(requestVNextPause(db, 'session-1')).toEqual({
      pauseRequested: true,
    })
    expect(
      db.prepare(`
        SELECT pause_requested
        FROM session_run_controls
        WHERE session_id='session-1'
      `).get(),
    ).toEqual({ pause_requested: 1 })
    expect(
      db.prepare(`
        SELECT event_type
        FROM run_events
        WHERE run_id='run-1'
      `).get(),
    ).toEqual({ event_type: 'run.pause.requested' })
    db.close()
  })

  it('rejects pause when no run is active', () => {
    const db = createDb()
    expect(() => requestVNextPause(db, 'session-1')).toThrow(
      'no_active_run',
    )
    db.close()
  })
})
