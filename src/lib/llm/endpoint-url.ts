export const DEFAULT_CHAT_COMPLETIONS_PATH = '/v1/chat/completions'

export interface EndpointAddress {
  baseUrl: string
  chatCompletionsPath: string
}

export function normalizeChatCompletionsPath(value?: string | null): string {
  const trimmed = value?.trim() || DEFAULT_CHAT_COMPLETIONS_PATH
  return `/${trimmed.replace(/^\/+/, '')}`
}

export function splitEndpointAddress(value: string): EndpointAddress {
  const url = new URL(value.trim())
  const match = url.pathname.match(
    /^(.*?)(\/(?:v1|v1beta\/openai|api\/v1)\/chat\/completions)\/?$/i,
  )
  if (!match) {
    return {
      baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, '')}`,
      chatCompletionsPath: DEFAULT_CHAT_COMPLETIONS_PATH,
    }
  }
  return {
    baseUrl: `${url.origin}${match[1]}`.replace(/\/+$/, ''),
    chatCompletionsPath: normalizeChatCompletionsPath(match[2]),
  }
}

export function resolveChatCompletionsUrl(endpoint: {
  baseUrl: string
  chatCompletionsPath?: string | null
}): string {
  return `${endpoint.baseUrl.replace(/\/+$/, '')}${normalizeChatCompletionsPath(endpoint.chatCompletionsPath)}`
}

/**
 * Resolve the OpenAI-compatible model catalogue next to the configured chat
 * completions endpoint. Keeping this derivation server-side means API keys
 * never need to be exposed to the browser.
 */
export function resolveModelsUrl(endpoint: {
  baseUrl: string
  chatCompletionsPath?: string | null
}): string {
  const chatPath = normalizeChatCompletionsPath(
    endpoint.chatCompletionsPath,
  ).replace(/\/+$/, '')
  const modelsPath = /\/chat\/completions$/i.test(chatPath)
    ? chatPath.replace(/\/chat\/completions$/i, '/models')
    : '/v1/models'
  return `${endpoint.baseUrl.replace(/\/+$/, '')}${modelsPath}`
}
