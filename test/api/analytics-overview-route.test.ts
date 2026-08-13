import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../../src/lib/db/migrate'
import { createLlmCallRecordsService } from '../../src/lib/services/llm-call-records-service'
import { createHandlers } from '../../app/api/analytics/overview/handlers'

describe('GET /api/analytics/overview', () => {
  let db: Database.Database
  let nextId: number

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    db.prepare(`
      INSERT INTO endpoints (id, name, base_url, api_key)
      VALUES
        (1, 'remote private', 'https://one.invalid/v1?tenant=private', 'sk-secret-one'),
        (2, 'local private', 'http://127.0.0.1:11434/v1?key=private', 'sk-secret-two')
    `).run()
    db.prepare(`
      INSERT INTO sessions (id, source_text, config_snapshot)
      VALUES ('private-session', 'original text must stay private', '{}')
    `).run()
    nextId = 1
  })

  afterEach(() => {
    db.close()
  })

  function ledger() {
    return createLlmCallRecordsService(db, {
      createId: () => `analytics-call-${nextId++}`,
    })
  }

  it('returns a zeroed, stable overview for an empty ledger', async () => {
    const response = await createHandlers(db).GET()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.calls).toEqual({
      total: 0,
      queued: 0,
      connecting: 0,
      receiving: 0,
      complete: 0,
      failed: 0,
      cancelled: 0,
    })
    expect(body.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      bySource: [],
    })
    expect(body.costs).toEqual({ known: [], unknownCallCount: 0 })
    expect(body.timing).toEqual({
      averageFirstByteMs: null,
      averageLatencyMs: null,
    })
    expect(body.byOperation).toEqual([])
    expect(body.byModel).toEqual([])
    expect(body.byEndpoint).toEqual([])
    expect(Date.parse(body.generatedAt)).not.toBeNaN()
  })

  it('aggregates statuses, usage, honest cost sources and timing dimensions', async () => {
    const service = ledger()
    const completed = service.begin({
      endpointId: 1,
      operation: 'agent.translate',
      requestedModel: 'provider/model-one',
    })
    service.markReceiving(completed.id, { firstByteMs: 100 })
    service.complete(completed.id, {
      usage: {
        source: 'provider',
        inputTokens: 100,
        outputTokens: 30,
        reasoningTokens: 5,
      },
      cost: {
        source: 'estimated',
        currency: 'USD',
        priceSnapshot: {
          currency: 'USD',
          inputPerMillionTokens: 1,
          outputPerMillionTokens: 3,
          reasoningPerMillionTokens: 8,
          source: 'user_configured',
          capturedAt: '2026-08-09T00:00:00.000Z',
        },
      },
      latencyMs: 300,
    })

    const failed = service.begin({
      endpointId: 1,
      operation: 'agent.translate',
      requestedModel: 'provider/model-one',
      retryCount: 1,
    })
    service.fail(failed.id, {
      errorCode: 'provider_timeout',
      cost: { source: 'provider', amount: 0.01, currency: 'USD' },
      latencyMs: 500,
    })

    service.begin({
      endpointId: 2,
      operation: 'doctor.models',
      requestedModel: 'provider/model-two',
      initialStatus: 'queued',
    })

    const response = await createHandlers(db).GET()
    const body = await response.json()

    expect(body.calls).toEqual({
      total: 3,
      queued: 1,
      connecting: 0,
      receiving: 0,
      complete: 1,
      failed: 1,
      cancelled: 0,
    })
    expect(body.usage).toEqual({
      inputTokens: 100,
      outputTokens: 30,
      reasoningTokens: 5,
      bySource: [
        {
          source: 'provider',
          callCount: 1,
          inputTokens: 100,
          outputTokens: 30,
          reasoningTokens: 5,
        },
        {
          source: 'unknown',
          callCount: 2,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
      ],
    })
    expect(body.costs).toEqual({
      known: [
        {
          source: 'provider',
          currency: 'USD',
          amount: 0.01,
          callCount: 1,
        },
        {
          source: 'estimated',
          currency: 'USD',
          amount: 0.00023,
          callCount: 1,
        },
      ],
      unknownCallCount: 1,
    })
    expect(body.timing).toEqual({
      averageFirstByteMs: 100,
      averageLatencyMs: 400,
    })

    expect(body.byOperation).toEqual([
      expect.objectContaining({
        operation: 'agent.translate',
        callCount: 2,
        completeCount: 1,
        failedCount: 1,
        inputTokens: 100,
        averageLatencyMs: 400,
      }),
      expect.objectContaining({
        operation: 'doctor.models',
        callCount: 1,
        averageLatencyMs: null,
      }),
    ])
    expect(body.byModel[0]).toEqual(
      expect.objectContaining({
        requestedModel: 'provider/model-one',
        callCount: 2,
      }),
    )
    expect(body.byEndpoint).toEqual([
      expect.objectContaining({ endpointId: 1, callCount: 2 }),
      expect.objectContaining({ endpointId: 2, callCount: 1 }),
    ])
  })

  it('never exposes prompt-adjacent text, URLs, query strings or API keys', async () => {
    const service = ledger()
    const call = service.begin({
      sessionId: 'private-session',
      endpointId: 1,
      operation: 'chat.edit',
      requestedModel: 'provider/model-one',
    })
    service.complete(call.id, { latencyMs: 10 })

    const response = await createHandlers(db).GET()
    const serialized = JSON.stringify(await response.json())
    expect(serialized).not.toContain('original text must stay private')
    expect(serialized).not.toContain('sk-secret')
    expect(serialized).not.toContain('https://')
    expect(serialized).not.toContain('?tenant=')
    expect(serialized).not.toContain('private-session')
  })
})
