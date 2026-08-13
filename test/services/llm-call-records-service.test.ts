import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { ZodError } from 'zod'
import { migrate } from '../../src/lib/db/migrate'
import { LlmCallRecordDataError } from '../../src/lib/db/llm-call-records-repository'
import {
  createLlmCallRecordsService,
  InvalidLlmCallReferenceError,
  InvalidLlmCallTransitionError,
} from '../../src/lib/services/llm-call-records-service'

function seedReferences(db: Database.Database) {
  db.prepare(`
    INSERT INTO endpoints (id, name, base_url, api_key)
    VALUES (
      1,
      'private endpoint',
      'https://example.invalid/v1?organization=private',
      'sk-never-store-this'
    )
  `).run()
  db.prepare(`
    INSERT INTO sessions (id, source_text, config_snapshot)
    VALUES ('session-1', 'private source passage', '{}')
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
      'provider/model-v1', 'running'
    )
  `).run()
}

const priceSnapshot = {
  currency: 'USD' as const,
  inputPerMillionTokens: 1.25,
  outputPerMillionTokens: 5,
  reasoningPerMillionTokens: 8,
  source: 'user_configured' as const,
  capturedAt: '2026-08-09T00:00:00.000Z',
}

describe('LLM call records service', () => {
  let db: Database.Database
  let nextId: number

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    seedReferences(db)
    nextId = 1
  })

  afterEach(() => {
    db.close()
  })

  function service() {
    return createLlmCallRecordsService(db, {
      createId: () => `call-${nextId++}`,
    })
  }

  it('keeps an immutable endpoint snapshot even after endpoint configuration is gone', () => {
    const ledger = service()
    const begun = ledger.begin({
      sessionId: 'session-1',
      endpointId: 999,
      operation: 'chat.edit',
      requestedModel: 'frozen/model',
    })

    expect(begun).toMatchObject({
      sessionId: 'session-1',
      endpointId: 999,
      status: 'connecting',
    })
    expect(ledger.complete(begun.id)).toMatchObject({
      endpointId: 999,
      status: 'complete',
    })
  })

  it('accepts provider model display names with internal spaces', () => {
    const ledger = service()
    const begun = ledger.begin({
      endpointId: 1,
      operation: 'agent.translate',
      requestedModel: 'DeepSeek V4 Flash: Go',
    })
    const completed = ledger.complete(begun.id, {
      responseModel: 'GLM 5.2: Go',
    })

    expect(completed).toMatchObject({
      requestedModel: 'DeepSeek V4 Flash: Go',
      responseModel: 'GLM 5.2: Go',
      status: 'complete',
    })
  })

  it('auto-links an invocation and records first-byte, usage and estimated cost', () => {
    const ledger = service()
    const begun = ledger.begin({
      invocationId: 'invocation-1',
      endpointId: 1,
      operation: 'agent.translate',
      requestedModel: 'provider/model-v1',
    })

    expect(begun).toMatchObject({
      id: 'call-1',
      sessionId: 'session-1',
      runId: 'run-1',
      invocationId: 'invocation-1',
      status: 'connecting',
      usageSource: 'unknown',
      costSource: 'unknown',
    })

    expect(
      ledger.markReceiving(begun.id, {
        responseModel: 'provider/model-v1.1',
        firstByteMs: 125,
      }),
    ).toMatchObject({
      status: 'receiving',
      firstByteMs: 125,
      responseModel: 'provider/model-v1.1',
    })

    const completed = ledger.complete(begun.id, {
      usage: {
        source: 'provider',
        inputTokens: 120,
        outputTokens: 45,
        reasoningTokens: 10,
      },
      cost: {
        source: 'estimated',
        currency: 'USD',
        priceSnapshot,
      },
      latencyMs: 850,
    })
    expect(completed).toMatchObject({
      status: 'complete',
      inputTokens: 120,
      outputTokens: 45,
      reasoningTokens: 10,
      usageSource: 'provider',
      latencyMs: 850,
      costAmount: 0.000455,
      costCurrency: 'USD',
      costSource: 'estimated',
      priceSnapshot,
      errorCode: null,
    })

    // Terminal writes are idempotent and never rewrite the original accounting.
    expect(
      ledger.complete(begun.id, {
        usage: {
          source: 'estimated',
          inputTokens: 999,
          outputTokens: null,
          reasoningTokens: null,
        },
      }).inputTokens,
    ).toBe(120)
  })

  it('keeps provider-reported, locally estimated and unknown cost distinct', () => {
    const ledger = service()
    const provider = ledger.begin({
      endpointId: 1,
      operation: 'doctor.chat',
      requestedModel: 'provider/model-v1',
    })
    const providerComplete = ledger.complete(provider.id, {
      cost: { source: 'provider', amount: 0.02, currency: 'USD' },
      latencyMs: 50,
    })
    expect(providerComplete).toMatchObject({
      costSource: 'provider',
      costAmount: 0.02,
      costCurrency: 'USD',
      priceSnapshot: null,
    })

    const unknown = ledger.begin({
      endpointId: 1,
      operation: 'doctor.usage',
      requestedModel: 'provider/model-v1',
    })
    expect(ledger.complete(unknown.id, { latencyMs: 30 })).toMatchObject({
      costSource: 'unknown',
      costAmount: null,
      costCurrency: null,
      priceSnapshot: null,
      usageSource: 'unknown',
    })
  })

  it('rejects a local cost estimate when usage or a required rate is unknown', () => {
    const ledger = service()
    const noUsage = ledger.begin({
      endpointId: 1,
      operation: 'doctor.usage',
      requestedModel: 'provider/model-v1',
    })
    expect(() => ledger.complete(noUsage.id, {
      cost: {
        source: 'estimated',
        currency: 'USD',
        priceSnapshot,
      },
    })).toThrow('Estimated cost requires')

    const missingRate = ledger.begin({
      endpointId: 1,
      operation: 'doctor.usage',
      requestedModel: 'provider/model-v1',
    })
    expect(() => ledger.complete(missingRate.id, {
      usage: {
        source: 'provider',
        inputTokens: null,
        outputTokens: 10,
        reasoningTokens: null,
      },
      cost: {
        source: 'estimated',
        currency: 'USD',
        priceSnapshot: {
          ...priceSnapshot,
          outputPerMillionTokens: null,
        },
      },
    })).toThrow('missing the output token rate')
  })

  it('records safe failure codes and prevents terminal-state rewrites', () => {
    const ledger = service()
    const begun = ledger.begin({
      endpointId: 1,
      operation: 'chat.edit',
      requestedModel: 'provider/model-v1',
    })
    const failed = ledger.fail(begun.id, {
      errorCode: 'provider_rate_limited',
      usage: {
        source: 'provider',
        inputTokens: 21,
        outputTokens: 0,
        reasoningTokens: null,
      },
      latencyMs: 300,
    })
    expect(failed).toMatchObject({
      status: 'failed',
      errorCode: 'provider_rate_limited',
      inputTokens: 21,
      costSource: 'unknown',
    })
    expect(() => ledger.complete(begun.id)).toThrow(
      InvalidLlmCallTransitionError,
    )
    expect(ledger.fail(begun.id, {
      errorCode: 'different_code',
    })).toEqual(failed)
  })

  it('rejects prompt, credential and URL-query shaped inputs before insertion', () => {
    const ledger = service()
    const base = {
      endpointId: 1,
      operation: 'agent.translate',
      requestedModel: 'provider/model-v1',
    }

    expect(() =>
      ledger.begin({ ...base, prompt: 'private source' } as never),
    ).toThrow(ZodError)
    expect(() =>
      ledger.begin({ ...base, apiKey: 'sk-private' } as never),
    ).toThrow(ZodError)
    expect(() =>
      ledger.begin({
        ...base,
        requestedModel: 'https://host.invalid/model?api_key=sk-private',
      }),
    ).toThrow(ZodError)
    expect(
      db.prepare('SELECT COUNT(*) FROM llm_call_records').pluck().get(),
    ).toBe(0)
  })

  it('rejects inconsistent orchestration links and diagnoses corrupt JSON', () => {
    const ledger = service()
    expect(() =>
      ledger.begin({
        sessionId: 'missing-session',
        invocationId: 'invocation-1',
        endpointId: 1,
        operation: 'agent.translate',
        requestedModel: 'provider/model-v1',
      }),
    ).toThrow(InvalidLlmCallReferenceError)

    const begun = ledger.begin({
      endpointId: 1,
      operation: 'agent.translate',
      requestedModel: 'provider/model-v1',
    })
    ledger.complete(begun.id, {
      usage: {
        source: 'provider',
        inputTokens: 1,
        outputTokens: 1,
        reasoningTokens: null,
      },
      cost: {
        source: 'estimated',
        currency: 'USD',
        priceSnapshot,
      },
    })
    db.prepare(
      'UPDATE llm_call_records SET price_snapshot_json = ? WHERE id = ?',
    ).run('{not-json', begun.id)

    expect(() => ledger.getById(begun.id)).toThrow(LlmCallRecordDataError)
  })
})
