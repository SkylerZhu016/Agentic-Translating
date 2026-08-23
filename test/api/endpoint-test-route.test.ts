import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from '../../src/lib/db/migrate'
import { createRepositories } from '../../src/lib/db/repositories'

const mocks = vi.hoisted(() => ({ chatCompletion: vi.fn() }))

vi.mock('@/src/lib/llm/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/llm/client')>()),
  chatCompletion: mocks.chatCompletion,
}))

import { ClientError } from '../../src/lib/llm/client'
import { POST } from '../../app/api/endpoints/[id]/test/route'

describe('POST /api/endpoints/:id/test safe diagnostics', () => {
  let db: Database.Database
  let endpointId: number

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    endpointId = Number(createRepositories(db).endpoints.insert({
      name: 'provider',
      base_url: 'https://private-provider.invalid',
      chat_completions_path: '/v1/chat/completions',
      api_key: 'opaque-endpoint-key',
    }).lastInsertRowid)
    globalThis.__db = db
    mocks.chatCompletion.mockReset()
  })

  afterEach(() => {
    delete globalThis.__db
    db.close()
    vi.restoreAllMocks()
  })

  it('does not return or log a reflected upstream body, key, authorization, or URL', async () => {
    const reflected = [
      'Authorization: Bearer opaque-endpoint-key',
      'https://private-provider.invalid/v1/chat/completions',
      'reflected-private-body',
    ].join(' | ')
    mocks.chatCompletion.mockRejectedValue(new ClientError(reflected, 400))
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const response = await POST(
      new Request('http://localhost/api/endpoints/1/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'fixture-model' }),
      }),
      { params: Promise.resolve({ id: String(endpointId) }) },
    )
    const payload = await response.json()

    expect(response.status).toBe(502)
    expect(payload).toEqual({
      error: 'endpoint_test_failed',
      diagnosticId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
      phase: 'chat_completions',
      elapsedMs: expect.any(Number),
    })
    const publicAndLogs = `${JSON.stringify(payload)}\n${JSON.stringify(log.mock.calls)}`
    for (const sensitive of [
      reflected,
      'opaque-endpoint-key',
      'Authorization',
      'private-provider.invalid',
      'reflected-private-body',
    ]) expect(publicAndLogs).not.toContain(sensitive)
    expect(log).toHaveBeenCalledWith(
      '[agentic-diagnostic]',
      expect.objectContaining({
        scope: 'endpoint.test',
        diagnosticId: payload.diagnosticId,
        errorCode: 'client_error',
      }),
    )
  })
})
