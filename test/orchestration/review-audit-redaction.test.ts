import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate } from '../../src/lib/db/migrate'
import { combineIndependentReviews } from '../../src/lib/orchestration/vnext-runner'

describe('independent review audit credential redaction', () => {
  let db: Database.Database | null = null

  afterEach(() => {
    db?.close()
    db = null
  })

  it('keeps two successful audits while sanitizing the failed third audit', () => {
    db = new Database(':memory:')
    migrate(db)
    const currentKey = 'CURRENT-AUDIT-KEY-SENTINEL-458219'
    db.prepare(`
      INSERT INTO endpoints (name, base_url, api_key)
      VALUES ('audit-endpoint', 'https://audit.invalid', ?)
    `).run(currentKey)

    const combined = combineIndependentReviews(
      db,
      'en',
      [
        {
          lens: {
            labelZh: '语义与逻辑审查',
            labelEn: 'Fidelity and logic audit',
          },
          raw: 'Fidelity body.',
          body: 'Fidelity body.',
          annotation: null,
        },
        {
          lens: {
            labelZh: '目标语自然度与声音审查',
            labelEn: 'Target-language naturalness and voice audit',
          },
          raw: 'Naturalness body.',
          body: 'Naturalness body.',
          annotation: null,
        },
      ],
      [{
        lensId: 'task_specific',
        error: new Error(`Authorization: Bearer ${currentKey}`),
      }],
    )

    expect(combined.body).toContain('Fidelity body.')
    expect(combined.body).toContain('Naturalness body.')
    expect(combined.annotation).toContain('Unavailable audit passes:')
    expect(combined.raw).toContain('[REDACTED_CREDENTIAL]')
    expect(JSON.stringify(combined)).not.toContain(currentKey)
  })
})
