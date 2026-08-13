import type Database from 'better-sqlite3'
import {
  chatCompletion,
  isAsyncIterable,
  LLMError,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type LLMStreamEvent,
} from '../llm/client'
import type { LlmCallUsage } from '../contracts/llm-call-records'
import { createLlmCallRecordsService } from './llm-call-records-service'

const SAFE_ERROR_CODES = new Set([
  'auth_error',
  'rate_limit',
  'server_error',
  'timeout',
  'network',
  'client_error',
  'tools_not_supported',
  'aborted',
  'incomplete_output',
  'unknown',
  'stream_cancelled',
  'empty_response',
])

type SafeLedgerErrorCode =
  | 'stream_cancelled'
  | 'empty_response'

export interface BestEffortLlmCallLedger {
  markReceiving(): void
  complete(usage?: ChatCompletionResponse['usage']): void
  fail(
    error: unknown,
    usage?: ChatCompletionResponse['usage'],
    overrideCode?: SafeLedgerErrorCode,
  ): void
}

const NOOP_LEDGER: BestEffortLlmCallLedger = {
  markReceiving() {},
  complete() {},
  fail() {},
}

function providerUsage(
  usage: ChatCompletionResponse['usage'] | undefined,
): LlmCallUsage | undefined {
  if (!usage) return undefined
  const inputTokens =
    Number.isInteger(usage.prompt_tokens) && usage.prompt_tokens >= 0
      ? usage.prompt_tokens
      : null
  const outputTokens =
    Number.isInteger(usage.completion_tokens) && usage.completion_tokens >= 0
      ? usage.completion_tokens
      : null
  if (inputTokens === null && outputTokens === null) return undefined
  return {
    source: 'provider',
    inputTokens,
    outputTokens,
    reasoningTokens: null,
  }
}

function safeErrorCode(error: unknown): string {
  if (error instanceof LLMError && SAFE_ERROR_CODES.has(error.code)) {
    return error.code
  }
  return 'llm_call_failed'
}

/**
 * Starts a content-free accounting record for one physical provider request.
 * Every accounting operation is deliberately best-effort: a broken ledger
 * must never change the provider request or its result.
 */
export function beginBestEffortLlmCall(
  input: {
    db: Database.Database
    sessionId?: string | null
    runId?: string | null
    invocationId?: string | null
    endpointId: number
    model: string
    operation: string
    retryCount?: number
  },
  options: { monotonicNow?: () => number } = {},
): BestEffortLlmCallLedger {
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const startedAt = monotonicNow()

  try {
    const service = createLlmCallRecordsService(input.db)
    const record = service.begin({
      sessionId: input.sessionId ?? null,
      runId: input.runId ?? null,
      invocationId: input.invocationId ?? null,
      endpointId: input.endpointId,
      operation: input.operation,
      requestedModel: input.model,
      retryCount: input.retryCount ?? 0,
    })
    let receiving = false
    let terminal = false
    const elapsed = () =>
      Math.max(0, Math.round(monotonicNow() - startedAt))

    return {
      markReceiving() {
        if (receiving || terminal) return
        receiving = true
        try {
          service.markReceiving(record.id, { firstByteMs: elapsed() })
        } catch {
          // Accounting must not interfere with the provider call.
        }
      },

      complete(usage) {
        if (terminal) return
        terminal = true
        try {
          service.complete(record.id, {
            usage: providerUsage(usage),
            latencyMs: elapsed(),
          })
        } catch {
          // The provider response remains authoritative.
        }
      },

      fail(error, usage, overrideCode) {
        if (terminal) return
        terminal = true
        const errorCode = overrideCode ?? safeErrorCode(error)
        try {
          service.fail(record.id, {
            outcome:
              errorCode === 'aborted' || errorCode === 'stream_cancelled'
                ? 'cancelled'
                : 'failed',
            errorCode,
            usage: providerUsage(usage),
            latencyMs: elapsed(),
          })
        } catch {
          // Never replace a provider failure with an accounting failure.
        }
      },
    }
  } catch {
    return NOOP_LEDGER
  }
}

export interface BestEffortLlmCallContext {
  db: Database.Database
  sessionId: string
  endpointId: number
  operation: string
  retryCount?: number
}

/**
 * Wrap exactly one physical OpenAI-compatible request with privacy-safe,
 * best-effort accounting. The wrapper stores only identifiers, timing, status,
 * and provider token counts; request/response content and endpoint credentials
 * never cross the ledger boundary.
 */
export async function ledgeredChatCompletion(
  endpoint: {
    baseUrl: string
    chatCompletionsPath?: string
    apiKey: string
  },
  request: ChatCompletionRequest,
  context?: BestEffortLlmCallContext,
): Promise<ChatCompletionResponse | AsyncIterable<LLMStreamEvent>> {
  const baseRetryCount = context?.retryCount ?? 0
  const beginLedger = (retryCount: number) =>
    context
      ? beginBestEffortLlmCall({
          db: context.db,
          sessionId: context.sessionId,
          runId: null,
          invocationId: null,
          endpointId: context.endpointId,
          model: request.model,
          operation: context.operation,
          retryCount,
        })
      : NOOP_LEDGER
  let compatibilityRetryOffset = 0
  let ledger = beginLedger(baseRetryCount)

  try {
    const response = await chatCompletion(endpoint, {
      ...request,
      onCompatibilityRetry(error) {
        // The first HTTP request was explicitly rejected by the provider.
        // Close that physical-call record before the client performs its one
        // compatibility retry, then account for the retry independently.
        ledger.fail(error)
        compatibilityRetryOffset += 1
        ledger = beginLedger(baseRetryCount + compatibilityRetryOffset)
        request.onCompatibilityRetry?.(error)
      },
      onActivity() {
        ledger.markReceiving()
        request.onActivity?.()
      },
    })

    if (!isAsyncIterable(response)) {
      ledger.markReceiving()
      if (response.content.trim() || response.toolCalls?.length) {
        ledger.complete(response.usage)
      } else {
        ledger.fail(
          new Error('provider returned no visible content or tool call'),
          response.usage,
          'empty_response',
        )
      }
      return response
    }

    return (async function* ledgeredStream() {
      let usage: ChatCompletionResponse['usage'] | undefined
      let content = ''
      let toolCallCount = 0
      let ended = false
      const settleCompletedResponse = () => {
        ledger.markReceiving()
        if (content.trim() || toolCallCount > 0) {
          ledger.complete(usage)
        } else {
          ledger.fail(
            new Error('provider returned no visible content or tool call'),
            usage,
            'empty_response',
          )
        }
      }
      try {
        for await (const event of response) {
          ledger.markReceiving()
          if (event.type === 'text') content += event.content
          if (event.type === 'done') {
            content = event.content || content
            toolCallCount = event.toolCalls?.length ?? toolCallCount
            usage = event.usage ?? usage
            // The provider has already sent its terminal event. Settle before
            // yielding so a consumer that stops at `done` cannot turn a
            // completed physical request into a spurious cancellation.
            settleCompletedResponse()
          }
          yield event
        }
        ended = true
        settleCompletedResponse()
      } catch (error) {
        ended = true
        ledger.fail(error, usage)
        throw error
      } finally {
        if (!ended) {
          ledger.fail(
            new Error('stream cancelled before completion'),
            usage,
            'stream_cancelled',
          )
        }
      }
    })()
  } catch (error) {
    ledger.fail(error)
    throw error
  }
}
