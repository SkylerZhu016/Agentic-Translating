import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrate } from '../../src/lib/db/migrate'
import { recoverInterruptedWork } from '../../src/lib/db/startup-recovery'

describe('startup recovery', () => {
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
