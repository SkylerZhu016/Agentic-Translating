import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from '../../src/lib/db/migrate'
import { recoverInterruptedWork } from '../../src/lib/db/startup-recovery'

vi.mock('../../src/lib/batch/runner', () => ({ startBatch: vi.fn() }))

import { startBatch } from '../../src/lib/batch/runner'
import { POST as retryFailed } from '../../app/api/batches/[id]/retry-failed/route'
import { POST as resume } from '../../app/api/batches/[id]/resume/route'

describe('batch restart recovery and explicit retry', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    globalThis.__db = db
    vi.mocked(startBatch).mockClear()
    db.prepare(`
      INSERT INTO batch_jobs (
        id, name, direction, preset_revision_id, preset_snapshot,
        status, total_count, completed_count, failed_count
      ) VALUES ('batch', 'Batch', 'en_to_zh', 'frozen', '{}', 'running', 4, 1, 1)
    `).run()
    const insert = db.prepare(`
      INSERT INTO batch_items (
        id, batch_id, relative_path, source_hash, source_text, status, attempt
      ) VALUES (?, 'batch', ?, 'unchanged-hash', 'Unchanged source', ?, ?)
    `)
    insert.run('complete', 'complete.txt', 'completed', 1)
    insert.run('failed', 'failed.txt', 'failed', 1)
    insert.run('interrupted', 'interrupted.txt', 'running', 2)
    insert.run('queued', 'queued.txt', 'queued', 0)
  })

  afterEach(() => {
    delete globalThis.__db
    db.close()
  })

  function job() {
    return db.prepare(`
      SELECT status, total_count, completed_count, failed_count FROM batch_jobs WHERE id='batch'
    `).get()
  }

  it('preserves completed work, marks interrupted files failed and derives counts without dispatching', () => {
    const completed = db.prepare("SELECT * FROM batch_items WHERE id='complete'").get()
    recoverInterruptedWork(db)
    expect(job()).toEqual({ status: 'paused', total_count: 4, completed_count: 1, failed_count: 2 })
    expect(db.prepare("SELECT * FROM batch_items WHERE id='complete'").get()).toEqual(completed)
    expect(db.prepare("SELECT * FROM batch_items WHERE id='interrupted'").get()).toMatchObject({
      status: 'failed',
      attempt: 2,
      source_text: 'Unchanged source',
      source_hash: 'unchanged-hash',
      error: expect.stringContaining('retry failed files'),
    })
    recoverInterruptedWork(db)
    expect(job()).toEqual({ status: 'paused', total_count: 4, completed_count: 1, failed_count: 2 })
    expect(startBatch).not.toHaveBeenCalled()
  })

  it('a user resume leaves interrupted failures visible while continuing queued files', async () => {
    recoverInterruptedWork(db)
    const response = await resume(
      new Request('http://localhost/api/batches/batch/resume', { method: 'POST' }),
      { params: Promise.resolve({ id: 'batch' }) },
    )
    expect(response.status).toBe(200)
    expect(job()).toEqual({ status: 'queued', total_count: 4, completed_count: 1, failed_count: 2 })
    expect(db.prepare("SELECT status FROM batch_items WHERE id='interrupted'").pluck().get()).toBe('failed')
    expect(startBatch).toHaveBeenCalledWith(db, 'batch')
  })

  it('only an explicit retry requeues failed files and clears their displayed failure count', async () => {
    recoverInterruptedWork(db)
    const response = await retryFailed(
      new Request('http://localhost/api/batches/batch/retry-failed', { method: 'POST' }),
      { params: Promise.resolve({ id: 'batch' }) },
    )
    expect(response.status).toBe(200)
    expect(job()).toEqual({ status: 'queued', total_count: 4, completed_count: 1, failed_count: 0 })
    expect(db.prepare("SELECT status, attempt, error FROM batch_items WHERE id='interrupted'").get()).toEqual({
      status: 'queued', attempt: 2, error: null,
    })
    expect(db.prepare("SELECT status FROM batch_items WHERE id='complete'").pluck().get()).toBe('completed')
    expect(startBatch).toHaveBeenCalledOnce()
  })
})
