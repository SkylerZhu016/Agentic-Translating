import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readDesktopActivity } from '../../app/api/desktop/activity/handlers'

describe('desktop activity check', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, state TEXT, source_text TEXT, config_snapshot TEXT);
      CREATE TABLE batch_jobs (id TEXT PRIMARY KEY, status TEXT);
      CREATE TABLE orchestration_runs (id TEXT PRIMARY KEY, status TEXT);
      CREATE TABLE agent_invocations (id TEXT PRIMARY KEY, status TEXT);
      CREATE TABLE llm_call_records (id TEXT PRIMARY KEY, status TEXT);
    `)
  })

  afterEach(() => db.close())

  it('finds running work beyond the first hundred historical sessions without loading text or config', () => {
    const insert = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)')
    for (let i = 0; i < 150; i += 1) {
      insert.run(String(i), 'finalized', 'historical source', '{malformed historical snapshot')
    }
    insert.run('old-active-session', 'translating', 'active source', '{malformed snapshot')
    expect(readDesktopActivity(db)).toBe(true)
  })

  it.each([
    ['sessions', 'state', 'coordinating'],
    ['batch_jobs', 'status', 'running'],
    ['orchestration_runs', 'status', 'queued'],
    ['orchestration_runs', 'status', 'running'],
    ['agent_invocations', 'status', 'running'],
    ['llm_call_records', 'status', 'queued'],
    ['llm_call_records', 'status', 'connecting'],
    ['llm_call_records', 'status', 'receiving'],
  ])('includes active %s records in state %s=%s', (table, column, state) => {
    db.prepare(`INSERT INTO ${table} (id, ${column}) VALUES ('work', ?)`).run(state)
    expect(readDesktopActivity(db)).toBe(true)
  })

  it('allows exit when only paused batches and completed work remain', () => {
    db.exec(`
      INSERT INTO sessions (id, state) VALUES ('session', 'finalized');
      INSERT INTO batch_jobs VALUES ('batch', 'paused');
      INSERT INTO orchestration_runs VALUES ('run', 'complete');
      INSERT INTO agent_invocations VALUES ('agent', 'complete');
      INSERT INTO llm_call_records VALUES ('call', 'complete');
    `)
    expect(readDesktopActivity(db)).toBe(false)
  })
})
