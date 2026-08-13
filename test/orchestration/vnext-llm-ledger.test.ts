import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../../src/lib/db/migrate'
import {
  chatCompletion,
  LLMError,
  type ChatCompletionRequest,
  type LLMStreamEvent,
} from '../../src/lib/llm/client'
import {
  complete,
  ledgeredFanOutCall,
  type VNextLlmLedgerContext,
} from '../../src/lib/orchestration/vnext-runner'

vi.mock('../../src/lib/llm/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm/client')>()
  return {
    ...actual,
    chatCompletion: vi.fn(),
  }
})

const PRIVATE_SOURCE = 'SOURCE-SHOULD-NEVER-ENTER-THE-LEDGER'
const PRIVATE_SYSTEM_PROMPT = 'PROMPT-SHOULD-NEVER-ENTER-THE-LEDGER'
const PRIVATE_API_KEY = 'sk-api-key-should-never-enter-the-ledger'
const PRIVATE_ERROR_MESSAGE = 'provider error contains private tenant details'

const endpoint = {
  id: 1,
  name: 'private endpoint',
  baseUrl: 'https://example.invalid/v1?tenant=private',
  chatCompletionsPath: '/v1/chat/completions',
  apiKey: PRIVATE_API_KEY,
  contextWindow: 128_000,
}

const request: ChatCompletionRequest = {
  model: 'provider/model-v1',
  messages: [
    { role: 'system', content: PRIVATE_SYSTEM_PROMPT },
    { role: 'user', content: PRIVATE_SOURCE },
  ],
}

async function* successfulStream(): AsyncIterable<LLMStreamEvent> {
  yield { type: 'text', content: 'translated ' }
  yield {
    type: 'done',
    content: 'translated result',
    transport: 'sse',
    usage: {
      prompt_tokens: 21,
      completion_tokens: 8,
      total_tokens: 29,
    },
  }
}

function seedLedgerReferences(db: Database.Database) {
  db.prepare(`
    INSERT INTO endpoints (
      id, name, base_url, chat_completions_path, api_key, context_window
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    endpoint.id,
    endpoint.name,
    endpoint.baseUrl,
    endpoint.chatCompletionsPath,
    endpoint.apiKey,
    endpoint.contextWindow,
  )
  db.prepare(`
    INSERT INTO sessions (id, source_text, config_snapshot)
    VALUES ('session-ledger', ?, '{}')
  `).run(PRIVATE_SOURCE)
  db.prepare(`
    INSERT INTO orchestration_runs (id, session_id, status)
    VALUES ('run-ledger', 'session-ledger', 'running')
  `).run()
}

describe('vNext runner LLM ledger integration', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    seedLedgerReferences(db)
    vi.mocked(chatCompletion).mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    db.close()
  })

  function ledgerContext(
    ledgerDb: Database.Database = db,
  ): VNextLlmLedgerContext {
    return {
      db: ledgerDb,
      sessionId: 'session-ledger',
      runId: 'run-ledger',
      operation: 'assemble',
    }
  }

  it('records every physical retry and preserves provider usage from a stream', async () => {
    vi.useFakeTimers()
    vi.mocked(chatCompletion)
      .mockRejectedValueOnce(
        new LLMError('rate_limit', PRIVATE_ERROR_MESSAGE, {
          status: 429,
          retryable: true,
        }),
      )
      .mockResolvedValueOnce(successfulStream())

    const completionPromise = complete(endpoint, request, ledgerContext())
    await vi.runAllTimersAsync()

    await expect(completionPromise).resolves.toEqual({
      content: 'translated result',
      usage: {
        prompt_tokens: 21,
        completion_tokens: 8,
        total_tokens: 29,
      },
    })
    expect(chatCompletion).toHaveBeenCalledTimes(2)

    const rows = db.prepare(`
      SELECT * FROM llm_call_records ORDER BY retry_count
    `).all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      session_id: 'session-ledger',
      run_id: 'run-ledger',
      invocation_id: null,
      endpoint_id: 1,
      operation: 'assemble',
      requested_model: 'provider/model-v1',
      status: 'failed',
      retry_count: 0,
      usage_source: 'unknown',
      error_code: 'rate_limit',
    })
    expect(rows[1]).toMatchObject({
      session_id: 'session-ledger',
      run_id: 'run-ledger',
      invocation_id: null,
      endpoint_id: 1,
      operation: 'assemble',
      requested_model: 'provider/model-v1',
      status: 'complete',
      input_tokens: 21,
      output_tokens: 8,
      reasoning_tokens: null,
      usage_source: 'provider',
      retry_count: 1,
      error_code: null,
    })

    const ledgerColumns = (
      db.prepare("PRAGMA table_info('llm_call_records')").all() as Array<{
        name: string
      }>
    ).map((column) => column.name)
    expect(ledgerColumns).not.toEqual(
      expect.arrayContaining([
        'prompt',
        'source_text',
        'api_key',
        'error',
        'error_message',
      ]),
    )
    const persistedLedger = JSON.stringify(rows)
    for (const secret of [
      PRIVATE_SOURCE,
      PRIVATE_SYSTEM_PROMPT,
      PRIVATE_API_KEY,
      PRIVATE_ERROR_MESSAGE,
    ]) {
      expect(persistedLedger).not.toContain(secret)
    }
  })

  it('returns a non-streaming result when ledger prepare fails', async () => {
    const prepareFailure = vi.fn(() => {
      throw new Error('ledger database is unavailable')
    })
    const brokenLedgerDb = new Proxy(db, {
      get(target, property) {
        if (property === 'prepare') return prepareFailure
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as Database.Database
    const providerResult = {
      content: 'non-streaming result survives accounting failure',
      usage: {
        prompt_tokens: 11,
        completion_tokens: 5,
        total_tokens: 16,
      },
    }
    vi.mocked(chatCompletion).mockResolvedValueOnce(providerResult)

    await expect(
      complete(
        endpoint,
        { ...request, stream: false },
        ledgerContext(brokenLedgerDb),
      ),
    ).resolves.toEqual(providerResult)

    expect(prepareFailure).toHaveBeenCalled()
    expect(chatCompletion).toHaveBeenCalledTimes(1)
    expect(
      db.prepare('SELECT COUNT(*) FROM llm_call_records').pluck().get(),
    ).toBe(0)
  })

  it('records a non-streaming empty fan-out response as failed', async () => {
    const providerResult = { content: '' }
    vi.mocked(chatCompletion).mockResolvedValueOnce(providerResult)

    await expect(
      ledgeredFanOutCall(endpoint, request, ledgerContext(), 0),
    ).resolves.toEqual(providerResult)

    expect(
      db.prepare(`
        SELECT status, error_code
        FROM llm_call_records
      `).get(),
    ).toEqual({ status: 'failed', error_code: 'empty_response' })
  })

  it('keeps a tool-only response valid while rejecting exhausted empty content', async () => {
    const toolOnly = {
      content: '',
      toolCalls: [{ id: 'tool-1', name: 'write_draft', arguments: '{}' }],
    }
    vi.mocked(chatCompletion).mockResolvedValueOnce(toolOnly)
    await expect(
      complete(endpoint, request, ledgerContext()),
    ).resolves.toEqual(toolOnly)

    vi.useFakeTimers()
    vi.mocked(chatCompletion).mockReset()
    vi.mocked(chatCompletion).mockResolvedValue({ content: '' })
    const exhausted = complete(endpoint, request, ledgerContext())
    const exhaustedAssertion = expect(exhausted).rejects.toMatchObject({
      code: 'empty_response',
    })
    await vi.runAllTimersAsync()
    await exhaustedAssertion

    const rows = db.prepare(`
      SELECT status, error_code
      FROM llm_call_records
      ORDER BY created_at, id
    `).all() as Array<{ status: string; error_code: string | null }>
    expect(rows[0]).toEqual({ status: 'complete', error_code: null })
    expect(rows.slice(1).length).toBeGreaterThan(0)
    expect(rows.slice(1).every(
      (row) => row.status === 'failed' && row.error_code === 'empty_response',
    )).toBe(true)
  })
})
