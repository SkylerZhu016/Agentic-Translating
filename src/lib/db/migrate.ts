import type Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

const MIGRATIONS_DIR = path.join(__dirname, 'migrations')

/**
 * Run all pending migrations against the given database.
 * Idempotent — tracks applied version in the `migrations` table.
 */
export function migrate(db: Database.Database): void {
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
}

/**
 * Get the highest applied migration version.
 */
export function getAppliedVersion(db: Database.Database): number {
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) as v FROM migrations').get() as { v: number }
  return row.v
}
