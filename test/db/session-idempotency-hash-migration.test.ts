import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

describe('migration 0013 session idempotency hashes', () => {
  let db: Database.Database | null = null

  afterEach(() => {
    db?.close()
    db = null
  })

  it('preserves legacy sessions and adds a request-hash registry', () => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    const migrationsDir = path.join(
      process.cwd(),
      'src',
      'lib',
      'db',
      'migrations',
    )
    const firstTwelve = fs
      .readdirSync(migrationsDir)
      .filter((file) => /^(?:000[1-9]|001[0-2])_.*\.sql$/.test(file))
      .sort()
    for (const file of firstTwelve) {
      db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'))
    }
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const clientRequestId = '22222222-2222-4222-8222-222222222222'
    db.prepare(
      `INSERT INTO sessions (
         id, source_text, source_lang, target_lang, config_snapshot,
         client_request_id
       ) VALUES (?, 'legacy', 'English', 'Chinese', '{}', ?)`,
    ).run(sessionId, clientRequestId)

    db.exec(
      fs.readFileSync(
        path.join(migrationsDir, '0013_session_idempotency_hash.sql'),
        'utf8',
      ),
    )

    expect(
      db.prepare('SELECT id, client_request_id FROM sessions WHERE id=?').get(
        sessionId,
      ),
    ).toEqual({ id: sessionId, client_request_id: clientRequestId })
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM session_idempotency_records').get(),
    ).toEqual({ count: 0 })
    expect(() =>
      db!.prepare(
        `INSERT INTO session_idempotency_records (
           client_request_id, request_hash, session_id
         ) VALUES (?, 'short', ?)`,
      ).run(clientRequestId, sessionId),
    ).toThrow()
  })
})
