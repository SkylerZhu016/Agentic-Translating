import type Database from 'better-sqlite3'
import { decryptSecret } from './secrets'

const REDACTED = '[REDACTED_CREDENTIAL]'

function configuredSecrets(db: Database.Database): string[] {
  try {
    const hasEndpoints = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='endpoints'",
    ).get()
    if (!hasEndpoints) return []
    const rows = db.prepare(
      "SELECT api_key FROM endpoints WHERE api_key IS NOT NULL AND trim(api_key) <> ''",
    ).all() as Array<{ api_key: string }>
    return rows
      .map((row) => {
        try {
          return decryptSecret(row.api_key).trim()
        } catch {
          return ''
        }
      })
      .filter((secret) => secret.length > 0)
      .sort((left, right) => right.length - left.length)
  } catch {
    return []
  }
}

/** Remove known endpoint secrets and common credential/header spellings. */
export function redactCredentialText(
  value: string,
  secrets: readonly string[] = [],
): string {
  let redacted = value
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join(REDACTED)
  }
  return redacted
    .replace(
      /(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;"'}\]]+/gi,
      `$1${REDACTED}`,
    )
    .replace(/\bbearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/gi, `Bearer ${REDACTED}`)
    .replace(/\b(?:sk|rk)[-_][A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/enc:v1:[A-Za-z0-9+/=]+/g, REDACTED)
    .replace(
      /((?:api[_-]?key|access[_-]?token)\s*[:=]\s*["']?)[^\s,;"'}\]]+/gi,
      `$1${REDACTED}`,
    )
}

export function redactCredentialValue<T>(
  value: T,
  secrets: readonly string[] = [],
): T {
  if (typeof value === 'string') {
    return redactCredentialText(value, secrets) as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactCredentialValue(item, secrets)) as T
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      output[key] = redactCredentialValue(child, secrets)
    }
    return output as T
  }
  return value
}

export function redactCredentialValueForDb<T>(
  db: Database.Database,
  value: T,
): T {
  return redactCredentialValue(value, configuredSecrets(db))
}

export function safeErrorMessageForPersistence(
  db: Database.Database,
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error)
  return redactCredentialValueForDb(db, message) || 'Provider request failed'
}
