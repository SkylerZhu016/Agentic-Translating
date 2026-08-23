// ---------------------------------------------------------------------------
// LLM Client — OpenAI-compatible chat completion (bare fetch, zero framework)
//
// Provides:
//   chatCompletion(endpoint, request) → ChatCompletionResponse | AsyncIterable<LLMStreamEvent>
//   Error normalization: AuthError, RateLimitError, ServerError, etc.
//   AbortSignal.any merging for timeout + external signal
//   SSE streaming via a bounded incremental line parser
//   Non-stream auto-detection fallback
//   Tool call delta accumulation
//
// Wave 2 Task 8 — spec lines 641-702
// ---------------------------------------------------------------------------

import { AGENT_MAX_DURATION_MS, AGENT_TIMEOUT_MS } from '../constants';
import { resolveChatCompletionsUrl } from './endpoint-url';

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

/** Provider ended generation before a complete answer was produced. */
export class IncompleteOutputError extends LLMError {
  public readonly partialContent: string;
  public readonly providerDiagnostics?: ProviderDiagnostics;

  constructor(
    message?: string,
    partialContent = '',
    providerDiagnostics?: ProviderDiagnostics,
  ) {
    super(
      'incomplete_output',
      message ?? 'LLM response ended before completion',
      { retryable: true },
    );
    this.name = 'IncompleteOutputError';
    this.partialContent = partialContent;
    this.providerDiagnostics = providerDiagnostics;
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
  toolChoice?:
    | 'auto'
    | 'required'
    | 'none'
    | {
        type: 'function';
        function: { name: string };
      };
  stream?: boolean;
  /** Maximum silence between response chunks. This is not a total-duration cap. */
  timeoutMs?: number;
  /** Absolute duration cap for the whole request. */
  maxDurationMs?: number;
  /** Requested visible/reasoning completion budget for compatible providers. */
  maxTokens?: number;
  /** Heartbeat for response activity, including reasoning chunks that are discarded. */
  onActivity?: () => void;
  /**
   * Called immediately before the single compatibility retry that omits
   * stream_options. Exceptions are isolated from the provider request.
   */
  onCompatibilityRetry?: (error: ClientError) => void;
  signal?: AbortSignal;
}

export interface ChatCompletionEndpoint {
  baseUrl: string;
  apiKey: string;
  chatCompletionsPath?: string;
  /** Runtime-only, single-read supplier invoked before every physical fetch. */
  resolveRuntimeEndpoint?: () => {
    baseUrl: string;
    apiKey: string;
    chatCompletionsPath?: string;
  };
}

function resolvePhysicalEndpoint(endpoint: ChatCompletionEndpoint): {
  baseUrl: string;
  apiKey: string;
  chatCompletionsPath?: string;
} {
  if (endpoint.resolveRuntimeEndpoint) return endpoint.resolveRuntimeEndpoint();
  return {
    baseUrl: endpoint.baseUrl,
    chatCompletionsPath: endpoint.chatCompletionsPath,
    apiKey: endpoint.apiKey,
  };
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
  providerDiagnostics?: ProviderDiagnostics;
}

/** Safe shape-only diagnostics. Provider reasoning text is never retained. */
export interface ProviderDiagnostics {
  reasoningFields: Array<'reasoning_content' | 'thinking' | 'reasoning'>;
  reasoningChunks: number;
  reasoningCharacters: number;
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
      /** Whether a stream request used SSE or a provider JSON fallback. */
      transport?: 'sse' | 'json_fallback';
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
      providerDiagnostics?: ProviderDiagnostics;
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

type AbortReason = 'idle_timeout' | 'max_duration' | 'external' | null;

interface RequestGuard {
  signal: AbortSignal;
  reason: () => AbortReason;
  abort: (reason: Exclude<AbortReason, null>) => void;
  touch: () => void;
  cleanup: () => void;
}

function createRequestGuard(
  idleTimeoutMs: number,
  maxDurationMs: number,
  externalSignal?: AbortSignal,
): RequestGuard {
  const controller = new AbortController();
  let abortReason: AbortReason = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;

  const abort = (reason: Exclude<AbortReason, null>) => {
    if (controller.signal.aborted) return;
    abortReason = reason;
    controller.abort();
  };
  const touch = () => {
    if (controller.signal.aborted) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abort('idle_timeout'), idleTimeoutMs);
  };
  const onExternalAbort = () => abort('external');

  if (externalSignal?.aborted) {
    abort('external');
  } else {
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    touch();
    maxTimer = setTimeout(() => abort('max_duration'), maxDurationMs);
  }

  return {
    signal: controller.signal,
    reason: () => abortReason,
    abort,
    touch,
    cleanup: () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (maxTimer) clearTimeout(maxTimer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    },
  };
}

function throwGuardAbort(reason: AbortReason): never {
  if (reason === 'idle_timeout') {
    throw new TimeoutError('LLM request received no activity before the idle timeout');
  }
  if (reason === 'max_duration') {
    throw new TimeoutError('LLM request exceeded the maximum duration');
  }
  throw new AbortedError();
}

async function readResponseText(
  response: Response,
  onActivity: () => void,
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const fragments: string[] = [];
  let characters = 0;
  const append = (fragment: string) => {
    if (fragment.length > MAX_RESPONSE_TEXT_CHARACTERS - characters) {
      throw new ClientError('LLM response exceeded the bounded body limit');
    }
    fragments.push(fragment);
    characters += fragment.length;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity();
      append(decoder.decode(value, { stream: true }));
    }
    append(decoder.decode());
    return fragments.join('');
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released.
    }
  }
}

type CompletionUsage = NonNullable<ChatCompletionResponse['usage']>;
type ReasoningField = ProviderDiagnostics['reasoningFields'][number];

const REASONING_FIELDS: readonly ReasoningField[] = [
  'reasoning_content',
  'thinking',
  'reasoning',
];
const MAX_SSE_PENDING_CHARACTERS = 8 * 1024 * 1024;
const MAX_SSE_EVENTS = 100_000;
const MAX_VISIBLE_CONTENT_CHARACTERS = 8 * 1024 * 1024;
const MAX_RESPONSE_TEXT_CHARACTERS = 8 * 1024 * 1024;
const TERMINAL_USAGE_TAIL_GRACE_MS = 1_000;
const MAX_TERMINAL_USAGE_TAIL_EVENTS = 16;

interface MutableProviderDiagnostics {
  reasoningFields: Set<ReasoningField>;
  reasoningChunks: number;
  reasoningCharacters: number;
}

function createProviderDiagnostics(): MutableProviderDiagnostics {
  return {
    reasoningFields: new Set(),
    reasoningChunks: 0,
    reasoningCharacters: 0,
  };
}

function observeReasoningFields(
  value: unknown,
  diagnostics: MutableProviderDiagnostics,
): void {
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  for (const field of REASONING_FIELDS) {
    const fragment = record[field];
    if (typeof fragment !== 'string' || fragment.length === 0) continue;
    diagnostics.reasoningFields.add(field);
    diagnostics.reasoningChunks += 1;
    diagnostics.reasoningCharacters += fragment.length;
  }
}

function snapshotProviderDiagnostics(
  diagnostics: MutableProviderDiagnostics,
): ProviderDiagnostics | undefined {
  if (diagnostics.reasoningChunks === 0) return undefined;
  return {
    reasoningFields: REASONING_FIELDS.filter((field) =>
      diagnostics.reasoningFields.has(field)),
    reasoningChunks: diagnostics.reasoningChunks,
    reasoningCharacters: diagnostics.reasoningCharacters,
  };
}

function toolCallsAreComplete(
  toolCalls: ChatCompletionResponse['toolCalls'],
): toolCalls is NonNullable<ChatCompletionResponse['toolCalls']> {
  if (!toolCallsHaveCompleteEnvelope(toolCalls)) return false;
  return toolCalls.every((toolCall) => {
    try {
      const args = JSON.parse(toolCall.arguments) as unknown;
      return Boolean(args) && typeof args === 'object' && !Array.isArray(args);
    } catch {
      return false;
    }
  });
}

/**
 * A complete JSON response transports each tool call atomically. Once its
 * required envelope fields are present, malformed argument JSON is a model
 * tool error for the tool loop to report and let the model correct; it is not
 * evidence that the provider response was truncated.
 *
 * The SSE path deliberately keeps using the stricter toolCallsAreComplete
 * check above because an unterminated JSON value there can be evidence that
 * the argument fragments themselves were cut off in transit.
 */
function toolCallsHaveCompleteEnvelope(
  toolCalls: ChatCompletionResponse['toolCalls'],
): toolCalls is NonNullable<ChatCompletionResponse['toolCalls']> {
  if (!toolCalls?.length) return false;
  return toolCalls.every((toolCall) =>
    typeof toolCall.id === 'string' && toolCall.id.length > 0 &&
    typeof toolCall.name === 'string' && toolCall.name.length > 0 &&
    typeof toolCall.arguments === 'string' && toolCall.arguments.length > 0);
}

function extractJsonResponseToolCalls(
  message: Record<string, unknown> | undefined,
  partialContent: string,
  providerDiagnostics?: ProviderDiagnostics,
): ChatCompletionResponse['toolCalls'] | undefined {
  const rawToolCalls = message?.tool_calls;
  if (rawToolCalls === undefined) return undefined;
  if (!Array.isArray(rawToolCalls)) {
    throw new IncompleteOutputError(
      'LLM response contained a non-array tool_calls value',
      partialContent,
      providerDiagnostics,
    );
  }
  if (rawToolCalls.length === 0) return undefined;
  return rawToolCalls.map((value) => {
    const toolCall = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
    const rawFunction = toolCall?.function;
    const fn = rawFunction && typeof rawFunction === 'object' && !Array.isArray(rawFunction)
      ? rawFunction as Record<string, unknown>
      : undefined;
    return {
      id: typeof toolCall?.id === 'string' ? toolCall.id : '',
      name: typeof fn?.name === 'string' ? fn.name : '',
      arguments: typeof fn?.arguments === 'string' ? fn.arguments : '',
    };
  });
}

function assertSuccessfulFinishReason(
  finishReason: unknown,
  partialContent: string,
  providerDiagnostics?: ProviderDiagnostics,
  hasCompleteToolCalls = false,
): void {
  if (finishReason === 'stop') return;
  if (finishReason === 'tool_calls' && hasCompleteToolCalls) return;
  if (finishReason === 'length') {
    throw new IncompleteOutputError(
      'LLM response was truncated because the completion token limit was reached',
      partialContent,
      providerDiagnostics,
    );
  }
  if (finishReason === 'tool_calls') {
    throw new IncompleteOutputError(
      'LLM response ended with incomplete tool calls',
      partialContent,
      providerDiagnostics,
    );
  }
  const label = typeof finishReason === 'string'
    ? JSON.stringify(finishReason)
    : 'a missing finish_reason';
  throw new IncompleteOutputError(
    `LLM response ended with non-success finish_reason ${label}`,
    partialContent,
    providerDiagnostics,
  );
}

function emptyVisibleContentMessage(
  providerDiagnostics: ProviderDiagnostics | undefined,
  usage: CompletionUsage | undefined,
): string {
  if (providerDiagnostics) {
    return 'LLM response completed with reasoning but no visible content';
  }
  if (usage) return 'LLM response completed with usage but no visible content';
  return 'LLM response completed without visible content';
}

function isSafeTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseCompletionUsage(value: unknown): CompletionUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as Record<string, unknown>;
  const promptTokens = usage.prompt_tokens;
  const completionTokens = usage.completion_tokens;
  if (
    !isSafeTokenCount(promptTokens) ||
    !isSafeTokenCount(completionTokens)
  ) {
    return undefined;
  }
  if (promptTokens > Number.MAX_SAFE_INTEGER - completionTokens) {
    return undefined;
  }
  const computedTotal = promptTokens + completionTokens;
  const explicitTotal = usage.total_tokens;
  let totalTokens = computedTotal;
  if (explicitTotal !== undefined) {
    if (!isSafeTokenCount(explicitTotal) || explicitTotal !== computedTotal) {
      return undefined;
    }
    totalTokens = explicitTotal;
  }
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

function isUnsupportedStreamOptionsResponse(
  response: Response,
  bodyText: string,
): boolean {
  if (response.status !== 400 && response.status !== 422) return false;

  const detail = bodyText.toLowerCase().replace(/\s+/g, ' ');
  const namesStreamOptions =
    detail.includes('stream_options') ||
    detail.includes('stream options') ||
    detail.includes('include_usage');
  if (!namesStreamOptions) return false;

  return [
    'not supported',
    'unsupported',
    'unknown',
    'unrecognized',
    'unrecognised',
    'unexpected',
    'not permitted',
    'not allowed',
    'extra_forbidden',
    'extra inputs',
    'additional properties',
    'invalid parameter',
  ].some((marker) => detail.includes(marker));
}

function createCompatibilityRetryError(
  response: Response,
  bodyText: string,
): ClientError {
  let message = `LLM request failed with status ${response.status}`;
  try {
    const body = JSON.parse(bodyText) as OpenAIErrorBody;
    message = body.error?.message ?? message;
  } catch {
    if (bodyText) message = bodyText;
  }
  return new ClientError(message, response.status);
}

interface StreamFetchResult {
  response: Response;
  /** Present when a rejected response had to be inspected for compatibility. */
  bodyText?: string;
}

async function fetchStreamResponse(
  endpoint: ChatCompletionEndpoint,
  request: ChatCompletionRequest,
  signal: AbortSignal,
  onActivity: () => void,
): Promise<StreamFetchResult> {
  const fetchOnce = async (includeUsage: boolean): Promise<Response> => {
    const physicalEndpoint = resolvePhysicalEndpoint(endpoint);
    const response = await fetch(resolveChatCompletionsUrl(physicalEndpoint), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${physicalEndpoint.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        ...(request.tools ? { tools: request.tools } : {}),
        ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
        ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
        stream: true,
        ...(includeUsage
          ? { stream_options: { include_usage: true } }
          : {}),
      }),
      signal,
    });
    onActivity();
    return response;
  };

  const response = await fetchOnce(true);
  if (response.ok) return { response };

  const bodyText = await readResponseText(response, onActivity);
  if (!isUnsupportedStreamOptionsResponse(response, bodyText)) {
    return { response, bodyText };
  }

  // A rejected request cannot have produced a successful completion. Retry at
  // most once, and only after the endpoint explicitly rejects stream_options.
  try {
    request.onCompatibilityRetry?.(
      createCompatibilityRetryError(response, bodyText),
    );
  } catch {
    // Accounting/telemetry callbacks must not alter provider behavior.
  }
  return { response: await fetchOnce(false) };
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

function isRuntimeCredentialError(error: unknown): error is Error {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'runtime_endpoint_deleted' ||
    code === 'runtime_endpoint_disabled' ||
    code === 'runtime_endpoint_key_unavailable' ||
    code === 'runtime_endpoint_address_invalid';
}

// =============================================================================
// Non-streaming request
// =============================================================================

async function nonStreamCompletion(
  endpoint: ChatCompletionEndpoint,
  request: ChatCompletionRequest,
  signal: AbortSignal,
  onActivity: () => void,
): Promise<ChatCompletionResponse> {
  const physicalEndpoint = resolvePhysicalEndpoint(endpoint);
  const response = await fetch(resolveChatCompletionsUrl(physicalEndpoint), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${physicalEndpoint.apiKey}`,
    },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      ...(request.tools ? { tools: request.tools } : {}),
      ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
      ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
      stream: false,
    }),
    signal,
  });

  onActivity();
  const bodyText = await readResponseText(response, onActivity);

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
  const mutableDiagnostics = createProviderDiagnostics();
  observeReasoningFields(message, mutableDiagnostics);
  const providerDiagnostics = snapshotProviderDiagnostics(mutableDiagnostics);
  const content = (message?.content as string) ?? '';

  const toolCalls = extractJsonResponseToolCalls(
    message,
    content,
    providerDiagnostics,
  );

  const hasCompleteToolCalls = toolCallsHaveCompleteEnvelope(toolCalls);
  if (toolCalls && !hasCompleteToolCalls) {
    throw new IncompleteOutputError(
      'LLM response contained incomplete tool calls',
      content,
      providerDiagnostics,
    );
  }
  assertSuccessfulFinishReason(
    choice?.finish_reason,
    content,
    providerDiagnostics,
    hasCompleteToolCalls,
  );

  // Extract usage before classifying a terminal empty response so the error
  // remains specific even when the provider emitted no reasoning field.
  const usage = parseCompletionUsage(body.usage);
  if (!content && !hasCompleteToolCalls) {
    throw new IncompleteOutputError(
      emptyVisibleContentMessage(providerDiagnostics, usage),
      '',
      providerDiagnostics,
    );
  }

  return {
    content,
    ...(toolCalls ? { toolCalls } : {}),
    ...(usage ? { usage } : {}),
    ...(providerDiagnostics ? { providerDiagnostics } : {}),
  };
}

// =============================================================================
// Streaming request (async generator)
// =============================================================================

async function* streamCompletion(
  endpoint: ChatCompletionEndpoint,
  request: ChatCompletionRequest,
  signal: AbortSignal,
  onActivity: () => void,
): AsyncIterable<LLMStreamEvent> {
  const {
    response,
    bodyText: inspectedErrorBody,
  } = await fetchStreamResponse(endpoint, request, signal, onActivity);

  // Check for non-stream fallback: server returned JSON instead of SSE
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const bodyText =
      inspectedErrorBody ?? await readResponseText(response, onActivity);

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
    const mutableDiagnostics = createProviderDiagnostics();
    observeReasoningFields(message, mutableDiagnostics);
    const providerDiagnostics = snapshotProviderDiagnostics(mutableDiagnostics);
    const content = (message?.content as string) ?? '';

    // Extract usage
    const usage = parseCompletionUsage(body.usage);

    const toolCalls = extractJsonResponseToolCalls(
      message,
      content,
      providerDiagnostics,
    );

    const hasCompleteToolCalls = toolCallsHaveCompleteEnvelope(toolCalls);
    if (toolCalls && !hasCompleteToolCalls) {
      throw new IncompleteOutputError(
        'LLM response contained incomplete tool calls',
        content,
        providerDiagnostics,
      );
    }
    assertSuccessfulFinishReason(
      choice?.finish_reason,
      content,
      providerDiagnostics,
      hasCompleteToolCalls,
    );
    if (!content && !hasCompleteToolCalls) {
      throw new IncompleteOutputError(
        emptyVisibleContentMessage(providerDiagnostics, usage),
        '',
        providerDiagnostics,
      );
    }

    if (content) yield { type: 'text', content };

    yield {
      type: 'done',
      content,
      transport: 'json_fallback',
      ...(toolCalls ? { toolCalls } : {}),
      ...(usage ? { usage } : {}),
      ...(providerDiagnostics ? { providerDiagnostics } : {}),
    };
    return;
  }

  // Non-ok response with non-JSON content — try to read body for error info
  if (!response.ok) {
    // Try to read error body
    const bodyText =
      inspectedErrorBody ?? await readResponseText(response, onActivity);
    await normalizeError(response, bodyText);
  }

  // SSE streaming
  if (!response.body) {
    throw new NetworkError('No response body for streaming request');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  // Accumulated state
  const contentFragments: string[] = []; // visible content only
  let visibleContentCharacters = 0;
  const pendingLineFragments: string[] = [];
  let pendingLineCharacters = 0;
  let eventDataLines: string[] = [];
  let eventDataCharacters = 0;
  let parsedEventCount = 0;
  let cleanEofCandidate: 'aggregate_message' | 'final_usage' | null = null;
  let completedNaturally = false;
  let accumulatedUsage: CompletionUsage | undefined;
  const mutableDiagnostics = createProviderDiagnostics();
  const toolCallAccumulator = new Map<
    number,
    { id: string; name: string; argumentsFragments: string[] }
  >();
  const content = () => contentFragments.join('');
  const diagnostics = () => snapshotProviderDiagnostics(mutableDiagnostics);
  const appendVisibleContent = (fragment: string) => {
    if (
      fragment.length > MAX_VISIBLE_CONTENT_CHARACTERS - visibleContentCharacters
    ) {
      throw new IncompleteOutputError(
        'LLM visible content exceeded the bounded stream limit',
        content(),
        diagnostics(),
      );
    }
    contentFragments.push(fragment);
    visibleContentCharacters += fragment.length;
  };
  const dataIsComplete = (data: string): boolean => {
    if (data.trim() === '[DONE]') return true;
    try {
      JSON.parse(data);
      return true;
    } catch {
      return false;
    }
  };
  const dataHasExplicitFinishReason = (data: string): boolean => {
    try {
      const value = JSON.parse(data) as {
        choices?: Array<{ finish_reason?: unknown }>;
      };
      const finishReason = value.choices?.[0]?.finish_reason;
      return finishReason !== null && finishReason !== undefined;
    } catch {
      return false;
    }
  };
  function* flushDataEvent(): Generator<string> {
    if (!eventDataLines.length) return;
    const lines = eventDataLines;
    eventDataLines = [];
    eventDataCharacters = 0;
    const joined = lines.join('\n');
    if (dataIsComplete(joined)) {
      yield joined;
      return;
    }
    // NewAPI may omit blank SSE separators while still sending one complete
    // JSON payload per data line. Standard multiline data remains joined.
    if (lines.length > 1 && lines.every(dataIsComplete)) {
      for (const data of lines) yield data;
      return;
    }
    throw new IncompleteOutputError(
      'LLM SSE contained malformed or truncated JSON data',
      content(),
      diagnostics(),
    );
  }
  function* consumeLine(input: string): Generator<string> {
    const line = input.endsWith('\r') ? input.slice(0, -1) : input;
    if (line === '') {
      yield* flushDataEvent();
      return;
    }
    if (line.startsWith(':')) return;
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).replace(/^ /, '');
    if (data.trim() === '[DONE]') {
      yield* flushDataEvent();
      yield '[DONE]';
      return;
    }
    if (eventDataLines.length === 1 && dataIsComplete(eventDataLines[0])) {
      yield* flushDataEvent();
    }
    if (data.length > MAX_SSE_PENDING_CHARACTERS - eventDataCharacters) {
      throw new IncompleteOutputError(
        'LLM SSE event exceeded the bounded parser buffer',
        content(),
        diagnostics(),
      );
    }
    eventDataLines.push(data);
    eventDataCharacters += data.length;
    if (dataHasExplicitFinishReason(data)) yield* flushDataEvent();
  }
  const appendPendingLine = (fragment: string) => {
    if (!fragment) return;
    if (fragment.length > MAX_SSE_PENDING_CHARACTERS - pendingLineCharacters) {
      throw new IncompleteOutputError(
        'LLM SSE line exceeded the bounded parser buffer',
        content(),
        diagnostics(),
      );
    }
    pendingLineFragments.push(fragment);
    pendingLineCharacters += fragment.length;
  };
  function* consumeDecodedText(chunk: string): Generator<string> {
    let start = 0;
    while (true) {
      const boundary = chunk.indexOf('\n', start);
      if (boundary < 0) break;
      appendPendingLine(chunk.slice(start, boundary));
      const line = pendingLineFragments.join('');
      pendingLineFragments.length = 0;
      pendingLineCharacters = 0;
      yield* consumeLine(line);
      start = boundary + 1;
    }
    appendPendingLine(chunk.slice(start));
  }
  function* flushEof(): Generator<string> {
    if (pendingLineCharacters) {
      const line = pendingLineFragments.join('');
      pendingLineFragments.length = 0;
      pendingLineCharacters = 0;
      yield* consumeLine(line);
    }
    yield* flushDataEvent();
  }
  const finalToolCalls = () => (
    toolCallAccumulator.size > 0
      ? Array.from(toolCallAccumulator.entries()).map(([_idx, acc]) => ({
          id: acc.id,
          name: acc.name,
          arguments: acc.argumentsFragments.join(''),
        }))
      : undefined
  );
  const completionSnapshot = () => {
    const finalContent = content();
    const providerDiagnostics = diagnostics();
    const toolCalls = finalToolCalls();
    const hasCompleteToolCalls = toolCallsAreComplete(toolCalls);
    if (toolCalls && !hasCompleteToolCalls) {
      throw new IncompleteOutputError(
        'LLM stream contained incomplete tool calls',
        finalContent,
        providerDiagnostics,
      );
    }
    if (!finalContent && !hasCompleteToolCalls) {
      throw new IncompleteOutputError(
        emptyVisibleContentMessage(providerDiagnostics, accumulatedUsage),
        '',
        providerDiagnostics,
      );
    }
    return {
      finalContent,
      providerDiagnostics,
      toolCalls,
      hasCompleteToolCalls,
    };
  };
  const doneEvent = (
    snapshot: ReturnType<typeof completionSnapshot>,
  ): Extract<LLMStreamEvent, { type: 'done' }> => ({
    type: 'done',
    content: snapshot.finalContent,
    transport: 'sse',
    ...(snapshot.toolCalls ? { toolCalls: snapshot.toolCalls } : {}),
    ...(accumulatedUsage ? { usage: accumulatedUsage } : {}),
    ...(snapshot.providerDiagnostics
      ? { providerDiagnostics: snapshot.providerDiagnostics }
      : {}),
  });
  const reconcileAggregateContent = (aggregate: string): string => {
    const current = content();
    if (aggregate === current) return '';
    if (aggregate.startsWith(current)) {
      const suffix = aggregate.slice(current.length);
      appendVisibleContent(suffix);
      return suffix;
    }
    throw new IncompleteOutputError(
      'LLM aggregate message did not match the streamed visible content',
      current,
      diagnostics(),
    );
  };
  const cancelAfterTerminal = async () => {
    try {
      await reader.cancel('SSE terminal event received');
    } catch {
      // A parsed terminal event remains authoritative if cancellation races EOF.
    }
  };
  function* eventsForRead(chunk: string, done: boolean): Generator<string> {
    if (chunk) yield* consumeDecodedText(chunk);
    if (done) yield* flushEof();
  }
  const consumeTerminalUsageEvent = (eventData: string): boolean => {
    if (eventData === '[DONE]') return true;
    let payload: { usage?: unknown; choices?: unknown };
    try {
      payload = JSON.parse(eventData) as typeof payload;
    } catch {
      return true;
    }
    if (!Array.isArray(payload.choices) || payload.choices.length !== 0) {
      return true;
    }
    const usage = parseCompletionUsage(payload.usage);
    if (!usage) return true;
    accumulatedUsage = usage;
    return true;
  };
  const readTerminalTail = async (
    timeoutMs: number,
  ): Promise<ReadableStreamReadResult<Uint8Array> | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const collectTerminalUsageTail = async (): Promise<void> => {
    const deadline = Date.now() + TERMINAL_USAGE_TAIL_GRACE_MS;
    let tailEvents = 0;
    while (tailEvents < MAX_TERMINAL_USAGE_TAIL_EVENTS) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return;
      let readResult: ReadableStreamReadResult<Uint8Array> | null;
      try {
        readResult = await readTerminalTail(remainingMs);
      } catch {
        return;
      }
      if (!readResult) return;
      const chunk = readResult.done
        ? decoder.decode()
        : decoder.decode(readResult.value, { stream: true });
      if (chunk.length > MAX_SSE_PENDING_CHARACTERS) return;
      let iterator: Generator<string>;
      try {
        iterator = eventsForRead(chunk, readResult.done);
        while (tailEvents < MAX_TERMINAL_USAGE_TAIL_EVENTS) {
          const next = iterator.next();
          if (next.done) break;
          tailEvents += 1;
          if (parsedEventCount >= MAX_SSE_EVENTS) return;
          parsedEventCount += 1;
          if (consumeTerminalUsageEvent(next.value)) return;
        }
      } catch {
        return;
      }
      if (readResult.done) return;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      const chunk = done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      if (!done) onActivity();

      let authoritativeSnapshot:
        | ReturnType<typeof completionSnapshot>
        | undefined;
      let terminalTailSettled = false;
      const dataIterator = eventsForRead(chunk, done);
      while (true) {
        let next: IteratorResult<string>;
        try {
          next = dataIterator.next();
        } catch (error) {
          if (authoritativeSnapshot) {
            terminalTailSettled = true;
            break;
          }
          throw error;
        }
        if (next.done) break;
        const eventData = next.value;

        if (authoritativeSnapshot) {
          if (parsedEventCount >= MAX_SSE_EVENTS) {
            terminalTailSettled = true;
            break;
          }
          parsedEventCount += 1;
          terminalTailSettled = consumeTerminalUsageEvent(eventData);
          if (terminalTailSettled) break;
          continue;
        }

        parsedEventCount += 1;
        if (parsedEventCount > MAX_SSE_EVENTS) {
          throw new IncompleteOutputError(
            'LLM SSE stream exceeded the bounded event limit',
            content(),
            diagnostics(),
          );
        }

        // [DONE] sentinel
        if (eventData === '[DONE]') {
          const snapshot = completionSnapshot();
          completedNaturally = true;
          await cancelAfterTerminal();
          yield doneEvent(snapshot);
          return;
        }

        // Parse the SSE data as JSON
        let payload: {
          usage?: unknown;
          choices?: Array<{
            finish_reason?: unknown;
            delta?: Record<string, unknown>;
            message?: Record<string, unknown>;
          }>;
        };
        try {
          payload = JSON.parse(eventData) as typeof payload;
        } catch {
          throw new IncompleteOutputError(
            'LLM SSE contained malformed JSON data',
            content(),
            diagnostics(),
          );
        }
        const usage = parseCompletionUsage(payload.usage);
        if (usage) accumulatedUsage = usage;

        const choice = payload.choices?.[0];
        if (!choice) {
          cleanEofCandidate = usage && visibleContentCharacters > 0
            ? 'final_usage'
            : null;
          continue;
        }

        const deltaObj = choice.delta;
        const aggregateMessage = choice.message;
        const hasDeltaObject = Boolean(
          deltaObj && typeof deltaObj === 'object' && !Array.isArray(deltaObj),
        );
        observeReasoningFields(deltaObj, mutableDiagnostics);
        observeReasoningFields(aggregateMessage, mutableDiagnostics);

        // ---- Text delta ----
        if (typeof deltaObj?.content === 'string' && deltaObj.content.length > 0) {
          appendVisibleContent(deltaObj.content);
          yield { type: 'text', content: deltaObj.content };
        }

        // ---- Aggregate message ----
        let hasAggregateEvidence = false;
        if (
          typeof aggregateMessage?.content === 'string' &&
          aggregateMessage.content.length > 0
        ) {
          const suffix = reconcileAggregateContent(aggregateMessage.content);
          if (suffix) yield { type: 'text', content: suffix };
          hasAggregateEvidence = true;
        }

        // ---- Tool call delta ----
        if (Array.isArray(deltaObj?.tool_calls)) {
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
            if (tc.id && typeof tc.id === 'string') acc.id = tc.id;

            const func = tc.function as Record<string, unknown> | undefined;
            if (func?.name && typeof func.name === 'string') acc.name = func.name;
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

        if (typeof choice.finish_reason === 'string') {
          const providerDiagnostics = diagnostics();
          const toolCalls = finalToolCalls();
          assertSuccessfulFinishReason(
            choice.finish_reason,
            content(),
            providerDiagnostics,
            toolCallsAreComplete(toolCalls),
          );
          authoritativeSnapshot = completionSnapshot();
          continue;
        }
        if (
          choice.finish_reason !== null && choice.finish_reason !== undefined
        ) {
          assertSuccessfulFinishReason(
            undefined,
            content(),
            diagnostics(),
            toolCallsAreComplete(finalToolCalls()),
          );
        }

        cleanEofCandidate = hasAggregateEvidence
          ? 'aggregate_message'
          : usage && !hasDeltaObject && visibleContentCharacters > 0
            ? 'final_usage'
            : null;
      }
      if (authoritativeSnapshot) {
        if (!terminalTailSettled) await collectTerminalUsageTail();
        completedNaturally = true;
        await cancelAfterTerminal();
        yield doneEvent(authoritativeSnapshot);
        return;
      }
      if (done) break;
    }

    if (!cleanEofCandidate) {
      throw new IncompleteOutputError(
        'LLM stream closed without a completion marker',
        content(),
        diagnostics(),
      );
    }
    const snapshot = completionSnapshot();
    assertSuccessfulFinishReason(
      'stop',
      snapshot.finalContent,
      snapshot.providerDiagnostics,
      snapshot.hasCompleteToolCalls,
    );

    completedNaturally = true;
    yield doneEvent(snapshot);
  } catch (error: unknown) {
    // A socket/proxy interruption after visible deltas must not erase the
    // partial provider output. Guard-triggered aborts retain their timeout or
    // cancellation identity; their consumer already holds the yielded text.
    if (
      visibleContentCharacters > 0 &&
      !signal.aborted &&
      !(error instanceof IncompleteOutputError)
    ) {
      throw new IncompleteOutputError(
        'LLM stream was interrupted before a completion marker',
        content(),
        diagnostics(),
      );
    }
    throw error;
  } finally {
    // An early consumer return must tear down the upstream response, not just
    // release our local lock and leave the provider generating in background.
    if (!completedNaturally) {
      try {
        await reader.cancel();
      } catch {
        // Fetch may already have been aborted by the request guard.
      }
    }
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
  endpoint: ChatCompletionEndpoint,
  request: ChatCompletionRequest,
): Promise<ChatCompletionResponse | AsyncIterable<LLMStreamEvent>> {
  // Callers may shorten either guard, but cannot extend a physical request
  // beyond the product-wide fifteen-minute upstream ceiling.
  const idleTimeoutMs = Math.min(
    request.timeoutMs ?? AGENT_TIMEOUT_MS,
    AGENT_MAX_DURATION_MS,
  );
  const maxDurationMs = Math.min(
    request.maxDurationMs ?? AGENT_MAX_DURATION_MS,
    AGENT_MAX_DURATION_MS,
  );
  const guard = createRequestGuard(
    idleTimeoutMs,
    maxDurationMs,
    request.signal,
  );
  const onActivity = () => {
    guard.touch();
    request.onActivity?.();
  };

  try {
    if (request.stream) {
      const iterable = streamCompletion(
        endpoint,
        request,
        guard.signal,
        onActivity,
      );
      return wrapAsyncIterable(iterable, guard);
    }

    return await nonStreamCompletion(
      endpoint,
      request,
      guard.signal,
      onActivity,
    );
  } catch (error: unknown) {
    // An explicit cancellation wins races with provider/network failures. Some
    // fetch implementations surface a concurrent abort as a generic fetch
    // error (and a downstream helper may already have normalized that error),
    // but callers still need the stable external-abort contract.
    if (guard.signal.aborted) throwGuardAbort(guard.reason());

    if (isRuntimeCredentialError(error)) throw error;

    // If already an LLMError, re-throw as-is
    if (error instanceof LLMError) {
      throw error;
    }

    // Network/fetch errors
    return mapNetworkError(error);
  } finally {
    if (!request.stream) guard.cleanup();
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
function normalizeStreamIterationError(
  error: unknown,
  guard: RequestGuard,
): never {
  // Check the request guard before preserving an existing LLMError. A stream
  // abort can race with a provider socket failure that was already mapped to
  // NetworkError; the externally visible result must remain AbortedError.
  if (guard.signal.aborted) throwGuardAbort(guard.reason());
  if (isRuntimeCredentialError(error)) throw error;
  if (error instanceof LLMError) throw error;

  if (
    error instanceof DOMException ||
    (error instanceof Error && error.name === 'AbortError')
  ) {
    throw new AbortedError();
  }

  mapNetworkError(error);
}

function wrapAsyncIterable(
  source: AsyncIterable<LLMStreamEvent>,
  guard: RequestGuard,
): AsyncIterable<LLMStreamEvent> {
  const sourceIterator = source[Symbol.asyncIterator]();
  let closed = false;
  let terminalEventSeen = false;
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    guard.cleanup();
  };
  const doneResult = (value?: unknown): IteratorResult<LLMStreamEvent> => ({
    done: true,
    value,
  });

  const wrapped: AsyncIterableIterator<LLMStreamEvent> = {
    async next(): Promise<IteratorResult<LLMStreamEvent>> {
      if (closed) return doneResult();
      try {
        const result = await sourceIterator.next();
        if (result.done) {
          closed = true;
          cleanup();
        } else if (result.value.type === 'done') {
          terminalEventSeen = true;
          cleanup();
        }
        return result;
      } catch (error: unknown) {
        closed = true;
        cleanup();
        normalizeStreamIterationError(error, guard);
      }
    },

    async return(value?: unknown): Promise<IteratorResult<LLMStreamEvent>> {
      const cancelledEarly = !closed && !terminalEventSeen;
      closed = true;
      if (cancelledEarly) {
        // Abort immediately, including when a read/fetch is currently pending.
        // The source generator's finally block also cancels its reader.
        guard.abort('external');
      }
      try {
        if (sourceIterator.return) {
          return await sourceIterator.return(value);
        }
        return doneResult(value);
      } catch (error: unknown) {
        // Cancellation is a successful iterator close operation. Abort errors
        // caused by that close belong to the pending next(), not return().
        if (cancelledEarly) return doneResult(value);
        normalizeStreamIterationError(error, guard);
      } finally {
        cleanup();
      }
    },

    async throw(error?: unknown): Promise<IteratorResult<LLMStreamEvent>> {
      const cancelledEarly = !closed && !terminalEventSeen;
      closed = true;
      if (cancelledEarly) guard.abort('external');
      try {
        if (sourceIterator.throw) {
          return await sourceIterator.throw(error);
        }
        if (sourceIterator.return) await sourceIterator.return();
        throw error;
      } finally {
        cleanup();
      }
    },

    [Symbol.asyncIterator]() {
      return this;
    },
  };

  return wrapped;
}
