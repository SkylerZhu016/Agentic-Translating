import type { MessageKeyWithoutValues, Translator } from './types'

const DIAGNOSTIC_MESSAGE_KEYS = {
  auth_error: 'diagnostic.auth_error',
  rate_limit: 'diagnostic.rate_limit',
  server_error: 'diagnostic.server_error',
  timeout: 'diagnostic.timeout',
  network: 'diagnostic.network',
  client_error: 'diagnostic.client_error',
  tools_not_supported: 'diagnostic.tools_not_supported',
  aborted: 'diagnostic.aborted',
  incomplete_output: 'diagnostic.incomplete_output',
  unknown: 'diagnostic.unknown',
  stream_cancelled: 'diagnostic.stream_cancelled',
  empty_response: 'diagnostic.empty_response',
  chat_edit_correction_failed: 'diagnostic.chat_edit_correction_failed',
  mixed_tool_batch_not_supported: 'diagnostic.mixed_tool_batch_not_supported',
  chat_loop_exhausted: 'diagnostic.chat_loop_exhausted',
  chat_request_failed: 'diagnostic.chat_request_failed',
  suggestion_failed: 'diagnostic.suggestion_failed',
  session_not_found: 'diagnostic.session_not_found',
  invalid_body: 'diagnostic.invalid_body',
  message_required: 'diagnostic.message_required',
  state_not_ready: 'diagnostic.state_not_ready',
  invalid_snapshot: 'diagnostic.invalid_snapshot',
  no_chat_config: 'diagnostic.no_chat_config',
  chat_already_running: 'diagnostic.chat_already_running',
  final_version_required: 'diagnostic.final_version_required',
  invalid_version_no: 'diagnostic.invalid_version_no',
  version_not_found: 'diagnostic.version_not_found',
  patch_not_found: 'diagnostic.patch_not_found',
  version_conflict: 'diagnostic.version_conflict',
  base_version_not_found: 'diagnostic.base_version_not_found',
  translation_agent_failed: 'diagnostic.translation_agent_failed',
  translation_pipeline_failed: 'diagnostic.translation_pipeline_failed',
  translation_retry_failed: 'diagnostic.translation_retry_failed',
  translation_retry_pipeline_failed:
    'diagnostic.translation_retry_pipeline_failed',
  stage_execution_failed: 'diagnostic.stage_execution_failed',
  legacy_translation_error_redacted:
    'diagnostic.legacy_translation_error_redacted',
  legacy_stage_error_redacted: 'diagnostic.legacy_stage_error_redacted',
} as const satisfies Record<string, MessageKeyWithoutValues>

export type DiagnosticErrorCode = keyof typeof DIAGNOSTIC_MESSAGE_KEYS

function extractDiagnosticCode(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed.startsWith('{')) return trimmed || null
    try {
      return extractDiagnosticCode(JSON.parse(trimmed))
    } catch {
      return trimmed || null
    }
  }
  if (value != null && typeof value === 'object' && 'error' in value) {
    return extractDiagnosticCode((value as { error?: unknown }).error)
  }
  return null
}

export function diagnosticMessageKey(
  value: unknown,
): MessageKeyWithoutValues | null {
  const code = extractDiagnosticCode(value)
  return code != null && code in DIAGNOSTIC_MESSAGE_KEYS
    ? DIAGNOSTIC_MESSAGE_KEYS[code as DiagnosticErrorCode]
    : null
}

export function localizeDiagnosticError(
  t: Translator,
  value: unknown,
  fallback: string,
): string {
  const key = diagnosticMessageKey(value)
  return key ? t(key) : fallback
}
