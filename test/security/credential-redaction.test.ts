import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { encryptSecret } from '../../src/lib/security/secrets'
import {
  redactCredentialText,
  redactCredentialValueForDb,
  safeErrorMessageForPersistence,
} from '../../src/lib/security/credential-redaction'

describe('credential redaction', () => {
  it('removes current endpoint secrets and legacy key/header spellings recursively', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE endpoints (api_key TEXT NOT NULL)')
    db.prepare('INSERT INTO endpoints (api_key) VALUES (?)')
      .run(encryptSecret('arbitrary-current-secret'))

    const output = redactCredentialValueForDb(db, {
      current: 'provider echoed arbitrary-current-secret',
      legacy: 'Authorization: Bearer sk-legacy-key-12345678',
      nested: ['api_key=sk-old-key-abcdefgh'],
    })
    const serialized = JSON.stringify(output)
    expect(serialized).not.toContain('arbitrary-current-secret')
    expect(serialized).not.toContain('sk-legacy-key-12345678')
    expect(serialized).not.toContain('sk-old-key-abcdefgh')
    expect(serialized).toContain('[REDACTED_CREDENTIAL]')
    db.close()
  })

  it('sanitizes persistence messages without a database schema', () => {
    const db = new Database(':memory:')
    expect(safeErrorMessageForPersistence(
      db,
      new Error('Authorization=Bearer sk-private-12345678'),
    )).not.toContain('sk-private-12345678')
    expect(redactCredentialText('Bearer rk-secret-12345678'))
      .toBe('Bearer [REDACTED_CREDENTIAL]')
    db.close()
  })
})
