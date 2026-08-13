import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

vi.mock('../../src/lib/llm/client', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../src/lib/llm/client')>()
  return {
    ...original,
    chatCompletion: vi.fn(),
  }
})

import {
  chatCompletion,
  ClientError,
  isAsyncIterable,
  ToolsNotSupportedError,
  type LLMStreamEvent,
} from '../../src/lib/llm/client'
import { migrate } from '../../src/lib/db/migrate'
import { runChatTurn } from '../../src/lib/chat/tool-loop'
import { generateRevisionSuggestion } from '../../src/lib/chat/revision-suggestions'
import { ledgeredChatCompletion } from '../../src/lib/services/llm-call-ledger'

interface LedgerRow {
  session_id: string | null
  run_id: string | null
  invocation_id: string | null
  endpoint_id: number
  operation: string
  requested_model: string
  status: string
  input_tokens: number | null
  output_tokens: number | null
  usage_source: string
  first_byte_ms: number | null
  latency_ms: number | null
  retry_count: number
  error_code: string | null
}

function createLedgerDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  const endpointId = Number(
    db.prepare(
      'INSERT INTO endpoints (name, base_url, api_key) VALUES (?, ?, ?)',
    ).run(
      'private endpoint',
      'https://ledger-secret.example.invalid/v1',
      'sk-ledger-secret-value',
    ).lastInsertRowid,
  )
  const sessionId = 'ledger-chat-session'
  db.prepare(`
    INSERT INTO sessions
      (id, source_text, source_lang, target_lang, state, config_snapshot)
    VALUES (?, ?, 'English', 'Chinese', 'assembled', '{}')
  `).run(sessionId, 'SOURCE_TEXT_MUST_NEVER_ENTER_LEDGER')
  return { db, endpointId, sessionId }
}

function rows(db: Database.Database): LedgerRow[] {
  return db.prepare(`
    SELECT session_id, run_id, invocation_id, endpoint_id, operation,
           requested_model, status, input_tokens, output_tokens, usage_source,
           first_byte_ms, latency_ms, retry_count, error_code
    FROM llm_call_records
    ORDER BY retry_count, operation
  `).all() as LedgerRow[]
}

function streamOf(content: string): AsyncIterable<LLMStreamEvent> {
  return (async function* () {
    yield { type: 'text' as const, content }
    yield {
      type: 'done' as const,
      content,
      usage: {
        prompt_tokens: 31,
        completion_tokens: 12,
        total_tokens: 43,
      },
    }
  })()
}

describe('chat and revision-suggestion LLM call ledger integration', () => {
  beforeEach(() => {
    vi.mocked(chatCompletion).mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('records every chat-edit physical request, including native-tool fallback', async () => {
    const { db, endpointId, sessionId } = createLedgerDb()
    try {
      vi.mocked(chatCompletion)
        .mockRejectedValueOnce(new ToolsNotSupportedError('tools unavailable'))
        .mockResolvedValueOnce({
          content:
            '```json\n' +
            '{"old_string":"old text","new_string":"new text"}\n' +
            '```',
          usage: {
            prompt_tokens: 19,
            completion_tokens: 8,
            total_tokens: 27,
          },
        })

      const result = await runChatTurn({
        endpoint: {
          baseUrl: 'https://ledger-secret.example.invalid/v1',
          apiKey: 'sk-ledger-secret-value',
        },
        model: 'DeepSeek V4 Flash: Go',
        messages: [
          { role: 'system', content: 'SYSTEM_PROMPT_MUST_NEVER_ENTER_LEDGER' },
          { role: 'user', content: 'USER_PROMPT_MUST_NEVER_ENTER_LEDGER' },
        ],
        currentText: 'old text',
        ledger: { db, sessionId, endpointId },
      })

      expect(result).toMatchObject({
        ok: true,
        kind: 'edited',
        newText: 'new text',
      })
      const recorded = rows(db)
      expect(recorded).toHaveLength(2)
      expect(recorded.map((row) => ({
        sessionId: row.session_id,
        runId: row.run_id,
        invocationId: row.invocation_id,
        endpointId: row.endpoint_id,
        operation: row.operation,
        model: row.requested_model,
        status: row.status,
        retryCount: row.retry_count,
        errorCode: row.error_code,
      }))).toEqual([
        {
          sessionId,
          runId: null,
          invocationId: null,
          endpointId,
          operation: 'chat_edit',
          model: 'DeepSeek V4 Flash: Go',
          status: 'failed',
          retryCount: 0,
          errorCode: 'tools_not_supported',
        },
        {
          sessionId,
          runId: null,
          invocationId: null,
          endpointId,
          operation: 'chat_edit',
          model: 'DeepSeek V4 Flash: Go',
          status: 'complete',
          retryCount: 1,
          errorCode: null,
        },
      ])
      expect(recorded[1]).toMatchObject({
        input_tokens: 19,
        output_tokens: 8,
        usage_source: 'provider',
      })
      expect(recorded[1].first_byte_ms).not.toBeNull()
      expect(recorded[1].latency_ms).not.toBeNull()

      const persisted = JSON.stringify(recorded)
      expect(persisted).not.toContain('SYSTEM_PROMPT_MUST_NEVER_ENTER_LEDGER')
      expect(persisted).not.toContain('USER_PROMPT_MUST_NEVER_ENTER_LEDGER')
      expect(persisted).not.toContain('SOURCE_TEXT_MUST_NEVER_ENTER_LEDGER')
      expect(persisted).not.toContain('old text')
      expect(persisted).not.toContain('new text')
      expect(persisted).not.toContain('sk-ledger-secret-value')
      expect(persisted).not.toContain('ledger-secret.example.invalid')
    } finally {
      db.close()
    }
  })

  it('records the stream-options compatibility retry as a second physical call', async () => {
    const { db, endpointId, sessionId } = createLedgerDb()
    try {
      vi.mocked(chatCompletion).mockImplementation(async (_endpoint, request) => {
        request.onActivity?.()
        request.onCompatibilityRetry?.(
          new ClientError('stream_options is unsupported', 400),
        )
        request.onActivity?.()
        return {
          content: 'safe result',
          usage: {
            prompt_tokens: 13,
            completion_tokens: 4,
            total_tokens: 17,
          },
        }
      })

      const result = await ledgeredChatCompletion(
        {
          baseUrl: 'https://ledger-secret.example.invalid/v1',
          apiKey: 'sk-ledger-secret-value',
        },
        {
          model: 'DeepSeek V4 Flash: Go',
          messages: [{ role: 'user', content: 'PROMPT_MUST_NOT_BE_STORED' }],
          stream: true,
        },
        {
          db,
          sessionId,
          endpointId,
          operation: 'chat_edit',
        },
      )

      expect(result).toMatchObject({ content: 'safe result' })
      expect(rows(db)).toMatchObject([
        {
          session_id: sessionId,
          operation: 'chat_edit',
          status: 'failed',
          retry_count: 0,
          error_code: 'client_error',
        },
        {
          session_id: sessionId,
          operation: 'chat_edit',
          status: 'complete',
          retry_count: 1,
          usage_source: 'provider',
          input_tokens: 13,
          output_tokens: 4,
          error_code: null,
        },
      ])
      expect(JSON.stringify(rows(db))).not.toContain('PROMPT_MUST_NOT_BE_STORED')
    } finally {
      db.close()
    }
  })

  it('records the three revision-suggestion mirrors as three separate calls', async () => {
    const { db, endpointId, sessionId } = createLedgerDb()
    try {
      vi.mocked(chatCompletion).mockImplementation(async (_endpoint, request) => {
        const system = request.messages[0]?.content ?? ''
        if (system.includes('把两份隔离意见整理成')) return streamOf('最终建议')
        if (system.includes('独立的中文成品读者')) return streamOf('读者报告')
        if (system.includes('双语核验者')) return streamOf('核验报告')
        throw new Error('unexpected revision lens')
      })

      const result = await generateRevisionSuggestion({
        endpoint: {
          baseUrl: 'https://ledger-secret.example.invalid/v1',
          apiKey: 'sk-ledger-secret-value',
        },
        model: 'DeepSeek V4 Flash: Go',
        promptLanguage: 'zh',
        sourceText: 'SOURCE_TEXT_MUST_NEVER_ENTER_LEDGER',
        taskBrief: 'TASK_BRIEF_MUST_NEVER_ENTER_LEDGER',
        currentTranslation: 'TRANSLATION_MUST_NEVER_ENTER_LEDGER',
        userRequest: 'USER_REQUEST_MUST_NEVER_ENTER_LEDGER',
        ledger: { db, sessionId, endpointId },
      })

      expect(result).toEqual({
        targetReaderReport: '读者报告',
        bilingualReport: '核验报告',
        feedback: '最终建议',
      })
      const recorded = rows(db).sort((left, right) =>
        left.operation.localeCompare(right.operation),
      )
      expect(recorded).toHaveLength(3)
      expect(recorded.map((row) => row.operation)).toEqual([
        'chat_revision_suggestion_arbiter',
        'chat_revision_suggestion_bilingual',
        'chat_revision_suggestion_target_reader',
      ])
      for (const row of recorded) {
        expect(row).toMatchObject({
          session_id: sessionId,
          run_id: null,
          invocation_id: null,
          endpoint_id: endpointId,
          requested_model: 'DeepSeek V4 Flash: Go',
          status: 'complete',
          input_tokens: 31,
          output_tokens: 12,
          usage_source: 'provider',
          retry_count: 0,
          error_code: null,
        })
      }

      const persisted = JSON.stringify(recorded)
      for (const forbidden of [
        'SOURCE_TEXT_MUST_NEVER_ENTER_LEDGER',
        'TASK_BRIEF_MUST_NEVER_ENTER_LEDGER',
        'TRANSLATION_MUST_NEVER_ENTER_LEDGER',
        'USER_REQUEST_MUST_NEVER_ENTER_LEDGER',
        'sk-ledger-secret-value',
        'ledger-secret.example.invalid',
      ]) {
        expect(persisted).not.toContain(forbidden)
      }
    } finally {
      db.close()
    }
  })

  it('marks contentless provider responses failed without changing the chat result', async () => {
    const { db, endpointId, sessionId } = createLedgerDb()
    try {
      vi.mocked(chatCompletion).mockResolvedValue({
        content: '',
        usage: {
          prompt_tokens: 7,
          completion_tokens: 0,
          total_tokens: 7,
        },
      })

      const result = await runChatTurn({
        endpoint: {
          baseUrl: 'https://ledger-secret.example.invalid/v1',
          apiKey: 'sk-ledger-secret-value',
        },
        model: 'DeepSeek V4 Flash: Go',
        messages: [{ role: 'user', content: 'Return something.' }],
        currentText: 'unchanged',
        stream: false,
        ledger: { db, sessionId, endpointId },
      })

      expect(result).toEqual({ ok: true, kind: 'message', text: '' })
      expect(rows(db)).toMatchObject([
        {
          session_id: sessionId,
          operation: 'chat_edit',
          status: 'failed',
          usage_source: 'provider',
          input_tokens: 7,
          output_tokens: 0,
          error_code: 'empty_response',
        },
      ])
    } finally {
      db.close()
    }
  })

  it('keeps a contentless tool-only response valid', async () => {
    const { db, endpointId, sessionId } = createLedgerDb()
    try {
      vi.mocked(chatCompletion).mockResolvedValue({
        content: '',
        toolCalls: [
          {
            id: 'call-1',
            name: 'replace_text',
            arguments: '{"old_string":"a","new_string":"b"}',
          },
        ],
      })

      await ledgeredChatCompletion(
        {
          baseUrl: 'https://ledger-secret.example.invalid/v1',
          apiKey: 'sk-ledger-secret-value',
        },
        {
          model: 'DeepSeek V4 Flash: Go',
          messages: [{ role: 'user', content: 'edit' }],
          tools: [],
          stream: false,
        },
        {
          db,
          sessionId,
          endpointId,
          operation: 'chat_edit',
        },
      )

      expect(rows(db)).toMatchObject([
        {
          session_id: sessionId,
          operation: 'chat_edit',
          status: 'complete',
          error_code: null,
        },
      ])
    } finally {
      db.close()
    }
  })

  it('marks an abandoned provider stream as cancelled', async () => {
    const { db, endpointId, sessionId } = createLedgerDb()
    try {
      vi.mocked(chatCompletion).mockResolvedValue(
        (async function* () {
          yield { type: 'text' as const, content: 'partial' }
          yield { type: 'done' as const, content: 'partial' }
        })(),
      )

      const response = await ledgeredChatCompletion(
        {
          baseUrl: 'https://ledger-secret.example.invalid/v1',
          apiKey: 'sk-ledger-secret-value',
        },
        {
          model: 'DeepSeek V4 Flash: Go',
          messages: [{ role: 'user', content: 'stream' }],
          stream: true,
        },
        {
          db,
          sessionId,
          endpointId,
          operation: 'chat_edit',
        },
      )
      expect(isAsyncIterable(response)).toBe(true)
      if (!isAsyncIterable(response)) throw new Error('stream expected')
      const iterator = response[Symbol.asyncIterator]()
      await iterator.next()
      await iterator.return?.()

      expect(rows(db)).toMatchObject([
        {
          session_id: sessionId,
          operation: 'chat_edit',
          status: 'cancelled',
          error_code: 'stream_cancelled',
        },
      ])
    } finally {
      db.close()
    }
  })

  it('keeps a stream complete when the consumer stops after the provider done event', async () => {
    const { db, endpointId, sessionId } = createLedgerDb()
    try {
      vi.mocked(chatCompletion).mockResolvedValue(
        (async function* () {
          yield {
            type: 'done' as const,
            content: 'final response',
            usage: {
              prompt_tokens: 5,
              completion_tokens: 2,
              total_tokens: 7,
            },
          }
        })(),
      )

      const response = await ledgeredChatCompletion(
        {
          baseUrl: 'https://ledger-secret.example.invalid/v1',
          apiKey: 'sk-ledger-secret-value',
        },
        {
          model: 'DeepSeek V4 Flash: Go',
          messages: [{ role: 'user', content: 'stream' }],
          stream: true,
        },
        {
          db,
          sessionId,
          endpointId,
          operation: 'chat_edit',
        },
      )
      if (!isAsyncIterable(response)) throw new Error('stream expected')
      const iterator = response[Symbol.asyncIterator]()
      await iterator.next()
      await iterator.return?.()

      expect(rows(db)).toMatchObject([
        {
          session_id: sessionId,
          operation: 'chat_edit',
          status: 'complete',
          usage_source: 'provider',
          input_tokens: 5,
          output_tokens: 2,
          error_code: null,
        },
      ])
    } finally {
      db.close()
    }
  })

  it('never lets an unavailable ledger change a provider result', async () => {
    const brokenDb = new Database(':memory:')
    brokenDb.close()
    vi.mocked(chatCompletion).mockResolvedValue({ content: 'still succeeds' })

    const result = await runChatTurn({
      endpoint: {
        baseUrl: 'https://example.invalid',
        apiKey: 'sk-secret',
      },
      model: 'safe-model',
      messages: [{ role: 'user', content: 'hello' }],
      currentText: 'unchanged',
      stream: false,
      ledger: {
        db: brokenDb,
        sessionId: 'missing-session',
        endpointId: 999,
      },
    })

    expect(result).toEqual({
      ok: true,
      kind: 'message',
      text: 'still succeeds',
    })
  })
})
