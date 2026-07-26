// ---------------------------------------------------------------------------
// 扇出编排器 — parallel translation with rate limiting, timeout, retry, and
// partial failure tolerance
//
// Provides:
//   runFanOut(agents, callbacks, llmCall, opts?) → Promise<FanOutSummary>
//
// Wave 2 Task 10 — plan lines 755–812
// ---------------------------------------------------------------------------

import {
  MAX_CONCURRENCY,
  HARD_CONCURRENCY_CAP,
  RETRY_DELAYS_MS,
  AGENT_TIMEOUT_MS,
} from '../constants';
import { writeRunArtifact } from '../storage/run-artifacts';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  LLMStreamEvent,
} from '../llm/client';
import {
  isAsyncIterable,
  LLMError,
  AbortedError,
} from '../llm/client';

// =============================================================================
// Exported types
// =============================================================================

/** Per-agent runtime configuration */
export interface AgentRuntime {
  agentKey: string;
  name: string;
  endpoint: { baseUrl: string; apiKey: string; chatCompletionsPath?: string };
  model: string;
  messages: Array<{ role: string; content: string }>;
  timeoutMs?: number;
}

/** Result for a single agent after fan-out execution */
export interface AgentResult {
  agentKey: string;
  status: 'complete' | 'error' | 'aborted';
  content?: string;
  error?: string;
}

/** Summary of the entire fan-out run */
export interface FanOutSummary {
  results: AgentResult[];
  succeeded: number;
  failed: number;
  durationMs: number;
}

/** Callbacks invoked during agent execution */
export interface FanOutCallbacks {
  onAgentStart?(agentKey: string): void;
  /** Network activity heartbeat; reasoning text is intentionally not exposed. */
  onAgentActivity?(agentKey: string): void;
  onToken?(agentKey: string, content: string): void;
  onAgentComplete?(agentKey: string, result: AgentResult): void;
  onAgentError?(agentKey: string, error: Error): void;
}

/**
 * Concurrency counter hook for testing.
 * Incremented before each LLM call, decremented after.
 */
export interface ConcurrencyCounter {
  current: number;
  peak: number;
}

/** Options for runFanOut */
export interface FanOutOptions {
  /** External abort signal to cancel all in-progress and pending requests */
  signal?: AbortSignal;
  /** Concurrency counter for testing (mutated in-place) */
  concurrencyCounter?: ConcurrencyCounter;
  /** Session ID for writing draft txt artifacts */
  sessionId?: string;
}

/** Retryable error: has a `retryable` property that is true */
export interface RetryableError extends Error {
  retryable: boolean;
}

/** LLM caller signature matching chatCompletion */
export type LLMCaller = (
  endpoint: { baseUrl: string; apiKey: string; chatCompletionsPath?: string },
  request: ChatCompletionRequest,
) => Promise<ChatCompletionResponse | AsyncIterable<LLMStreamEvent>>;

// =============================================================================
// Semaphore
// =============================================================================

class Semaphore {
  private _current = 0;
  private _queue: Array<() => void> = [];

  constructor(private _max: number) {}

  async acquire(): Promise<void> {
    if (this._current < this._max) {
      this._current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this._queue.push(resolve);
    });
  }

  release(): void {
    this._current--;
    const next = this._queue.shift();
    if (next) {
      this._current++;
      next();
    }
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Check if an error is retryable.
 * Uses the LLMError.retryable flag; also handles generic errors conservatively.
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof LLMError) {
    return error.retryable;
  }
  // Generic network/timeout errors — conservatively retryable
  return (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      error.name === 'TimeoutError' ||
      error.message.toLowerCase().includes('network') ||
      error.message.toLowerCase().includes('timeout'))
  );
}

/**
 * Sleep for the given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Single agent runner (with retry)
// =============================================================================

async function runOneAgent(
  agent: AgentRuntime,
  callbacks: FanOutCallbacks,
  llmCall: LLMCaller,
  signal: AbortSignal,
  counter?: ConcurrencyCounter,
  sessionId?: string,
): Promise<AgentResult> {
  const maxRetries = RETRY_DELAYS_MS.length;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Check if already aborted before making the call
    if (signal.aborted) {
      return {
        agentKey: agent.agentKey,
        status: 'aborted',
      };
    }

    try {
      // Track concurrency
      if (counter) {
        counter.current++;
        if (counter.current > counter.peak) {
          counter.peak = counter.current;
        }
      }

      // Build request
      const request: ChatCompletionRequest = {
        model: agent.model,
        messages: agent.messages,
        stream: true,
        timeoutMs: agent.timeoutMs ?? AGENT_TIMEOUT_MS,
        onActivity: () => callbacks.onAgentActivity?.(agent.agentKey),
        signal,
      };

      // Call LLM (streaming)
      const response = await llmCall(agent.endpoint, request);

      // If non-streaming (shouldn't happen with stream:true, but handle gracefully)
      if (!isAsyncIterable(response)) {
        const content = (response as { content: string }).content ?? '';
        const result: AgentResult = {
          agentKey: agent.agentKey,
          status: 'complete',
          content,
        };
        callbacks.onAgentComplete?.(agent.agentKey, result);
        return result;
      }

      // Stream tokens
      let accumulatedContent = '';

      for await (const event of response) {
        if (event.type === 'text') {
          accumulatedContent += event.content;
          callbacks.onToken?.(agent.agentKey, event.content);
        } else if (event.type === 'done') {
          if (event.content && event.content.length > 0) {
            accumulatedContent = event.content;
          }
        }
      }

      // Write draft txt artifact (best-effort)
      if (sessionId) {
        writeRunArtifact(sessionId, `draft-${agent.agentKey}`, accumulatedContent);
      }

      const result: AgentResult = {
        agentKey: agent.agentKey,
        status: 'complete',
        content: accumulatedContent,
      };
      callbacks.onAgentComplete?.(agent.agentKey, result);
      return result;
    } catch (error: unknown) {
      // Check for abort
      if (signal.aborted || error instanceof AbortedError) {
        return {
          agentKey: agent.agentKey,
          status: 'aborted',
          error: 'Request was aborted',
        };
      }

      // Check if retryable and we have retries left
      if (isRetryableError(error) && attempt < maxRetries) {
        const delayMs = RETRY_DELAYS_MS[attempt];
        await sleep(delayMs);
        continue; // retry
      }

      // Non-retryable or out of retries
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      callbacks.onAgentError?.(agent.agentKey, error instanceof Error ? error : new Error(String(error)));

      const result: AgentResult = {
        agentKey: agent.agentKey,
        status: 'error',
        error: errorMessage,
      };
      return result;
    } finally {
      // Track concurrency
      if (counter) {
        counter.current = Math.max(0, counter.current - 1);
      }
    }
  }

  // Should never reach here, but TypeScript requires a return
  return {
    agentKey: agent.agentKey,
    status: 'error',
    error: 'Unexpected: retry loop exhausted',
  };
}

// =============================================================================
// Public API — runFanOut
// =============================================================================

/**
 * Execute multiple translation agents in parallel with concurrency control,
 * retry logic, abort support, and partial failure tolerance.
 *
 * @param agents    Array of agent runtimes to execute
 * @param callbacks Lifecycle callbacks (optional)
 * @param llmCall   Injected LLM caller (defaults to the real chatCompletion)
 * @param opts      Optional signal and concurrency counter hook
 * @returns         FanOutSummary with per-agent results, succeeded/failed counts, and duration
 */
export async function runFanOut(
  agents: AgentRuntime[],
  callbacks: FanOutCallbacks,
  llmCall: LLMCaller,
  opts: FanOutOptions = {},
): Promise<FanOutSummary> {
  const startTime = performance.now();

  // Determine concurrency: min(agents.length, MAX_CONCURRENCY), hard cap HARD_CONCURRENCY_CAP
  const concurrency = Math.min(
    Math.min(agents.length, MAX_CONCURRENCY),
    HARD_CONCURRENCY_CAP,
  );

  const semaphore = new Semaphore(concurrency);
  const signal = opts.signal ?? new AbortController().signal;

  // Launch all agents with semaphore gating
  const promises = agents.map(async (agent): Promise<AgentResult> => {
    // If signal is already aborted, skip immediately
    if (signal.aborted) {
      return {
        agentKey: agent.agentKey,
        status: 'aborted',
        error: 'Request was aborted before start',
      };
    }

    // Wait for concurrency slot
    await semaphore.acquire();

    // If aborted while waiting in queue, release and return aborted
    if (signal.aborted) {
      semaphore.release();
      return {
        agentKey: agent.agentKey,
        status: 'aborted',
        error: 'Request was aborted while queued',
      };
    }

    callbacks.onAgentStart?.(agent.agentKey);

    try {
      const result = await runOneAgent(
        agent,
        callbacks,
        llmCall,
        signal,
        opts.concurrencyCounter,
        opts.sessionId,
      );
      return result;
    } catch {
      // runOneAgent already catches everything; this is a safety net
      callbacks.onAgentError?.(agent.agentKey, new Error('Unexpected failure'));
      return {
        agentKey: agent.agentKey,
        status: 'error',
        error: 'Unexpected failure',
      };
    } finally {
      semaphore.release();
    }
  });

  // Wait for all agents to settle
  const results = await Promise.allSettled(promises);
  const agentResults: AgentResult[] = results.map((r) => {
    if (r.status === 'fulfilled') return r.value;
    // Shouldn't happen with our error handling, but safety net
    return {
      agentKey: 'unknown',
      status: 'error',
      error: r.reason instanceof Error ? r.reason.message : String(r.reason),
    };
  });

  const succeeded = agentResults.filter((r) => r.status === 'complete').length;
  const failed = agentResults.filter(
    (r) => r.status === 'error' || r.status === 'aborted',
  ).length;

  const durationMs = Math.round(performance.now() - startTime);

  return {
    results: agentResults,
    succeeded,
    failed,
    durationMs,
  };
}
