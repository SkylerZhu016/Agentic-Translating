import type Database from 'better-sqlite3'

export function readDesktopActivity(db: Database.Database): boolean {
  const row = db.prepare(`
    SELECT (
      EXISTS(SELECT 1 FROM batch_jobs WHERE status = 'running')
      OR EXISTS(SELECT 1 FROM sessions WHERE state IN ('translating', 'coordinating'))
      OR EXISTS(SELECT 1 FROM orchestration_runs WHERE status IN ('queued', 'running'))
      OR EXISTS(SELECT 1 FROM agent_invocations WHERE status = 'running')
      OR EXISTS(SELECT 1 FROM llm_call_records WHERE status IN ('queued', 'connecting', 'receiving'))
    ) AS active
  `).get() as { active: number }
  return row.active === 1
}
