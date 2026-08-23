import type { EndpointRow, SessionRow } from '../db/repositories'
import { redactCredentialText } from './credential-redaction'

export interface PublicEndpointDto {
  id: number
  name: string
  base_url: string
  chat_completions_path: string
  request_url: string
  has_api_key: boolean
  context_window: number | null
  created_at: string
}

export function toPublicEndpointDto(endpoint: EndpointRow): PublicEndpointDto {
  return {
    id: endpoint.id,
    name: endpoint.name,
    base_url: endpoint.base_url,
    chat_completions_path:
      endpoint.chat_completions_path ?? '/v1/chat/completions',
    request_url: `${endpoint.base_url.replace(/\/+$/, '')}${endpoint.chat_completions_path ?? '/v1/chat/completions'}`,
    has_api_key: endpoint.api_key.length > 0,
    context_window: endpoint.context_window ?? null,
    created_at: endpoint.created_at,
  }
}

/** Recursively remove secrets from browser and export payloads. */
export function redactSecrets<T>(value: T): T {
  if (typeof value === 'string') {
    return redactCredentialText(value) as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item)) as T
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = key.toLowerCase().replace(/[_-]/g, '')
      if (
        (normalizedKey.endsWith('apikey') && normalizedKey !== 'hasapikey') ||
        normalizedKey === 'authorization' ||
        normalizedKey === 'token' || normalizedKey.endsWith('token') ||
        normalizedKey === 'secret' || normalizedKey.endsWith('secret') ||
        normalizedKey === 'credential' || normalizedKey.endsWith('credential')
      ) continue
      output[key] = redactSecrets(child)
    }
    return output as T
  }
  return value
}

export function toPublicSessionDto(session: SessionRow) {
  let publicSnapshot: unknown = null
  try {
    publicSnapshot = redactSecrets(JSON.parse(session.config_snapshot))
  } catch {
    publicSnapshot = null
  }
  return {
    ...session,
    config_snapshot: JSON.stringify(publicSnapshot),
    public_config_snapshot: publicSnapshot,
  }
}
