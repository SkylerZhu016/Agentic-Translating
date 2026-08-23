import type Database from 'better-sqlite3'
import type { ConfigSnapshot } from '../contracts/types'
import { normalizeChatCompletionsPath } from '../llm/endpoint-url'
import { decryptSecret } from '../security/secrets'

export class RuntimeEndpointCredentialError extends Error {
  readonly code:
    | 'runtime_endpoint_deleted'
    | 'runtime_endpoint_disabled'
    | 'runtime_endpoint_key_unavailable'
    | 'runtime_endpoint_address_invalid'
  readonly endpointId: number

  constructor(
    code: RuntimeEndpointCredentialError['code'],
    endpointId: number,
  ) {
    const messages: Record<RuntimeEndpointCredentialError['code'], string> = {
      runtime_endpoint_deleted:
        `Live endpoint ${endpointId} no longer exists; restore or rebind it before making a paid call.`,
      runtime_endpoint_disabled:
        `Live endpoint ${endpointId} is disabled; enable or rebind it before making a paid call.`,
      runtime_endpoint_key_unavailable:
        `Current credential for live endpoint ${endpointId} is unavailable; update the endpoint key before making a paid call.`,
      runtime_endpoint_address_invalid:
        `Current address for live endpoint ${endpointId} is invalid; update or rebind it before making a paid call.`,
    }
    super(messages[code])
    this.name = 'RuntimeEndpointCredentialError'
    this.code = code
    this.endpointId = endpointId
  }
}

export interface FrozenEndpointMetadata {
  id: number
  name: string
  baseUrl: string
  chatCompletionsPath: string
  contextWindow: number | null
}

export interface RuntimeEndpointConnection extends FrozenEndpointMetadata {
  apiKey: string
}

/**
 * Read provenance-only endpoint metadata from an immutable session snapshot.
 * This data must never be used to construct a physical provider request.
 */
export function frozenEndpointMetadata(
  snapshot: ConfigSnapshot,
  endpointId: number | null,
): FrozenEndpointMetadata | null {
  if (endpointId == null) return null
  const modern = snapshot.endpointSnapshots?.find(
    (endpoint) => endpoint.id === endpointId,
  )
  if (modern) {
    return {
      id: modern.id,
      name: modern.name,
      baseUrl: modern.baseUrl,
      chatCompletionsPath:
        modern.chatCompletionsPath ?? '/v1/chat/completions',
      contextWindow: modern.contextWindow,
    }
  }
  const legacy =
    snapshot.endpoints?.find((endpoint) => endpoint.id === endpointId) ??
    (snapshot.endpoint?.id === endpointId ? snapshot.endpoint : null)
  if (!legacy) return null
  return {
    id: legacy.id,
    name: legacy.name,
    baseUrl: legacy.base_url,
    chatCompletionsPath:
      legacy.chat_completions_path ?? '/v1/chat/completions',
    contextWindow: legacy.context_window ?? null,
  }
}

function validLiveAddress(
  endpointId: number,
  baseUrl: string,
  chatCompletionsPath: string,
): { baseUrl: string; chatCompletionsPath: string } {
  const trimmedBase = baseUrl.trim().replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(trimmedBase)
  } catch {
    throw new RuntimeEndpointCredentialError(
      'runtime_endpoint_address_invalid',
      endpointId,
    )
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username || parsed.password || parsed.search || parsed.hash ||
    !trimmedBase
  ) {
    throw new RuntimeEndpointCredentialError(
      'runtime_endpoint_address_invalid',
      endpointId,
    )
  }
  const trimmedPath = chatCompletionsPath.trim()
  if (
    !trimmedPath.startsWith('/') || trimmedPath.includes('\\') ||
    trimmedPath.includes('?') || trimmedPath.includes('#') ||
    trimmedPath.startsWith('//')
  ) {
    throw new RuntimeEndpointCredentialError(
      'runtime_endpoint_address_invalid',
      endpointId,
    )
  }
  return {
    baseUrl: trimmedBase,
    chatCompletionsPath: normalizeChatCompletionsPath(trimmedPath),
  }
}

/**
 * Atomically read every wire-affecting endpoint field from one live row.
 * Call this immediately before each physical fetch. Session snapshots supply
 * only the endpoint ID and frozen provenance; no snapshot address or secret is
 * merged into the returned connection.
 */
export function currentRuntimeEndpoint(
  db: Database.Database,
  endpointId: number,
): RuntimeEndpointConnection {
  const columns = new Set((
    db.prepare('PRAGMA table_info(endpoints)').all() as Array<{ name: string }>
  ).map((column) => column.name))
  if (!columns.has('id')) {
    throw new RuntimeEndpointCredentialError(
      'runtime_endpoint_deleted', endpointId,
    )
  }
  if (!columns.has('name') || !columns.has('base_url')) {
    throw new RuntimeEndpointCredentialError(
      'runtime_endpoint_address_invalid', endpointId,
    )
  }
  if (!columns.has('api_key')) {
    throw new RuntimeEndpointCredentialError(
      'runtime_endpoint_key_unavailable', endpointId,
    )
  }
  const hasChatPath = columns.has('chat_completions_path')
  const hasContextWindow = columns.has('context_window')
  const hasEnabled = columns.has('enabled')
  const row = db.prepare(`
    SELECT id, name, base_url,
      ${hasChatPath ? 'chat_completions_path' : "'/v1/chat/completions' AS chat_completions_path"},
      api_key,
      ${hasContextWindow ? 'context_window' : 'NULL AS context_window'},
      ${hasEnabled ? 'enabled' : '1 AS enabled'}
    FROM endpoints
    WHERE id=?
  `).get(endpointId) as {
    id: number
    name: string
    base_url: string
    chat_completions_path: string | null
    api_key: string | null
    context_window: number | null
    enabled: number
  } | undefined
  if (!row) {
    throw new RuntimeEndpointCredentialError(
      'runtime_endpoint_deleted', endpointId,
    )
  }
  if (row.enabled !== 1) {
    throw new RuntimeEndpointCredentialError(
      'runtime_endpoint_disabled', endpointId,
    )
  }
  const address = validLiveAddress(
    endpointId,
    row.base_url,
    row.chat_completions_path ?? '/v1/chat/completions',
  )
  let apiKey = ''
  try {
    apiKey = row.api_key ? decryptSecret(row.api_key).trim() : ''
  } catch {
    throw new RuntimeEndpointCredentialError(
      'runtime_endpoint_key_unavailable', endpointId,
    )
  }
  if (!apiKey) {
    throw new RuntimeEndpointCredentialError(
      'runtime_endpoint_key_unavailable', endpointId,
    )
  }
  return {
    id: row.id,
    name: row.name,
    ...address,
    contextWindow: row.context_window,
    apiKey,
  }
}

/**
 * Resolve a live connection for the endpoint identity frozen in a session.
 * The snapshot argument remains for call-site compatibility and provenance;
 * no value is read from it.
 */
export function resolveRuntimeEndpoint(
  db: Database.Database,
  _snapshot: ConfigSnapshot,
  endpointId: number | null,
): RuntimeEndpointConnection {
  if (endpointId == null) {
    throw new Error('Endpoint identity is unavailable in the session snapshot.')
  }
  return currentRuntimeEndpoint(db, endpointId)
}

export function runtimeEndpointCredentialErrorDto(error: unknown): {
  status: 409
  body: { error: string; message: string; endpointId: number }
} | null {
  if (!(error instanceof RuntimeEndpointCredentialError)) return null
  return {
    status: 409,
    body: {
      error: error.code,
      message: error.message,
      endpointId: error.endpointId,
    },
  }
}

/** Remove legacy embedded credentials while preserving every non-secret field. */
function stripEndpointCredentials(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripEndpointCredentials)
  if (!value || typeof value !== 'object') return value
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
    output[key] = stripEndpointCredentials(child)
  }
  return output
}

export function isOrdinarySnapshotObject(
  value: unknown,
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function withoutSnapshotCredentials(value: unknown): unknown {
  if (!isOrdinarySnapshotObject(value)) {
    throw new Error('snapshot_root_invalid: expected an ordinary object')
  }
  const snapshot = value as Record<string, unknown>
  const copy: Record<string, unknown> = { ...snapshot }
  if (
    Object.hasOwn(copy, 'endpoint') && copy.endpoint !== null &&
    !isOrdinarySnapshotObject(copy.endpoint)
  ) {
    throw new Error('snapshot_container_invalid: endpoint')
  }
  if (
    Object.hasOwn(copy, 'endpoints') &&
    (!Array.isArray(copy.endpoints) ||
      copy.endpoints.some((endpoint) => !isOrdinarySnapshotObject(endpoint)))
  ) {
    throw new Error('snapshot_container_invalid: endpoints')
  }
  if (
    Object.hasOwn(copy, 'endpointSnapshots') &&
    (!Array.isArray(copy.endpointSnapshots) ||
      copy.endpointSnapshots.some(
        (endpoint) => !isOrdinarySnapshotObject(endpoint),
      ))
  ) {
    throw new Error('snapshot_container_invalid: endpointSnapshots')
  }
  if (isOrdinarySnapshotObject(copy.endpoint)) {
    copy.endpoint = stripEndpointCredentials(copy.endpoint)
  }
  if (Array.isArray(copy.endpoints)) {
    copy.endpoints = copy.endpoints.map(stripEndpointCredentials)
  }
  if (Array.isArray(copy.endpointSnapshots)) {
    copy.endpointSnapshots = copy.endpointSnapshots.map(stripEndpointCredentials)
  }
  return copy
}
