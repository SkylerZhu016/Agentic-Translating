import {
  DEFAULT_COMPLETION_TOKEN_BUDGET,
  SOURCE_TOKEN_LIMIT,
} from '../constants'

// ─── Custom Errors ──────────────────────────────────────────────

export class SourceTooLongError extends Error {
  readonly code = 'source_too_long' as const
  readonly limit: number
  readonly estimated: number

  constructor(estimated: number, limit: number) {
    super(
      `Source text too long: estimated ${estimated} tokens ` +
      `exceeds limit of ${limit} tokens.`,
    )
    this.name = 'SourceTooLongError'
    this.estimated = estimated
    this.limit = limit
  }
}

export class SourceRequiredError extends Error {
  readonly code = 'source_required' as const

  constructor() {
    super('Source text is required and cannot be empty.')
    this.name = 'SourceRequiredError'
  }
}

// ─── CJR Range Constants ────────────────────────────────────────

// Microsoft's documented CJK Unicode ranges
const CJK_RE = /[\u{4E00}-\u{9FFF}\u{3400}-\u{4DBF}\u{F900}-\u{FAFF}]/gu

// ─── Estimation ─────────────────────────────────────────────────

/**
 * Heuristically estimate the number of tokens in a text string.
 *
 * **This is an estimate, not an exact count.** Use a proper tokenizer
 * (tiktoken, etc.) when precise counts are required.
 *
 * Rules:
 * - CJK characters (Unified Ideographs, Extension A, Compatibility) → 1 token each
 * - All other characters → ≈ chars / 4 (rounded up)
 *
 * @param text - The input text
 * @returns Estimated token count (integer)
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0

  // Count CJK characters
  let cjkCount = 0
  let otherCount = 0

  for (let i = 0; i < text.length; ) {
    const codePoint = text.codePointAt(i)!
    const charLen = codePoint > 0xFFFF ? 2 : 1

    if (
      (codePoint >= 0x4E00 && codePoint <= 0x9FFF) ||
      (codePoint >= 0x3400 && codePoint <= 0x4DBF) ||
      (codePoint >= 0xF900 && codePoint <= 0xFAFF)
    ) {
      cjkCount++
    } else {
      otherCount++
    }

    i += charLen
  }

  return cjkCount + Math.ceil(otherCount / 4)
}

/**
 * Select a provider-compatible output budget without silently trimming input.
 * Unknown endpoints retain the 64K reasoning budget. Configured context
 * windows clamp output to the remaining capacity after a small safety margin.
 */
export function resolveCompletionTokenBudget(
  input: string,
  contextWindow: number | null | undefined,
  requested: number = DEFAULT_COMPLETION_TOKEN_BUDGET,
): number {
  const target = Math.max(1_024, requested)
  if (!contextWindow) return target
  const estimatedInput = estimateTokens(input)
  const available = contextWindow - estimatedInput - 512
  if (available < 1_024) {
    throw new Error(
      `上下文估算为 ${estimatedInput} tokens，端点上限 ${contextWindow}，` +
      '不足以保留最小 1024-token 输出空间；未裁剪任何正文。',
    )
  }
  return Math.min(target, available)
}

// ─── Guards ─────────────────────────────────────────────────────

/**
 * Asserts that the source text does not exceed the token limit.
 *
 * @param text - Source text to check
 * @param limit - Token limit (defaults to SOURCE_TOKEN_LIMIT from constants)
 * @throws {SourceTooLongError} if estimated tokens exceed the limit
 */
export function assertSourceLength(
  text: string,
  limit: number = SOURCE_TOKEN_LIMIT,
): void {
  const estimated = estimateTokens(text)
  if (estimated > limit) {
    throw new SourceTooLongError(estimated, limit)
  }
}

/**
 * Asserts that the source text is non-empty (not blank).
 *
 * @param text - Source text to check
 * @throws {SourceRequiredError} if text is empty or whitespace-only
 */
export function assertSourceNonEmpty(text: string): void {
  if (text.trim().length === 0) {
    throw new SourceRequiredError()
  }
}
