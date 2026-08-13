import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

describe('migration 0014 nullable legacy Agent endpoint', () => {
  let db: Database.Database | null = null

  afterEach(() => {
    db?.close()
    db = null
  })

  it('preserves every Agent field and converts endpoint deletion to SET NULL', () => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    const migrationsDir = path.join(
      process.cwd(),
      'src',
      'lib',
      'db',
      'migrations',
    )
    const firstThirteen = fs
      .readdirSync(migrationsDir)
      .filter((file) => /^(?:000[1-9]|001[0-3])_.*\.sql$/.test(file))
      .sort()
    for (const file of firstThirteen) {
      db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'))
    }

    const endpointId = Number(db.prepare(`
      INSERT INTO endpoints (
        name, base_url, chat_completions_path, api_key, context_window
      ) VALUES ('legacy provider', 'https://provider.invalid',
                '/v1/chat/completions', 'private-key', 64000)
    `).run().lastInsertRowid)
    db.prepare(`
      INSERT INTO translator_agents (
        id, name, endpoint_id, model, prompt_override, sort_order, created_at
      ) VALUES (73, 'user legacy Agent', ?, 'user/model name',
                'preserve this user prompt', 27, '2026-01-02 03:04:05')
    `).run(endpointId)

    db.exec(fs.readFileSync(
      path.join(migrationsDir, '0014_nullable_legacy_agent_endpoint.sql'),
      'utf8',
    ))

    const expected = {
      id: 73,
      name: 'user legacy Agent',
      endpoint_id: endpointId,
      model: 'user/model name',
      prompt_override: 'preserve this user prompt',
      sort_order: 27,
      created_at: '2026-01-02 03:04:05',
    }
    expect(db.prepare('SELECT * FROM translator_agents WHERE id=73').get())
      .toEqual(expected)
    const endpointColumn = db.prepare(`
      PRAGMA table_info('translator_agents')
    `).all().find((column) =>
      (column as { name: string }).name === 'endpoint_id',
    ) as { notnull: number }
    expect(endpointColumn.notnull).toBe(0)
    expect(db.prepare(`
      PRAGMA foreign_key_list('translator_agents')
    `).all()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'endpoints',
        from: 'endpoint_id',
        to: 'id',
        on_delete: 'SET NULL',
      }),
    ]))
    expect(db.prepare(`
      PRAGMA index_list('translator_agents')
    `).all()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'idx_translator_agents_endpoint_sort',
      }),
    ]))

    db.prepare('DELETE FROM endpoints WHERE id=?').run(endpointId)
    expect(db.prepare('SELECT * FROM translator_agents WHERE id=73').get())
      .toEqual({ ...expected, endpoint_id: null })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
})
