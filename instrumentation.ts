// ---------------------------------------------------------------------------
// Next.js 服务器启动钩子 —— 首次启动时执行迁移 + 内置提示词种子
// seed() 幂等：已有内置模板时跳过；仅在 nodejs runtime 下执行
// ---------------------------------------------------------------------------

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const [{ default: fs }, { default: path }] = await Promise.all([
      import('fs'),
      import('path'),
    ])
    const { getDb } = await import('@/src/lib/db')
    const { migrate } = await import('@/src/lib/db/migrate')
    const { seed } = await import('@/src/lib/db/seed')
    const db = getDb()
    migrate(db)
    seed(db)

    // A local process cannot resume an in-flight HTTP model call after restart.
    // Preserve completed events and mark only unfinished nodes as interrupted.
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

    // Ensure run artifacts directory exists
    const dataDir = process.env.AGENTIC_DATA_DIR
      ? path.resolve(process.env.AGENTIC_DATA_DIR)
      : path.resolve(process.cwd(), 'data')
    const runsDir = path.join(dataDir, 'runs')
    fs.mkdirSync(runsDir, { recursive: true })
  }
}
