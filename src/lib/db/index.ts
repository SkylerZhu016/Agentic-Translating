import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

declare global {
  // eslint-disable-next-line no-var
  var __db: Database.Database | undefined
}

const DB_DIR = path.join(process.cwd(), 'data')
const DB_PATH = path.join(DB_DIR, 'app.db')

/**
 * Get or create the better-sqlite3 singleton instance.
 * Uses globalThis.__db to prevent Next.js HMR handler leaks.
 */
export function getDb(): Database.Database {
  if (globalThis.__db) {
    return globalThis.__db
  }

  // Ensure data directory exists
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true })
  }

  const db = new Database(DB_PATH)

  // Performance and safety pragmas
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  globalThis.__db = db
  return db
}

/**
 * Close the singleton database connection and clear globalThis.
 */
export function closeDb(): void {
  if (globalThis.__db) {
    try {
      globalThis.__db.close()
    } catch {
      // Ignore close errors
    }
    globalThis.__db = undefined
  }
}
