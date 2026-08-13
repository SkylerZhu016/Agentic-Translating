import { createHash } from 'crypto'

export interface PublicDiagnosticErrorDto {
  error: string
  diagnosticId: string
}

/**
 * Creates a public error object without inspecting or serializing the cause.
 * Provider messages can contain credentials, URLs, prompts, or response text,
 * so callers keep the opaque diagnostic ID as the only correlation data.
 */
export function publicDiagnosticError(
  error: string,
): PublicDiagnosticErrorDto {
  return {
    error,
    diagnosticId: crypto.randomUUID(),
  }
}

const SAFE_DIAGNOSTIC_ERROR_CODES = new Set([
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
  'chat_edit_correction_failed',
  'mixed_tool_batch_not_supported',
  'chat_loop_exhausted',
  'chat_request_failed',
  'suggestion_failed',
  'translation_agent_failed',
  'translation_pipeline_failed',
  'translation_retry_failed',
  'translation_retry_pipeline_failed',
  'stage_execution_failed',
])

const EXECUTION_ERROR_MESSAGES = {
  translation_agent_failed: '翻译 Agent 调用失败，请稍后重试。',
  translation_pipeline_failed: '翻译流程执行失败，请稍后重试。',
  translation_retry_failed: '翻译 Agent 重试失败，请稍后重试。',
  translation_retry_pipeline_failed: '翻译重试流程执行失败，请稍后重试。',
  stage_execution_failed: '统筹阶段执行失败，请稍后重试。',
  legacy_translation_error_redacted: '该历史翻译错误的原始详情已隐藏。',
  legacy_stage_error_redacted: '该历史统筹错误的原始详情已隐藏。',
} as const

export type ExecutionDiagnosticErrorCode =
  keyof typeof EXECUTION_ERROR_MESSAGES

export interface ExecutionDiagnosticErrorDto
  extends PublicDiagnosticErrorDto {
  error: ExecutionDiagnosticErrorCode
  message: string
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function executionDiagnosticError(
  error: Exclude<
    ExecutionDiagnosticErrorCode,
    'legacy_translation_error_redacted' | 'legacy_stage_error_redacted'
  >,
): ExecutionDiagnosticErrorDto {
  return {
    ...publicDiagnosticError(error),
    error,
    message: EXECUTION_ERROR_MESSAGES[error],
  }
}

/** Persist only the controlled public fields, never the provider exception. */
export function serializeExecutionDiagnosticError(
  diagnostic: ExecutionDiagnosticErrorDto,
): string {
  return JSON.stringify({
    error: diagnostic.error,
    message: diagnostic.message,
    diagnosticId: diagnostic.diagnosticId,
  })
}

function deterministicDiagnosticId(seed: string): string {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}

/**
 * Turn a stored execution error into a safe public DTO. New rows contain the
 * controlled JSON envelope. Historical rows are left untouched in SQLite but
 * their raw text is replaced at the public boundary with a stable diagnostic.
 */
export function publicPersistedExecutionError(
  storedError: string | null,
  kind: 'translation' | 'stage',
  stableSeed: string,
): ExecutionDiagnosticErrorDto | null {
  if (!storedError) return null
  try {
    const parsed = JSON.parse(storedError) as Record<string, unknown>
    const code = parsed.error
    if (
      typeof code === 'string' &&
      code in EXECUTION_ERROR_MESSAGES &&
      parsed.message ===
        EXECUTION_ERROR_MESSAGES[code as ExecutionDiagnosticErrorCode] &&
      typeof parsed.diagnosticId === 'string' &&
      UUID_PATTERN.test(parsed.diagnosticId)
    ) {
      return {
        error: code as ExecutionDiagnosticErrorCode,
        message: parsed.message as string,
        diagnosticId: parsed.diagnosticId,
      }
    }
  } catch {
    // Legacy errors were unstructured provider text. Never return that text.
  }

  const error =
    kind === 'translation'
      ? 'legacy_translation_error_redacted'
      : 'legacy_stage_error_redacted'
  return {
    error,
    message: EXECUTION_ERROR_MESSAGES[error],
    diagnosticId: deterministicDiagnosticId(`${kind}:${stableSeed}`),
  }
}

function controlledCauseCode(cause: unknown): string {
  const candidate =
    cause != null && typeof cause === 'object' && 'code' in cause
      ? (cause as { code?: unknown }).code
      : null
  return typeof candidate === 'string' && SAFE_DIAGNOSTIC_ERROR_CODES.has(candidate)
    ? candidate
    : 'unexpected_error'
}

/**
 * Emit correlation metadata without serializing the provider exception.
 * Provider messages may contain keys, URLs, prompts, or generated text, so
 * even server diagnostics keep only a controlled code and opaque ID.
 */
export function logSafeDiagnostic(input: {
  scope: string
  diagnosticId: string
  cause: unknown
}): void {
  console.error('[agentic-diagnostic]', {
    scope: input.scope,
    diagnosticId: input.diagnosticId,
    errorCode: controlledCauseCode(input.cause),
  })
}
