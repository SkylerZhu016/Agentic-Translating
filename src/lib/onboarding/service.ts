import type Database from 'better-sqlite3'
import { onboardingUpdateSchema, type OnboardingStatus } from './contracts'
import { createOnboardingRepository } from './repository'

export class OnboardingReferenceError extends Error {
  readonly code: 'endpoint_not_found'

  constructor(code: 'endpoint_not_found') {
    super(code)
    this.name = 'OnboardingReferenceError'
    this.code = code
  }
}

function isRunnableBinding(
  value: unknown,
  endpointIds: ReadonlySet<number>,
): boolean {
  if (!value || typeof value !== 'object') return false
  const binding = value as Record<string, unknown>
  return (
    typeof binding.endpointId === 'number' &&
    endpointIds.has(binding.endpointId) &&
    typeof binding.model === 'string' &&
    binding.model.trim().length > 0
  )
}

function hasRunnableWorkspaceProfile(
  db: Database.Database,
  endpointIds: ReadonlySet<number>,
): boolean {
  const rows = db.prepare(`
    SELECT default_worker_json, main_agent_json, review_agent_json,
           filter_agent_json, orchestrate_agent_json, assemble_agent_json,
           editing_agent_json
    FROM workspace_model_profiles
  `).all() as Array<Record<string, string | null>>

  for (const row of rows) {
    for (const encoded of Object.values(row)) {
      if (!encoded) continue
      try {
        if (isRunnableBinding(JSON.parse(encoded), endpointIds)) return true
      } catch {
        // A malformed existing profile is not a runnable configuration. It is
        // left intact for its owning repository to diagnose.
      }
    }
  }
  return false
}

export function hasRunnableConfiguration(db: Database.Database): boolean {
  const endpointIds = new Set(
    (
      db.prepare('SELECT id FROM endpoints').all() as Array<{ id: number }>
    ).map((row) => row.id),
  )
  if (endpointIds.size === 0) return false

  const translator = db.prepare(`
    SELECT 1
    FROM translator_agents AS agent
    JOIN endpoints AS endpoint ON endpoint.id = agent.endpoint_id
    WHERE length(trim(agent.model)) > 0
    LIMIT 1
  `).get()
  if (translator) return true

  const coordinator = db.prepare(`
    SELECT 1
    FROM coordinator_config AS config
    WHERE (
      length(trim(config.model)) > 0
      AND config.endpoint_id IN (SELECT id FROM endpoints)
    ) OR (
      length(trim(config.chat_model)) > 0
      AND config.chat_endpoint_id IN (SELECT id FROM endpoints)
    )
    LIMIT 1
  `).get()
  if (coordinator) return true

  return hasRunnableWorkspaceProfile(db, endpointIds)
}

export function getOnboardingStatus(
  db: Database.Database,
): OnboardingStatus {
  const state = createOnboardingRepository(db).getState()
  const hasRunnableConfig = hasRunnableConfiguration(db)
  const recommendedAction =
    state.completedAt || state.dismissedAt
      ? 'none'
      : hasRunnableConfig
        ? 'check_existing'
        : 'start'
  return { state, hasRunnableConfig, recommendedAction }
}

export function updateOnboardingStatus(
  db: Database.Database,
  input: unknown,
): OnboardingStatus {
  const update = onboardingUpdateSchema.parse(input)
  if (update.selectedEndpointId != null) {
    const endpoint = db.prepare('SELECT 1 FROM endpoints WHERE id = ?').get(
      update.selectedEndpointId,
    )
    if (!endpoint) throw new OnboardingReferenceError('endpoint_not_found')
  }
  createOnboardingRepository(db).updateState(update)
  return getOnboardingStatus(db)
}
