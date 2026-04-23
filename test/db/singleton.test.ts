import { describe, expect, it, afterEach } from 'vitest'
import { getDb, closeDb } from '../../src/lib/db/index'
import path from 'path'
import fs from 'fs'

describe('DB Singleton', () => {
  afterEach(() => { closeDb() })

  it('should return same instance on repeated calls', () => {
    const db1 = getDb()
    const db2 = getDb()
    expect(db1).toBe(db2)
  })

  it('should store instance on globalThis.__db', () => {
    const db = getDb()
    expect((globalThis as any).__db).toBe(db)
  })

  it('should enable WAL journal mode', () => {
    const db = getDb()
    const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }
    expect(row.journal_mode.toLowerCase()).toBe('wal')
  })

  it('should enable foreign_keys', () => {
    const db = getDb()
    const row = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }
    expect(row.foreign_keys).toBe(1)
  })

  it('should create data/ directory', () => {
    const dataDir = path.join(process.cwd(), 'data')
    expect(fs.existsSync(dataDir)).toBe(true)
  })
})
