import type Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import {
  isOrdinarySnapshotObject,
  withoutSnapshotCredentials,
} from '../services/runtime-endpoint-credentials'

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

function tableColumns(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{
      name: string
    }>).map((column) => column.name),
  )
}

/**
 * Historical migration 15 shipped before provider/logical call linkage was
 * added. SQLite has no `ADD COLUMN IF NOT EXISTS`, so migration 16 performs a
 * schema probe inside its migration transaction and adds only missing nullable
 * columns. ALTER TABLE preserves existing rows, foreign keys, and triggers.
 */
function prepareTranslationToolTraceV16(db: Database.Database): void {
  const columns = tableColumns(db, 'agent_tool_calls')
  if (!columns.has('provider_tool_call_id')) {
    db.exec('ALTER TABLE agent_tool_calls ADD COLUMN provider_tool_call_id TEXT')
  }
  if (!columns.has('logical_call_key')) {
    db.exec('ALTER TABLE agent_tool_calls ADD COLUMN logical_call_key TEXT')
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_tool_calls_run_logical_call
      ON agent_tool_calls(run_id, logical_call_key)
      WHERE run_id IS NOT NULL AND logical_call_key IS NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_tool_calls_invocation_provider_call
      ON agent_tool_calls(invocation_id, provider_tool_call_id)
      WHERE invocation_id IS NOT NULL AND provider_tool_call_id IS NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_tool_calls_one_completed_write
      ON agent_tool_calls(run_id)
      WHERE run_id IS NOT NULL AND tool_name = 'write_draft'
        AND status = 'complete';
  `)
}

/**
 * Logically remove credentials embedded by historical session snapshots.
 * A malformed row aborts migration 17 atomically and identifies only the row;
 * snapshot content and credential values never enter the error message.
 */
function sanitizeSessionSnapshotsV17(db: Database.Database): void {
  const sessionColumns = tableColumns(db, 'sessions')
  if (!sessionColumns.has('id') || !sessionColumns.has('config_snapshot')) return
  const rows = db.prepare(
    'SELECT id, config_snapshot FROM sessions ORDER BY id',
  ).all() as Array<{ id: string; config_snapshot: string }>
  const update = db.prepare(
    'UPDATE sessions SET config_snapshot=? WHERE id=? AND config_snapshot=?',
  )
  for (const row of rows) {
    let parsed: unknown
    try {
      parsed = JSON.parse(row.config_snapshot)
    } catch {
      throw new Error(
        `session_snapshot_invalid_json: migration 17 stopped at session ${row.id}`,
      )
    }
    if (!isOrdinarySnapshotObject(parsed)) {
      throw new Error(
        `session_snapshot_invalid_root: migration 17 stopped at session ${row.id}`,
      )
    }
    let sanitized: unknown
    try {
      sanitized = withoutSnapshotCredentials(parsed)
    } catch {
      throw new Error(
        `session_snapshot_invalid_shape: migration 17 stopped at session ${row.id}`,
      )
    }
    if (JSON.stringify(sanitized) === JSON.stringify(parsed)) continue
    const result = update.run(JSON.stringify(sanitized), row.id, row.config_snapshot)
    if (result.changes !== 1) {
      throw new Error(
        `session_snapshot_changed: migration 17 stopped at session ${row.id}`,
      )
    }
  }
}

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
      if (fileVersion === 16) prepareTranslationToolTraceV16(db)
      if (fileVersion === 17) sanitizeSessionSnapshotsV17(db)
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
