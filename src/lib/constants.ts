// Operational default values for the agentic translating system.
// All thresholds are centralized here — guards and services import values
// rather than hardcoding them.

/**
 * Maximum silence between response chunks for one model request.
 *
 * Reasoning models can legitimately spend several minutes before emitting
 * visible content. Reasoning deltas still refresh this guard when a provider
 * forwards them; the longer idle window also covers providers that buffer
 * those deltas.
 */
export const AGENT_TIMEOUT_MS = 20 * 60_000

/** Absolute safety ceiling for one model call, even while the stream is active. */
export const AGENT_MAX_DURATION_MS = 90 * 60_000

/** Max concurrent translation agents */
export const MAX_CONCURRENCY = 8

/** Hard upper bound for concurrency (never exceeded even if configured higher) */
export const HARD_CONCURRENCY_CAP = 16

/** Retry back-off delays for retryable errors (timeout/5xx/429/empty output) */
export const RETRY_DELAYS_MS = [1000, 3000, 8000] as const

/** Token budget for stage context (C3) */
export const STAGE_CONTEXT_TOKEN_BUDGET = 6000

/** Max allowed source text tokens */
export const SOURCE_TOKEN_LIMIT = 8000

/** Max tool-call loop iterations per chat message (R4) */
export const CHAT_LOOP_MAX = 5

/** Turns of chat context to preserve (oldest dropped) */
export const CHAT_CONTEXT_TURNS = 20
