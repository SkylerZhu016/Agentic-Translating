import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { migrate } from '../../src/lib/db/migrate'

const migrationsDirectory = path.join(
  process.cwd(),
  'src/lib/db/migrations',
)

function createDatabase() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  return db
}

function migrateThrough(db: Database.Database, targetVersion: number) {
  db.exec(`
    CREATE TABLE migrations (
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `)
  const migrationFiles = fs
    .readdirSync(migrationsDirectory)
    .filter((file) => {
      const match = file.match(/^(\d+)_.*\.sql$/)
      return match && Number(match[1]) <= targetVersion
    })
    .sort()
  for (const migrationFile of migrationFiles) {
    const version = Number(migrationFile.match(/^(\d+)_/)![1])
    const sql = fs.readFileSync(
      path.join(migrationsDirectory, migrationFile),
      'utf8',
    )
    db.transaction(() => {
      db.exec(sql)
      db.prepare(
        'INSERT INTO migrations (version, name) VALUES (?, ?)',
      ).run(version, migrationFile)
    })()
  }
}

function insertEndpoint(db: Database.Database, id = 1) {
  db.prepare(`
    INSERT INTO endpoints (id, name, base_url, api_key)
    VALUES (?, 'private endpoint', 'https://example.invalid/v1?tenant=secret', 'sk-private')
  `).run(id)
}

describe('migration 0011 — unified LLM call ledger', () => {
  let db: Database.Database | null = null

  afterEach(() => {
    db?.close()
    db = null
  })

  it('creates the ledger, privacy allowlist and required indexes on a fresh database', () => {
    db = createDatabase()
    migrate(db)

    const migration = db.prepare(
      'SELECT name FROM migrations WHERE version = 11',
    ).get() as { name: string } | undefined
    expect(migration?.name).toBe('0011_llm_call_records.sql')

    const columns = (
      db.prepare("PRAGMA table_info('llm_call_records')").all() as Array<{
        name: string
      }>
    ).map((column) => column.name)
    expect(columns).toEqual(
      expect.arrayContaining([
        'session_id',
        'run_id',
        'invocation_id',
        'endpoint_id',
        'usage_source',
        'cost_source',
        'price_snapshot_json',
      ]),
    )
    expect(columns).not.toEqual(
      expect.arrayContaining([
        'prompt',
        'source_text',
        'translated_text',
        'url',
        'api_key',
      ]),
    )

    const indexes = (
      db.prepare("PRAGMA index_list('llm_call_records')").all() as Array<{
        name: string
      }>
    ).map((index) => index.name)
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_llm_call_records_session_created',
        'idx_llm_call_records_run_created',
        'idx_llm_call_records_invocation_created',
        'idx_llm_call_records_endpoint_model_created',
        'idx_llm_call_records_status_created',
        'idx_llm_call_records_operation_created',
      ]),
    )
  })

  it('upgrades a migration-8 database without rewriting legacy sessions or usage', () => {
    db = createDatabase()
    migrateThrough(db, 8)
    insertEndpoint(db)
    db.prepare(`
      INSERT INTO sessions (id, source_text, config_snapshot)
      VALUES ('legacy-session', 'legacy source', '{"version":3}')
    `).run()
    db.prepare(`
      INSERT INTO orchestration_runs (id, session_id, status)
      VALUES ('legacy-run', 'legacy-session', 'complete')
    `).run()
    db.prepare(`
      INSERT INTO agent_invocations (
        id, session_id, parent_run_id, agent_variant_id, agent_snapshot,
        endpoint_id, model, status, usage_json
      ) VALUES (
        'legacy-invocation', 'legacy-session', 'legacy-run', 'legacy-agent',
        '{}', 1, 'legacy-model', 'complete', '{"input_tokens":12}'
      )
    `).run()

    migrate(db)

    expect(
      db.prepare('SELECT source_text FROM sessions WHERE id = ?').pluck().get(
        'legacy-session',
      ),
    ).toBe('legacy source')
    expect(
      db.prepare(
        'SELECT usage_json FROM agent_invocations WHERE id = ?',
      ).pluck().get('legacy-invocation'),
    ).toBe('{"input_tokens":12}')
    expect(
      db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='llm_call_records'",
      ).get(),
    ).toBeTruthy()
  })

  it('enforces honest usage, cost and terminal error semantics', () => {
    db = createDatabase()
    migrate(db)
    insertEndpoint(db)

    const base = `
      INSERT INTO llm_call_records (
        id, endpoint_id, operation, requested_model, status,
        input_tokens, usage_source, cost_amount, cost_currency,
        cost_source, price_snapshot_json, error_code
      ) VALUES (
        @id, 1, 'agent.translate', 'model-safe', @status,
        @input_tokens, @usage_source, @cost_amount, @cost_currency,
        @cost_source, @price_snapshot_json, @error_code
      )
    `
    const insert = db.prepare(base)

    expect(() =>
      insert.run({
        id: 'unknown-usage-with-tokens',
        status: 'complete',
        input_tokens: 12,
        usage_source: 'unknown',
        cost_amount: null,
        cost_currency: null,
        cost_source: 'unknown',
        price_snapshot_json: null,
        error_code: null,
      }),
    ).toThrow()

    expect(() =>
      insert.run({
        id: 'estimated-without-snapshot',
        status: 'complete',
        input_tokens: 12,
        usage_source: 'provider',
        cost_amount: 0.01,
        cost_currency: 'USD',
        cost_source: 'estimated',
        price_snapshot_json: null,
        error_code: null,
      }),
    ).toThrow()

    expect(() =>
      insert.run({
        id: 'failure-without-code',
        status: 'failed',
        input_tokens: null,
        usage_source: 'unknown',
        cost_amount: null,
        cost_currency: null,
        cost_source: 'unknown',
        price_snapshot_json: null,
        error_code: null,
      }),
    ).toThrow()
  })

  it('retains audit history while nullable orchestration links are deleted', () => {
    db = createDatabase()
    migrate(db)
    insertEndpoint(db)
    db.prepare(`
      INSERT INTO sessions (id, source_text, config_snapshot)
      VALUES ('session-1', 'private source', '{}')
    `).run()
    db.prepare(`
      INSERT INTO orchestration_runs (id, session_id, status)
      VALUES ('run-1', 'session-1', 'running')
    `).run()
    db.prepare(`
      INSERT INTO agent_invocations (
        id, session_id, parent_run_id, agent_variant_id, agent_snapshot,
        endpoint_id, model, status
      ) VALUES (
        'invocation-1', 'session-1', 'run-1', 'agent-1', '{}', 1,
        'model-safe', 'running'
      )
    `).run()
    db.prepare(`
      INSERT INTO llm_call_records (
        id, session_id, run_id, invocation_id, endpoint_id,
        operation, requested_model, status
      ) VALUES (
        'call-1', 'session-1', 'run-1', 'invocation-1', 1,
        'agent.translate', 'model-safe', 'connecting'
      )
    `).run()

    db.prepare("DELETE FROM sessions WHERE id = 'session-1'").run()
    db.prepare('DELETE FROM endpoints WHERE id = 1').run()

    expect(
      db.prepare(`
        SELECT session_id, run_id, invocation_id, endpoint_id
        FROM llm_call_records WHERE id = 'call-1'
      `).get(),
    ).toEqual({
      session_id: null,
      run_id: null,
      invocation_id: null,
      endpoint_id: 1,
    })
  })
})
