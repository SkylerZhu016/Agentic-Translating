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
  assertSourceLength,
  assertTransition,
} from '../guards'
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

// ===========================================================================
// Public Types
// ===========================================================================

export interface CreateSessionInput {
  sourceText: string
  sourceLang: string
  targetLang: string
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
  const endpoint = repos.endpoints.list()[0] ?? null
  const agents = repos.translatorAgents.list()
  const coordinator = repos.coordinatorConfig.get() ?? null
  const promptsList = repos.promptTemplates.list()
  const prompts: Record<string, string> = {}
  for (const p of promptsList) {
    prompts[p.kind] = p.content
  }
  return deepClone({ endpoint, agents, coordinator, prompts })
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
      assertSourceLength(input.sourceText)

      const agents = repos.translatorAgents.list()
      if (agents.length === 0) {
        throw new NoAgentsConfiguredError()
      }

      // 2. Deep-clone current config into snapshot
      const snapshot = buildConfigSnapshot(repos)
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
