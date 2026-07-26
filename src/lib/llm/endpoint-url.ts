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
