import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { getAppliedVersion, migrate } from '../../src/lib/db/migrate'

function v16Database(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE migrations (
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT (datetime('now'))
    );
    INSERT INTO migrations (version, name)
    VALUES (16, '0016_translation_tool_trace_upgrade.sql');
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source_text TEXT NOT NULL,
      config_snapshot TEXT NOT NULL
    );
    CREATE TABLE workspace_drafts (
      direction TEXT PRIMARY KEY
    );
  `)
  return db
}

describe('migration 17 session snapshot credential cleanup', () => {
  const opened: Database.Database[] = []
  afterEach(() => {
    while (opened.length) opened.pop()!.close()
  })

  it('cleans v2/v3 snake and camel credentials without changing provenance', () => {
    const db = v16Database()
    opened.push(db)
    const v2 = {
      version: 2,
      endpoint: {
        id: 1,
        name: 'endpoint-one',
        base_url: 'https://one.invalid',
        api_key: 'opaque-old-one',
        apiKey: 'opaque-old-two',
      },
      endpoints: [{
        id: 2,
        name: 'endpoint-two',
        base_url: 'https://two.invalid',
        api_key: 'opaque-old-three',
        apiKey: 'opaque-old-four',
      }],
      prompts: { translator: 'preserve this prompt' },
    }
    const v3 = {
      version: 3,
      endpointSnapshots: [{
        id: 3,
        name: 'endpoint-three',
        baseUrl: 'https://three.invalid',
        api_key: 'opaque-old-five',
        apiKey: 'opaque-old-six',
        hasApiKey: true,
      }],
      workflowHash: 'preserve-this-hash',
    }
    const insert = db.prepare(
      'INSERT INTO sessions (id, source_text, config_snapshot) VALUES (?, ?, ?)',
    )
    insert.run('v2-session', 'source', JSON.stringify(v2))
    insert.run('v3-session', 'source', JSON.stringify(v3))

    migrate(db)
    expect(getAppliedVersion(db)).toBe(18)
    const rows = db.prepare(
      'SELECT id, config_snapshot FROM sessions ORDER BY id',
    ).all() as Array<{ id: string; config_snapshot: string }>
    const serialized = JSON.stringify(rows)
    for (const secret of [
      'opaque-old-one', 'opaque-old-two', 'opaque-old-three',
      'opaque-old-four', 'opaque-old-five', 'opaque-old-six',
    ]) expect(serialized).not.toContain(secret)

    const cleanedV2 = JSON.parse(rows.find((row) => row.id === 'v2-session')!.config_snapshot)
    const cleanedV3 = JSON.parse(rows.find((row) => row.id === 'v3-session')!.config_snapshot)
    expect(cleanedV2).toMatchObject({
      endpoint: { id: 1, name: 'endpoint-one', base_url: 'https://one.invalid' },
      endpoints: [{ id: 2, name: 'endpoint-two', base_url: 'https://two.invalid' }],
      prompts: { translator: 'preserve this prompt' },
    })
    expect(cleanedV3).toMatchObject({
      endpointSnapshots: [{
        id: 3,
        name: 'endpoint-three',
        baseUrl: 'https://three.invalid',
        hasApiKey: true,
      }],
      workflowHash: 'preserve-this-hash',
    })

    const afterFirstMigration = rows.map((row) => row.config_snapshot)
    migrate(db)
    const afterSecondMigration = db.prepare(
      'SELECT config_snapshot FROM sessions ORDER BY id',
    ).pluck().all() as string[]
    expect(afterSecondMigration).toEqual(afterFirstMigration)
  })

  it('rolls back atomically on malformed JSON and reports only the session id', () => {
    const db = v16Database()
    opened.push(db)
    const secretSnapshot = JSON.stringify({
      version: 2,
      endpoint: { api_key: 'opaque-migration-secret', keep: 'safe' },
    })
    db.prepare(
      'INSERT INTO sessions (id, source_text, config_snapshot) VALUES (?, ?, ?)',
    ).run('a-cleanable', 'source', secretSnapshot)
    db.prepare(
      'INSERT INTO sessions (id, source_text, config_snapshot) VALUES (?, ?, ?)',
    ).run('b-malformed', 'source', '{private malformed payload')

    let message = ''
    try {
      migrate(db)
      throw new Error('expected migration failure')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('b-malformed')
    expect(message).not.toContain('opaque-migration-secret')
    expect(message).not.toContain('private malformed payload')
    expect(getAppliedVersion(db)).toBe(16)
    expect(
      db.prepare('SELECT config_snapshot FROM sessions WHERE id=?')
        .pluck().get('a-cleanable'),
    ).toBe(secretSnapshot)
  })

  it.each([
    ['array', '[]'],
    ['string', JSON.stringify('private primitive payload')],
    ['number', '42'],
    ['boolean', 'true'],
    ['null', 'null'],
    ['endpoint-array', JSON.stringify({ endpoint: [{ api_key: 'opaque' }] })],
    ['endpoints-object', JSON.stringify({ endpoints: { api_key: 'opaque' } })],
    ['endpointSnapshots-object', JSON.stringify({
      endpointSnapshots: { apiKey: 'opaque' },
    })],
  ])('rejects a JSON-valid invalid %s snapshot without completing v17', (_kind, invalidRoot) => {
    const db = v16Database()
    opened.push(db)
    const cleanable = JSON.stringify({
      version: 2,
      endpoint: { api_key: 'opaque-root-rollback-secret', keep: 'safe' },
    })
    db.prepare(
      'INSERT INTO sessions (id, source_text, config_snapshot) VALUES (?, ?, ?)',
    ).run('a-cleanable-root', 'source', cleanable)
    db.prepare(
      'INSERT INTO sessions (id, source_text, config_snapshot) VALUES (?, ?, ?)',
    ).run('b-invalid-root', 'source', invalidRoot)

    let message = ''
    try {
      migrate(db)
      throw new Error('expected invalid root failure')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('b-invalid-root')
    expect(message).not.toContain('opaque-root-rollback-secret')
    expect(message).not.toContain('private primitive payload')
    expect(message).not.toContain(invalidRoot)
    expect(getAppliedVersion(db)).toBe(16)
    expect(db.prepare(
      'SELECT config_snapshot FROM sessions WHERE id=?',
    ).pluck().get('a-cleanable-root')).toBe(cleanable)
  })
})
