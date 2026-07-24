// ---------------------------------------------------------------------------
// Session + Snapshot Service
// ---------------------------------------------------------------------------
// Ties together DB repositories, guards, and the C5 state machine to provide
// the session lifecycle: create, transition, inspect, and snapshot retrieval.
//
// Every public function is named per the Wave 2 Task 13 spec.
// ---------------------------------------------------------------------------

import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { Repositories } from '../db/repositories'
import {
  assertSourceNonEmpty,
  assertTransition,
} from '../guards'
import type {
  ReviewMode,
  TranslationConstraints,
  TranslationDirection,
} from '../contracts/vnext'
import { createVNextRepositories } from '../db/vnext-repositories'
import type {
  SessionState,
  ConfigSnapshot,
  SessionRow,
  TranslationResultRow,
  StageOutputRow,
  FinalVersionRow,
  ChatMessageRow,
} from '../contracts/types'

// ===========================================================================
// Custom Errors
// ===========================================================================

export class NoAgentsConfiguredError extends Error {
  readonly code = 'no_agents_configured'

  constructor() {
    super('No translator agents configured. At least one agent is required.')
    this.name = 'NoAgentsConfiguredError'
  }
}

export class InvalidCustomDirectionError extends Error {
  readonly code = 'invalid_custom_direction'

  constructor(message: string) {
    super(message)
    this.name = 'InvalidCustomDirectionError'
  }
}

// ===========================================================================
// Public Types
// ===========================================================================

export interface CreateSessionInput {
  sourceText: string
  sourceLang: string
  targetLang: string
  direction?: TranslationDirection
  taskBrief?: string
  reviewMode?: ReviewMode
  presetRevisionId?: string | null
  allowedAgentVariantIds?: string[]
  constraints?: TranslationConstraints
}

export interface FullSession {
  session: SessionRow
  results: TranslationResultRow[]
  stages: StageOutputRow[]
  versions: FinalVersionRow[]
  messages: ChatMessageRow[]
}

// ===========================================================================
// Helpers (file-private)
// ===========================================================================

/** Deep-clone via round-trip JSON (safe for serializable data only). */
function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj))
}

/**
 * Read all current config tables (endpoint, agents, coordinator, prompts)
 * and return a deep-cloned ConfigSnapshot. The returned object is
 * structurally independent of the DB rows — callers can safely store it.
 */
function buildConfigSnapshot(repos: Repositories): ConfigSnapshot {
  const endpoints = repos.endpoints.list()
  const endpoint = endpoints[0] ?? null
  const agents = repos.translatorAgents.list()
  const coordinator = repos.coordinatorConfig.get() ?? null
  const promptsList = repos.promptTemplates.list()
  const prompts: Record<string, string> = {}
  for (const p of promptsList) {
    prompts[p.kind] = p.content
  }
  return deepClone({ version: 2, endpoint, endpoints, agents, coordinator, prompts })
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(
    db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
    ).get(table),
  )
}

// ===========================================================================
// Service Factory
// ===========================================================================

export function createSessionService(
  db: Database.Database,
  repos: Repositories,
) {
  // Prepare bulk-update statements once for markInterruptedInFlight
  const markStreamingError = db.prepare(`
    UPDATE translation_results
    SET status = 'error', error = 'Interrupted on startup', updated_at = datetime('now')
    WHERE status = 'streaming'
  `)
  const markRunningStale = db.prepare(`
    UPDATE stage_outputs
    SET status = 'stale'
    WHERE status = 'running'
  `)

  // ── Service Methods ──────────────────────────────────────────

  return {
    // ──────────────────────────────────────────────────────────
    // createSession — create a draft session + translation_results
    // ──────────────────────────────────────────────────────────
    createSession(input: CreateSessionInput): SessionRow {
      // 1. Guards
      assertSourceNonEmpty(input.sourceText)

      const agents = repos.translatorAgents.list()
      const direction = input.direction ?? 'en_to_zh'
      const vnext = tableExists(db, 'agent_direction_variants')
        ? createVNextRepositories(db)
        : null
      const availableVariants = vnext?.agents.listVariants(direction, false) ?? []
      if (agents.length === 0 && availableVariants.length === 0) {
        throw new NoAgentsConfiguredError()
      }

      // 2. Deep-clone current config into snapshot
      const snapshot = buildConfigSnapshot(repos)
      if (vnext) {
        const promptBundle = vnext.directionPrompts.getLatest(direction)
        if (!promptBundle) {
          throw new Error(`Missing direction prompt bundle: ${direction}`)
        }
        const requestedIds = new Set(input.allowedAgentVariantIds ?? [])
        const selectedVariants =
          requestedIds.size > 0
            ? availableVariants.filter((variant) => requestedIds.has(variant.id))
            : availableVariants
        const presetRevision = input.presetRevisionId
          ? vnext.workflowPresets.getRevision(input.presetRevisionId)
          : null
        if (input.presetRevisionId && !presetRevision) {
          throw new Error(`Preset revision not found: ${input.presetRevisionId}`)
        }
        if (presetRevision) {
          const preset = vnext.workflowPresets.get(presetRevision.presetId)
          if (!preset) {
            throw new Error(`Preset not found: ${presetRevision.presetId}`)
          }
          if (preset.direction !== direction) {
            throw new InvalidCustomDirectionError(
              `Preset direction ${preset.direction} does not match session direction ${direction}.`,
            )
          }
          if (
            presetRevision.contract.agentVariantSnapshots.some(
              (variant) => variant.direction !== direction,
            )
          ) {
            throw new InvalidCustomDirectionError(
              'A preset revision cannot mix translation directions.',
            )
          }
        }
        const executionVariants =
          presetRevision?.contract.agentVariantSnapshots ?? selectedVariants
        if (
          direction === 'custom' &&
          executionVariants.filter((variant) => variant.direction === 'custom')
            .length < 2
        ) {
          throw new InvalidCustomDirectionError(
            'Custom directions require at least two enabled custom Agent variants.',
          )
        }
        const endpoints = repos.endpoints.list()
        const firstAgent = agents[0]
        const coordinator = repos.coordinatorConfig.get()
        const defaultWorker =
          presetRevision?.contract.defaultWorkerBinding ?? {
            endpointId:
              firstAgent?.endpoint_id ??
              coordinator?.endpoint_id ??
              endpoints[0]?.id ??
              null,
            model: firstAgent?.model ?? coordinator?.model ?? '',
            contextWindow: null,
          }
        const mainAgent = presetRevision?.contract.mainAgentBinding ?? {
          endpointId: coordinator?.endpoint_id ?? defaultWorker.endpointId,
          model: coordinator?.model ?? defaultWorker.model,
          contextWindow: null,
        }
        const editingAgent = presetRevision?.contract.editingAgentBinding ?? {
          endpointId: coordinator?.chat_endpoint_id ?? mainAgent.endpointId,
          model: coordinator?.chat_model || mainAgent.model,
          contextWindow: null,
        }
        Object.assign(snapshot, {
          version: 3 as const,
          direction,
          promptBundleSnapshot: promptBundle,
          agentVariantSnapshots: executionVariants,
          endpointSnapshots: endpoints.map((endpoint) => ({
            id: endpoint.id,
            name: endpoint.name,
            baseUrl: endpoint.base_url,
            apiKey: endpoint.api_key,
            hasApiKey: endpoint.api_key.length > 0,
            contextWindow: endpoint.context_window ?? null,
          })),
          modelBindings: { defaultWorker, mainAgent, editingAgent },
          presetRevisionSnapshot: presetRevision,
          taskBrief: input.taskBrief ?? '',
          constraints:
            input.constraints ?? presetRevision?.contract.constraints ?? {},
          orchestrationPolicy: {
            teamPolicy: presetRevision?.contract.teamPolicy ?? 'dynamic',
            reviewMode:
              input.reviewMode ??
              presetRevision?.contract.reviewMode ??
              'main_editor',
            maxAgentCalls: presetRevision?.contract.maxAgentCalls ?? 5,
          },
        })
      }
      const id = randomUUID()

      // 3. Transaction: session + one translation_result per agent
      const txn = db.transaction(() => {
        repos.sessions.insert({
          id,
          source_text: input.sourceText,
          source_lang: input.sourceLang,
          target_lang: input.targetLang,
          state: 'draft',
          config_snapshot: JSON.stringify(snapshot),
        })

        const sessionColumns = db
          .prepare('PRAGMA table_info(sessions)')
          .all() as Array<{ name: string }>
        if (sessionColumns.some((column) => column.name === 'direction')) {
          db.prepare(`
            UPDATE sessions
            SET direction = @direction,
                task_brief = @task_brief,
                review_mode = @review_mode,
                preset_revision_id = @preset_revision_id
            WHERE id = @id
          `).run({
            id,
            direction: input.direction ?? 'en_to_zh',
            task_brief: input.taskBrief ?? '',
            review_mode: input.reviewMode ?? 'main_editor',
            preset_revision_id: input.presetRevisionId ?? null,
          })
        }

        for (const agent of agents) {
          repos.translationResults.insert({
            session_id: id,
            agent_key: agent.name,
            agent_snapshot: JSON.stringify(agent),
            status: 'pending',
            output_text: null,
            error: null,
            latency_ms: null,
            attempt: 0,
          })
        }
      })

      txn()

      // 4. Return the fresh row
      return repos.sessions.getById(id)!
    },

    // ──────────────────────────────────────────────────────────
    // getSessionFull — eager-load session + all child records
    // ──────────────────────────────────────────────────────────
    getSessionFull(id: string): FullSession | null {
      const session = repos.sessions.getById(id)
      if (!session) return null

      return {
        session,
        results: repos.translationResults.listBySession(id),
        stages: repos.stageOutputs.listBySession(id),
        versions: repos.finalVersions.listBySession(id),
        messages: repos.chatMessages.listBySession(id),
      }
    },

    // ──────────────────────────────────────────────────────────
    // transitionState — guarded state-machine transition
    // ──────────────────────────────────────────────────────────
    transitionState(id: string, to: SessionState): void {
      const session = repos.sessions.getById(id)
      if (!session) {
        throw new Error(`Session not found: ${id}`)
      }
      assertTransition(session.state as SessionState, to)
      repos.sessions.updateState(to, id)
    },

    // ──────────────────────────────────────────────────────────
    // snapshotConfig — parse a stored JSON blob back into a
    //                 ConfigSnapshot (isolated from live data)
    // ──────────────────────────────────────────────────────────
    snapshotConfig(snapshot: string): ConfigSnapshot {
      return JSON.parse(snapshot) as ConfigSnapshot
    },

    // ──────────────────────────────────────────────────────────
    // listSessions — paginated session list (most recent first)
    // ──────────────────────────────────────────────────────────
    listSessions(
      options?: { limit?: number; offset?: number },
    ): SessionRow[] {
      const limit = options?.limit ?? 20
      const offset = options?.offset ?? 0
      const all = repos.sessions.list()
      return all.slice(offset, offset + limit)
    },

    // ──────────────────────────────────────────────────────────
    // markInterruptedInFlight — startup cleanup for orphaned
    //   streaming translation_results and running stage_outputs
    // ──────────────────────────────────────────────────────────
    markInterruptedInFlight(): void {
      const txn = db.transaction(() => {
        markStreamingError.run()
        markRunningStale.run()
      })
      txn()
    },
  }
}
