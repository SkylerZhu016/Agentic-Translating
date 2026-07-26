import type Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

// Next.js 生产构建会把服务端代码打包进 .next/server，__dirname 不再指向
// src/lib/db —— 先按 __dirname 解析（测试/开发），不存在时回退到项目根。
function resolveMigrationsDir(): string {
  if (process.env.AGENTIC_MIGRATIONS_DIR) {
    const configured = path.resolve(process.env.AGENTIC_MIGRATIONS_DIR)
    if (!fs.existsSync(configured)) {
      throw new Error(`Configured migrations directory is missing: ${configured}`)
    }
    return configured
  }
  const fromDirname = path.join(__dirname, 'migrations')
  if (fs.existsSync(fromDirname)) return fromDirname
  const fromStandalone = path.join(process.cwd(), 'migrations')
  if (fs.existsSync(fromStandalone)) return fromStandalone
  const fromSource = path.join(process.cwd(), 'src', 'lib', 'db', 'migrations')
  if (fs.existsSync(fromSource)) return fromSource
  throw new Error(
    `Database migrations are missing. Checked ${fromDirname}, ${fromStandalone}, and ${fromSource}.`,
  )
}

const MIGRATIONS_DIR = resolveMigrationsDir()
const migratedConnections = new WeakSet<Database.Database>()

/**
 * Run all pending migrations against the given database.
 * Idempotent — tracks applied version in the `migrations` table.
 */
export function migrate(db: Database.Database): void {
  if (migratedConnections.has(db)) return
  // Ensure migrations meta table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // Read current applied version (0 if none)
  const currentVersion = getAppliedVersion(db)

  // Discover migration SQL files ordered by name
  const migrationFiles = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()

  for (const file of migrationFiles) {
    const match = file.match(/^(\d+)_/)
    if (!match) continue

    const fileVersion = parseInt(match[1], 10)
    if (fileVersion <= currentVersion) continue

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8')

    // Run migration in a transaction
    db.transaction(() => {
      db.exec(sql)
      db.prepare('INSERT INTO migrations (version, name) VALUES (?, ?)').run(fileVersion, file)
    })()
  }
  migratedConnections.add(db)
}

/**
 * Get the highest applied migration version.
 */
export function getAppliedVersion(db: Database.Database): number {
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) as v FROM migrations').get() as { v: number }
  return row.v
}
