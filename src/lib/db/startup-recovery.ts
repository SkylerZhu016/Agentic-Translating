import type Database from 'better-sqlite3'

declare global {
  // Keep the startup boundary across development instrumentation reloads.
  // eslint-disable-next-line no-var
  var __agenticRecoveredDatabases: WeakSet<Database.Database> | undefined
}

export function recoverInterruptedWorkOnce(db: Database.Database): void {
  const recovered = globalThis.__agenticRecoveredDatabases ??= new WeakSet<Database.Database>()
  if (recovered.has(db)) return
  recoverInterruptedWork(db)
  // A failed transaction remains eligible for a later startup retry.
  recovered.add(db)
}

/**
 * A restarted local process cannot resume an in-flight HTTP request. Preserve
 * completed data and close only unfinished runtime records with safe statuses.
 */
export function recoverInterruptedWork(db: Database.Database): void {
  db.transaction(() => {
    const interruptedBatches = db.prepare(`
      SELECT DISTINCT batch_id FROM batch_items WHERE status='running'
    `).all() as Array<{ batch_id: string }>
    db.prepare(`
      UPDATE orchestration_runs
      SET status='interrupted',
          error=COALESCE(error, 'Application stopped while the run was active'),
          completed_at=datetime('now')
      WHERE status IN ('queued','running')
    `).run()
    db.prepare(`
      UPDATE agent_invocations
      SET status='interrupted',
          error=COALESCE(error, 'Application stopped while the call was active'),
          updated_at=datetime('now')
      WHERE status IN ('queued','running')
    `).run()
    db.prepare(`
      UPDATE llm_call_records
      SET status='cancelled',
          error_code=COALESCE(error_code, 'application_restarted'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE status IN ('queued','connecting','receiving')
    `).run()
    db.prepare(`
      UPDATE sessions
      SET state=CASE
            WHEN state='coordinating' THEN 'translated'
            ELSE 'draft'
          END,
          updated_at=datetime('now')
      WHERE state IN ('translating','coordinating')
        AND final_version_id IS NULL
    `).run()
    db.prepare(`
      UPDATE batch_items
      SET status='failed',
          error=COALESCE(error, 'Application stopped while this file was running; retry failed files to continue'),
          updated_at=datetime('now')
      WHERE status='running'
    `).run()
    db.prepare(`
      UPDATE batch_jobs
      SET status='paused',
          error=COALESCE(error, 'Application restarted; resume the batch to continue'),
          updated_at=datetime('now')
      WHERE status IN ('queued','running')
    `).run()
    const recount = db.prepare(`
      UPDATE batch_jobs
      SET completed_count=(
            SELECT COUNT(*) FROM batch_items WHERE batch_id=@id AND status='completed'
          ),
          failed_count=(
            SELECT COUNT(*) FROM batch_items WHERE batch_id=@id AND status='failed'
          ),
          updated_at=datetime('now')
      WHERE id=@id
    `)
    for (const batch of interruptedBatches) recount.run({ id: batch.batch_id })
  })()
}
