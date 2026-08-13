import type Database from 'better-sqlite3'

/**
 * A restarted local process cannot resume an in-flight HTTP request. Preserve
 * completed data and close only unfinished runtime records with safe statuses.
 */
export function recoverInterruptedWork(db: Database.Database): void {
  db.transaction(() => {
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
      UPDATE batch_jobs
      SET status='paused',
          error=COALESCE(error, 'Application restarted; resume the batch to continue'),
          updated_at=datetime('now')
      WHERE status='running'
    `).run()
  })()
}
