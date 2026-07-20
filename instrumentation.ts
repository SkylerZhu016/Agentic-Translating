// ---------------------------------------------------------------------------
// Next.js 服务器启动钩子 —— 首次启动时执行迁移 + 内置提示词种子
// seed() 幂等：已有内置模板时跳过；仅在 nodejs runtime 下执行
// ---------------------------------------------------------------------------

import fs from 'fs'
import path from 'path'

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { getDb } = await import('@/src/lib/db')
    const { migrate } = await import('@/src/lib/db/migrate')
    const { seed } = await import('@/src/lib/db/seed')
    const db = getDb()
    migrate(db)
    seed(db)

    // Ensure run artifacts directory exists
    const runsDir = path.resolve(process.cwd(), 'data', 'runs')
    fs.mkdirSync(runsDir, { recursive: true })
  }
}
