// ---------------------------------------------------------------------------
// LLM Client — OpenAI-compatible chat completion (bare fetch, zero framework)
//
// Provides:
//   chatCompletion(endpoint, request) → ChatCompletionResponse | AsyncIterable<LLMStreamEvent>
//   Error normalization: AuthError, RateLimitError, ServerError, etc.
//   AbortSignal.any merging for timeout + external signal
//   SSE streaming via parseSSEChunk
//   Non-stream auto-detection fallback
//   Tool call delta accumulation
//
// Wave 2 Task 8 — spec lines 641-702
// ---------------------------------------------------------------------------

import { AGENT_TIMEOUT_MS } from '../constants';
import { parseSSEChunk } from '../contracts/sse';

// =============================================================================
// Error hierarchy
// =============================================================================

/** Base error for all LLM client errors */
export class LLMError extends Error {
  public readonly code: string;
  public readonly status?: number;
  public readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    options: { status?: number; retryable: boolean },
  ) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable;
  }
}

/** 401 — invalid or expired API key */
export class AuthError extends LLMError {
  constructor(message: string, status?: number) {
    super('auth_error', message, { status, retryable: false });
    this.name = 'AuthError';
  }
}

/** 429 — rate limit exceeded */
export class RateLimitError extends LLMError {
  constructor(message: string, status?: number) {
    super('rate_limit', message, { status, retryable: true });
    this.name = 'RateLimitError';
  }
}

/** 5xx — server-side error */
export class ServerError extends LLMError {
  constructor(message: string, status?: number) {
    super('server_error', message, { status, retryable: true });
    this.name = 'ServerError';
  }
}

/** Request timed out */
export class TimeoutError extends LLMError {
  constructor(message?: string) {
    super('timeout', message ?? 'LLM request timed out', { retryable: true });
    this.name = 'TimeoutError';
  }
}

/** Network-level error (DNS, connection refused, etc.) */
export class NetworkError extends LLMError {
  constructor(message: string) {
    super('network', message, { retryable: true });
    this.name = 'NetworkError';
  }
}

/** Other 4xx — client-side error (non-retryable) */
export class ClientError extends LLMError {
  constructor(message: string, status?: number) {
    super('client_error', message, { status, retryable: false });
    this.name = 'ClientError';
  }
}

/** 400 with "tools"/"function" — endpoint doesn't support tool calls */
export class ToolsNotSupportedError extends LLMError {
  constructor(message: string) {
    super('tools_not_supported', message, { retryable: false, status: 400 });
    this.name = 'ToolsNotSupportedError';
  }
}

/** Request aborted via AbortSignal (external or timeout) */
export class AbortedError extends LLMError {
  constructor(message?: string) {
    super('aborted', message ?? 'Request was aborted', { retryable: false });
    this.name = 'AbortedError';
  }
}

// =============================================================================
// Types
// =============================================================================

/** Chat completion request */
export interface ChatCompletionRequest {
  model: string;
  messages: Array<{
    role: string;
    content: string;
    name?: string;
    tool_call_id?: string;
  }>;
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters: Record<string, unknown>;
    };
  }>;
  stream?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Non-streaming chat completion response */
export interface ChatCompletionResponse {
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: string; // JSON string
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** Events yielded by streaming chat completion */
export type LLMStreamEvent =
  | { type: 'text'; content: string }
  | {
      type: 'tool_call_delta';
      index: number;
      id?: string;
      name?: string;
      arguments: string; // JSON fragment
    }
  | {
      type: 'done';
      content: string;
      toolCalls?: Array<{
        id: string;
        name: string;
        arguments: string; // complete JSON
      }>;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };

/** Type guard for AsyncIterable */
export function isAsyncIterable(
  value: unknown,
): value is AsyncIterable<LLMStreamEvent> {
  return (
    value != null &&
    typeof value === 'object' &&
    Symbol.asyncIterator in (value as object)
  );
}

// =============================================================================
// Helpers
// =============================================================================

/** OpenAI error body shape */
interface OpenAIErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

/**
 * Map a non-ok HTTP response to the appropriate LLMError subclass.
 * Reads the response body (once) to extract the OpenAI error message.
 */
async function normalizeError(
  response: Response,
  bodyText?: string,
): Promise<never> {
  let errorMessage = `LLM request failed with status ${response.status}`;
  let errorCode = '';

  // Try to parse OpenAI error body
  if (bodyText !== undefined) {
    try {
      const errorBody = JSON.parse(bodyText) as OpenAIErrorBody;
      if (errorBody.error?.message) {
        errorMessage = errorBody.error.message;
        errorCode = errorBody.error.code ?? '';
      }
    } catch {
      // Body is not JSON — use raw text if available
      if (bodyText) {
        errorMessage = bodyText;
      }
    }
  }

  const status = response.status;

  // Check for ToolsNotSupportedError first (400 + tools/function keywords)
  if (status === 400) {
    const lowerMsg = errorMessage.toLowerCase();
    if (lowerMsg.includes('tools') || lowerMsg.includes('function')) {
      throw new ToolsNotSupportedError(errorMessage);
    }
  }

  // 401 → AuthError
  if (status === 401) {
    throw new AuthError(errorMessage, status);
  }

  // 429 → RateLimitError
  if (status === 429) {
    throw new RateLimitError(errorMessage, status);
  }

  // 5xx → ServerError
  if (status >= 500 && status < 600) {
    throw new ServerError(errorMessage, status);
  }

  // Other 4xx → ClientError
  if (status >= 400 && status < 500) {
    throw new ClientError(errorMessage, status);
  }

  // Fallback (shouldn't normally reach here)
  throw new LLMError('unknown', errorMessage, {
    status,
    retryable: status >= 500,
  });
}

/**
 * Map a fetch/network error to the appropriate LLMError subclass.
 */
function mapNetworkError(error: unknown): never {
  // AbortError (from AbortSignal)
  if (error instanceof DOMException || (error instanceof Error && error.name === 'AbortError')) {
    // Distinguish timeout from external abort
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new TimeoutError();
    }
    throw new AbortedError();
  }

  const message =
    error instanceof Error ? error.message : String(error);

  // Check for common network error patterns
  const lowerMsg = message.toLowerCase();
  if (
    lowerMsg.includes('econnrefused') ||
    lowerMsg.includes('enotfound') ||
    lowerMsg.includes('enetunreach') ||
    lowerMsg.includes('econnreset') ||
    lowerMsg.includes('fetch failed') ||
    lowerMsg.includes('network')
  ) {
    throw new NetworkError(message);
  }

  throw new NetworkError(message);
}

// =============================================================================
// Non-streaming request
// =============================================================================

async function nonStreamCompletion(
  endpoint: { baseUrl: string; apiKey: string },
  request: ChatCompletionRequest,
  signal: AbortSignal,
): Promise<ChatCompletionResponse> {
  const response = await fetch(`${endpoint.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${endpoint.apiKey}`,
    },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      ...(request.tools ? { tools: request.tools } : {}),
      stream: false,
    }),
    signal,
  });

  const bodyText = await response.text();

  if (!response.ok) {
    await normalizeError(response, bodyText);
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new ClientError('Failed to parse LLM response as JSON', response.status);
  }

  const choice = (body.choices as Array<Record<string, unknown>>)?.[0];
  const message = choice?.message as Record<string, unknown> | undefined;
  const content = (message?.content as string) ?? '';
  // reasoning_content/thinking intentionally discarded — not included in response

  // Extract tool calls
  let toolCalls: ChatCompletionResponse['toolCalls'] | undefined;
  const rawToolCalls = message?.tool_calls as Array<Record<string, unknown>> | undefined;
  if (rawToolCalls && rawToolCalls.length > 0) {
    toolCalls = rawToolCalls.map((tc) => ({
      id: (tc.id as string) ?? '',
      name: ((tc.function as Record<string, unknown>)?.name as string) ?? '',
      arguments: ((tc.function as Record<string, unknown>)?.arguments as string) ?? '',
    }));
  }

  // Extract usage
  const usage = body.usage as
    | { prompt_tokens: number; completion_tokens: number; total_tokens: number }
    | undefined;

  return {
    content,
    ...(toolCalls ? { toolCalls } : {}),
    ...(usage ? { usage } : {}),
  };
}

// =============================================================================
// Streaming request (async generator)
// =============================================================================

async function* streamCompletion(
  endpoint: { baseUrl: string; apiKey: string },
  request: ChatCompletionRequest,
  signal: AbortSignal,
): AsyncIterable<LLMStreamEvent> {
  const response = await fetch(`${endpoint.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${endpoint.apiKey}`,
    },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      ...(request.tools ? { tools: request.tools } : {}),
      stream: true,
    }),
    signal,
  });

  // Check for non-stream fallback: server returned JSON instead of SSE
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const bodyText = await response.text();

    if (!response.ok) {
      await normalizeError(response, bodyText);
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(bodyText);
    } catch {
      throw new ClientError('Failed to parse LLM response as JSON', response.status);
    }

    const choice = (body.choices as Array<Record<string, unknown>>)?.[0];
    const message = choice?.message as Record<string, unknown> | undefined;
    const content = (message?.content as string) ?? '';
    // reasoning_content/thinking intentionally discarded — not accumulated

    // Emit as text event
    if (content) {
      yield { type: 'text', content };
    }

    // Extract usage
    const usage = body.usage as
      | { prompt_tokens: number; completion_tokens: number; total_tokens: number }
      | undefined;

    // Extract tool calls from non-stream response
    let toolCalls: ChatCompletionResponse['toolCalls'] | undefined;
    const rawToolCalls = message?.tool_calls as Array<Record<string, unknown>> | undefined;
    if (rawToolCalls && rawToolCalls.length > 0) {
      toolCalls = rawToolCalls.map((tc) => ({
        id: (tc.id as string) ?? '',
        name: ((tc.function as Record<string, unknown>)?.name as string) ?? '',
        arguments: ((tc.function as Record<string, unknown>)?.arguments as string) ?? '',
      }));
    }

    yield {
      type: 'done',
      content,
      ...(toolCalls ? { toolCalls } : {}),
      ...(usage ? { usage } : {}),
    };
    return;
  }

  // Non-ok response with non-JSON content — try to read body for error info
  if (!response.ok) {
    // Try to read error body
    const bodyText = await response.text();
    await normalizeError(response, bodyText);
  }

  // SSE streaming
  if (!response.body) {
    throw new NetworkError('No response body for streaming request');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  // Accumulated state
  let accumulatedContent = ''; // content-only text from deltas
  let rawBuffer = ''; // raw buffer for SSE parsing
  let processedEventCount = 0;
  const toolCallAccumulator = new Map<
    number,
    { id: string; name: string; argumentsFragments: string[] }
  >();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      rawBuffer += chunk;

      // Parse SSE events from the accumulated text.
      // parseSSEChunk handles partial chunks — we re-parse on each iteration
      // and only process newly completed events.
      const events = parseSSEChunk(rawBuffer);

      // Process only new events
      for (let i = processedEventCount; i < events.length; i++) {
        const event = events[i];

        // [DONE] sentinel
        if (event.data === '[DONE]') {
          // Assemble final toolCalls from accumulated fragments
          let finalToolCalls:
            | Array<{ id: string; name: string; arguments: string }>
            | undefined;

          if (toolCallAccumulator.size > 0) {
            finalToolCalls = Array.from(
              toolCallAccumulator.entries(),
            ).map(([_idx, acc]) => ({
              id: acc.id,
              name: acc.name,
              arguments: acc.argumentsFragments.join(''),
            }));
          }

          yield {
            type: 'done',
            content: accumulatedContent,
            ...(finalToolCalls ? { toolCalls: finalToolCalls } : {}),
          };
          return;
        }

        // Parse the SSE data as JSON
        try {
          const delta = JSON.parse(event.data);
          const choice = delta.choices?.[0];
          if (!choice) continue;

          const deltaObj = choice.delta;
          if (!deltaObj) continue;

          // ---- Text delta ----
          // reasoning_content/thinking intentionally discarded — not accumulated
          if (typeof deltaObj.content === 'string' && deltaObj.content.length > 0) {
            accumulatedContent += deltaObj.content;
            yield { type: 'text', content: deltaObj.content };
          }

          // ---- Tool call delta ----
          if (Array.isArray(deltaObj.tool_calls)) {
            for (const tc of deltaObj.tool_calls as Array<Record<string, unknown>>) {
              const idx = (tc.index as number) ?? 0;

              if (!toolCallAccumulator.has(idx)) {
                toolCallAccumulator.set(idx, {
                  id: (tc.id as string) ?? '',
                  name: '',
                  argumentsFragments: [],
                });
              }

              const acc = toolCallAccumulator.get(idx)!;

              // Update id if provided (typically only in the first delta)
              if (tc.id && typeof tc.id === 'string') {
                acc.id = tc.id;
              }

              // Update function name if provided
              const func = tc.function as Record<string, unknown> | undefined;
              if (func?.name && typeof func.name === 'string') {
                acc.name = func.name;
              }

              // Accumulate arguments fragment
              if (func?.arguments && typeof func.arguments === 'string') {
                acc.argumentsFragments.push(func.arguments);
              }

              yield {
                type: 'tool_call_delta',
                index: idx,
                id: tc.id as string | undefined,
                name: func?.name as string | undefined,
                arguments: (func?.arguments as string) ?? '',
              };
            }
          }
        } catch {
          // Skip malformed SSE data chunks
        }
      }

      processedEventCount = events.length;
    }

    // If the stream ended without [DONE], yield a final done event
    let finalToolCalls:
      | Array<{ id: string; name: string; arguments: string }>
      | undefined;

    if (toolCallAccumulator.size > 0) {
      finalToolCalls = Array.from(toolCallAccumulator.entries()).map(
        ([_idx, acc]) => ({
          id: acc.id,
          name: acc.name,
          arguments: acc.argumentsFragments.join(''),
        }),
      );
    }

    yield {
      type: 'done',
      content: accumulatedContent,
      ...(finalToolCalls ? { toolCalls: finalToolCalls } : {}),
    };
  } finally {
    // Ensure reader is released
    try {
      reader.releaseLock();
    } catch {
      // Already released
    }
  }
}

// =============================================================================
// Main entry point
// =============================================================================

/**
 * Send a chat completion request to an OpenAI-compatible endpoint.
 *
 * @param endpoint - {baseUrl, apiKey} configuration
 * @param request  - {model, messages, tools?, stream?, timeoutMs?, signal?}
 *
 * @returns
 *   - Non-streaming: Promise<ChatCompletionResponse> with {content, toolCalls?, usage}
 *   - Streaming: AsyncIterable<LLMStreamEvent> yielding text/tool_call_delta/done events
 *
 * @throws
 *   - AuthError (401) — non-retryable
 *   - RateLimitError (429) — retryable
 *   - ServerError (5xx) — retryable
 *   - ClientError (other 4xx) — non-retryable
 *   - ToolsNotSupportedError — retryable=false
 *   - TimeoutError — retryable
 *   - NetworkError — retryable
 *   - AbortedError — non-retryable
 */
export async function chatCompletion(
  endpoint: { baseUrl: string; apiKey: string },
  request: ChatCompletionRequest,
): Promise<ChatCompletionResponse | AsyncIterable<LLMStreamEvent>> {
  // Build combined abort signal
  const timeoutMs = request.timeoutMs ?? AGENT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);

  let signal: AbortSignal;
  if (request.signal) {
    signal = AbortSignal.any([timeoutSignal, request.signal]);
  } else {
    signal = timeoutSignal;
  }

  try {
    if (request.stream) {
      const iterable = streamCompletion(endpoint, request, signal);
      return wrapAsyncIterable(iterable, signal, timeoutSignal, request.signal);
    }

    return await nonStreamCompletion(endpoint, request, signal);
  } catch (error: unknown) {
    // If already an LLMError, re-throw as-is
    if (error instanceof LLMError) {
      throw error;
    }

    // Check if the signal was aborted (distinguish timeout vs external)
    if (signal.aborted) {
      if (timeoutSignal.aborted && (!request.signal || !request.signal.aborted)) {
        // Only the timeout fired
        throw new TimeoutError();
      }
      // External signal or both — treat as aborted
      throw new AbortedError();
    }

    // Network/fetch errors
    mapNetworkError(error);
  }
}

/**
 * Wrap an async iterable so that errors during iteration (e.g., fetch abort,
 * network errors) are normalized to LLMError subclasses.
 *
 * For streaming, the fetch happens lazily when the first `next()` is called.
 * Any error (abort, timeout, network) surfaces during iteration and is
 * normalized here.
 */
async function* wrapAsyncIterable(
  source: AsyncIterable<LLMStreamEvent>,
  combinedSignal: AbortSignal,
  timeoutSignal: AbortSignal,
  externalSignal?: AbortSignal,
): AsyncIterable<LLMStreamEvent> {
  try {
    for await (const event of source) {
      yield event;
    }
  } catch (error: unknown) {
    // If already an LLMError, re-throw as-is
    if (error instanceof LLMError) {
      throw error;
    }

    // AbortError (from AbortSignal)
    if (
      error instanceof DOMException ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      if (
        timeoutSignal.aborted &&
        (!externalSignal || !externalSignal.aborted)
      ) {
        throw new TimeoutError();
      }
      throw new AbortedError();
    }

    mapNetworkError(error);
  }
}
