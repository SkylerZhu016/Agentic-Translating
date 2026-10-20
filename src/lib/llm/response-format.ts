import { semanticOutputFormatForPrompt } from '../protocol/semantic-output'

// Confirmed by DeepSeek's Chat Completions and JSON Output documentation.
// Keep this list explicit: a compatible API or a similar model name does not
// establish that its provider accepts response_format.
const DEEPSEEK_JSON_MODELS = new Set(['deepseek-flash', 'deepseek-v4-pro'])
const DEEPSEEK_CHAT_PATHS = new Set(['/chat/completions', '/v1/chat/completions'])

interface ResponseFormatRequest {
  model: string
  messages: ReadonlyArray<{ role: string; content: string }>
  tools?: ReadonlyArray<unknown>
  toolChoice?: unknown
}

/**
 * Infer JSON output support only for a documented provider and the current
 * physical URL. Call after resolving live endpoint metadata on every fetch.
 * Third-party gateways remain unchanged, even when they expose the same model.
 */
export function jsonObjectResponseFormat(
  requestUrl: string,
  request: ResponseFormatRequest,
): { type: 'json_object' } | undefined {
  if (
    request.tools?.length ||
    request.toolChoice !== undefined ||
    !DEEPSEEK_JSON_MODELS.has(request.model)
  ) return undefined

  const requiresJson = request.messages.some(
    (message) =>
      message.role === 'system' &&
      semanticOutputFormatForPrompt(message.content) === 'json',
  )
  if (!requiresJson) return undefined

  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return undefined
  }
  if (
    url.origin !== 'https://api.deepseek.com' ||
    !DEEPSEEK_CHAT_PATHS.has(url.pathname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) return undefined

  return { type: 'json_object' }
}
