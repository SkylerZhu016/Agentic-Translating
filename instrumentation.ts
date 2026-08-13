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
    const { recoverInterruptedWork } = await import(
      '@/src/lib/db/startup-recovery'
    )
    const db = getDb()
    migrate(db)
    seed(db)

    recoverInterruptedWork(db)

    // Ensure run artifacts directory exists
    const dataDir = process.env.AGENTIC_DATA_DIR
      ? path.resolve(process.env.AGENTIC_DATA_DIR)
      : path.resolve(process.cwd(), 'data')
    const runsDir = path.join(dataDir, 'runs')
    fs.mkdirSync(runsDir, { recursive: true })
  }
}
