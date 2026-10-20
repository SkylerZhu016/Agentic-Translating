import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import { migrate } from '../../src/lib/db/migrate'
import {
  recoverInterruptedWork,
  recoverInterruptedWorkOnce,
} from '../../src/lib/db/startup-recovery'

describe('startup recovery', () => {
  it('recovers once per connection across module reloads, preserving newly started work', async () => {
    const db = new Database(':memory:')
    try {
      migrate(db)
      db.prepare(`
        INSERT INTO sessions (id, source_text, source_lang, target_lang, state, config_snapshot)
        VALUES ('session', 'text', 'English', 'Chinese', 'translating', '{}')
      `).run()
      const insertRun = db.prepare(`
        INSERT INTO orchestration_runs (id, session_id, status)
        VALUES (?, 'session', 'running')
      `)
      insertRun.run('previous-process')
      recoverInterruptedWorkOnce(db)
      expect(db.prepare(
        "SELECT status FROM orchestration_runs WHERE id='previous-process'",
      ).pluck().get()).toBe('interrupted')

      insertRun.run('current-process')
      db.prepare("UPDATE sessions SET state='translating' WHERE id='session'").run()
      vi.resetModules()
      const reloaded = await import('../../src/lib/db/startup-recovery')
      reloaded.recoverInterruptedWorkOnce(db)
      expect(db.prepare(
        "SELECT status FROM orchestration_runs WHERE id='current-process'",
      ).pluck().get()).toBe('running')
      expect(db.prepare("SELECT state FROM sessions WHERE id='session'").pluck().get()).toBe('translating')
    } finally {
      db.close()
    }
  })

  it('still recovers a newly opened connection after a previous startup', () => {
    for (let index = 0; index < 2; index++) {
      const db = new Database(':memory:')
      try {
        migrate(db)
        db.prepare(`
          INSERT INTO llm_call_records (
            id, endpoint_id, operation, requested_model, status
          ) VALUES ('orphan', 1, 'worker', 'test-model', 'receiving')
        `).run()
        recoverInterruptedWorkOnce(db)
        expect(db.prepare(
          "SELECT status FROM llm_call_records WHERE id='orphan'",
        ).pluck().get()).toBe('cancelled')
      } finally {
        db.close()
      }
    }
  })

  it('closes unfinished ledger attempts without changing completed calls', () => {
    const db = new Database(':memory:')
    try {
      db.pragma('foreign_keys = ON')
      migrate(db)
      for (const [index, status] of [
        'queued',
        'connecting',
        'receiving',
        'complete',
      ].entries()) {
        db.prepare(`
          INSERT INTO llm_call_records (
            id, endpoint_id, operation, requested_model, status
          ) VALUES (?, 1, 'worker', 'test-model', ?)
        `).run(`call-${index}`, status)
      }

      recoverInterruptedWork(db)

      const rows = db.prepare(`
        SELECT id, status, error_code
        FROM llm_call_records
        ORDER BY id
      `).all() as Array<{
        id: string
        status: string
        error_code: string | null
      }>
      expect(rows.slice(0, 3).every(
        (row) =>
          row.status === 'cancelled' &&
          row.error_code === 'application_restarted',
      )).toBe(true)
      expect(rows[3]).toEqual({
        id: 'call-3',
        status: 'complete',
        error_code: null,
      })
    } finally {
      db.close()
    }
  })
})
