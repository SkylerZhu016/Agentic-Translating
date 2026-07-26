import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { migrate } from '../../src/lib/db/migrate'
import { seed } from '../../src/lib/db/seed'
import { createRepositories } from '../../src/lib/db/repositories'
import { createHandlers } from '../../app/api/sessions/handlers'

describe('session creation idempotency', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    seed(db)
    const repos = createRepositories(db)
    repos.endpoints.insert({
      name: 'test',
      base_url: 'https://example.test',
      chat_completions_path: '/v1/chat/completions',
      api_key: 'test-key',
    })
    repos.coordinatorConfig.upsert({
      endpoint_id: 1,
      model: 'test-model',
      chat_endpoint_id: 1,
      chat_model: 'test-model',
    })
  })

  afterEach(() => db.close())

  it('returns the same session for the same clientRequestId', async () => {
    const POST = createHandlers(db).POST
    const clientRequestId = crypto.randomUUID()
    const makeRequest = () =>
      new NextRequest('http://localhost/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientRequestId,
          sourceText: 'Hello',
          direction: 'en_to_zh',
        }),
      })

    const first = await (await POST(makeRequest())).json()
    const second = await (await POST(makeRequest())).json()

    expect(second.id).toBe(first.id)
    expect(
      (
        db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as {
          count: number
        }
      ).count,
    ).toBe(1)
  })
})
