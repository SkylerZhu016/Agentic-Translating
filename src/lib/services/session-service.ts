// ---------------------------------------------------------------------------
// Session + Snapshot Service
// ---------------------------------------------------------------------------
// Ties together DB repositories, guards, and the C5 state machine to provide
// the session lifecycle: create, transition, inspect, and snapshot retrieval.
//
// Every public function is named per the Wave 2 Task 13 spec.
// ---------------------------------------------------------------------------

import { createHash, randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { Repositories } from '../db/repositories'
import {
  assertSourceNonEmpty,
  assertTransition,
} from '../guards'
import type {
  ConfigSnapshotVNext,
  MainEditorRunMode,
  ModelBinding,
  ReviewMode,
  TranslationConstraints,
  TranslationDirection,
} from '../contracts/vnext'
import {
  assertSessionPreflight,
  runSessionPreflight,
} from './session-preflight'
import { createVNextRepositories } from '../db/vnext-repositories'
import {
  createProjectRepositories,
  estimateProjectContextTokens,
  ProjectRepositoryError,
} from '../db/project-repositories'
import { createWorkspaceModelProfilesRepo } from '../db/release-config-repositories'
import type {
  SessionState,
  ConfigSnapshot,
  SessionRow,
  TranslationResultRow,
  StageOutputRow,
  FinalVersionRow,
  ChatMessageRow,
} from '../contracts/types'
import type { FrozenProjectResource } from '../contracts/projects'
import { withoutSnapshotCredentials } from './runtime-endpoint-credentials'

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

export class SessionIdempotencyConflictError extends Error {
  readonly code = 'idempotency_conflict'

  constructor() {
    super('The client request ID was already used for a different request.')
    this.name = 'SessionIdempotencyConflictError'
  }
}

// ===========================================================================
// Public Types
// ===========================================================================

export interface CreateSessionInput {
  clientRequestId?: string
  sourceText: string
  sourceLang: string
  targetLang: string
  direction?: TranslationDirection
  taskBrief?: string
  reviewMode?: ReviewMode
  mainEditorRunMode?: MainEditorRunMode
  presetRevisionId?: string | null
  promptBundleRevisionId?: string | null
  projectId?: string | null
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
  const agents = repos.translatorAgents
    .list()
    .filter((agent) => agent.endpoint_id != null)
  const coordinator = repos.coordinatorConfig.get() ?? null
  const promptsList = repos.promptTemplates.list()
  const prompts: Record<string, string> = {}
  for (const p of promptsList) {
    prompts[p.kind] = p.content
  }
  return deepClone(withoutSnapshotCredentials({
    version: 2,
    endpoint,
    endpoints,
    agents,
    coordinator,
    prompts,
  })) as ConfigSnapshot
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(
    db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
    ).get(table),
  )
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function normalizedAgentVariantIds(ids: string[] | undefined): string[] {
  return [...new Set(ids ?? [])].sort()
}

function sessionRequestHash(input: CreateSessionInput): string {
  const canonicalRequest = {
    version: 1,
    sourceText: input.sourceText,
    sourceLang: input.sourceLang,
    targetLang: input.targetLang,
    direction: input.direction ?? 'en_to_zh',
    taskBrief: input.taskBrief ?? '',
    reviewMode: input.reviewMode ?? 'main_editor',
    // Preserve historical fixed-pipeline idempotency hashes; only the new
    // opt-in mode changes the request identity.
    mainEditorRunMode:
      input.mainEditorRunMode === 'tool_enabled' ? 'tool_enabled' : undefined,
    presetRevisionId: input.presetRevisionId ?? null,
    promptBundleRevisionId: input.promptBundleRevisionId ?? null,
    projectId: input.projectId ?? null,
    // A preset supplies its own immutable Agent snapshot, so this otherwise
    // user-selectable field has no effect on the created session.
    allowedAgentVariantIds: input.presetRevisionId
      ? null
      : normalizedAgentVariantIds(input.allowedAgentVariantIds),
    constraints: input.constraints ?? {},
  }
  return createHash('sha256').update(canonicalJson(canonicalRequest)).digest('hex')
}

/**
 * Old sessions predate request hashes. Compare every request field that can be
 * reconstructed from the immutable row/config snapshot before lazily binding
 * the legacy key to a hash. Ambiguous non-empty Agent selections are rejected.
 */
function legacySessionMatchesRequest(
  session: SessionRow,
  input: CreateSessionInput,
): boolean {
  let snapshot: ConfigSnapshot
  try {
    snapshot = JSON.parse(session.config_snapshot) as ConfigSnapshot
  } catch {
    return false
  }

  const direction = input.direction ?? 'en_to_zh'
  const reviewMode = input.reviewMode ?? 'main_editor'
  const mainEditorRunMode = input.mainEditorRunMode ?? 'fixed_pipeline'
  const presetRevisionId = input.presetRevisionId ?? null
  if (
    session.source_text !== input.sourceText ||
    session.source_lang !== input.sourceLang ||
    session.target_lang !== input.targetLang ||
    (session.direction ?? snapshot.direction ?? 'en_to_zh') !== direction ||
    (session.task_brief ?? snapshot.taskBrief ?? '') !== (input.taskBrief ?? '') ||
    (session.review_mode ?? snapshot.orchestrationPolicy?.reviewMode ??
      'main_editor') !== reviewMode ||
    (snapshot.orchestrationPolicy?.mainEditorRunMode ?? 'fixed_pipeline') !==
      mainEditorRunMode ||
    (session.preset_revision_id ??
      snapshot.presetRevisionSnapshot?.id ??
      null) !== presetRevisionId ||
    (snapshot.promptBundleRevisionId ?? null) !==
      (input.promptBundleRevisionId ?? null) ||
    (snapshot.projectId ?? null) !== (input.projectId ?? null)
  ) {
    return false
  }

  const presetConstraints =
    snapshot.presetRevisionSnapshot?.contract.constraints ?? {}
  const expectedConstraints = {
    ...presetConstraints,
    ...(input.constraints ?? {}),
  }
  if (
    canonicalJson(snapshot.constraints ?? {}) !==
    canonicalJson(expectedConstraints)
  ) {
    return false
  }

  const requestedVariantIds = normalizedAgentVariantIds(
    input.allowedAgentVariantIds,
  )
  if (requestedVariantIds.length > 0 && !presetRevisionId) {
    const frozenVariantIds = normalizedAgentVariantIds(
      snapshot.agentVariantSnapshots?.map((variant) => variant.id),
    )
    if (canonicalJson(requestedVariantIds) !== canonicalJson(frozenVariantIds)) {
      return false
    }
  }

  return true
}

function normalizeLiteral(value: string): string {
  return value.normalize('NFKC').toLowerCase()
}

function containsExactLiteral(
  normalizedHaystack: string,
  needle: string | null,
): boolean {
  const normalizedNeedle = needle ? normalizeLiteral(needle.trim()) : ''
  if (!normalizedNeedle) return false
  const needsLeadingBoundary = /[\p{Script=Latin}\p{N}_]/u.test(
    normalizedNeedle[0],
  )
  const needsTrailingBoundary = /[\p{Script=Latin}\p{N}_]/u.test(
    normalizedNeedle[normalizedNeedle.length - 1],
  )
  let offset = 0
  while (offset <= normalizedHaystack.length - normalizedNeedle.length) {
    const index = normalizedHaystack.indexOf(normalizedNeedle, offset)
    if (index < 0) return false
    const before = index > 0 ? normalizedHaystack[index - 1] : ''
    const after = normalizedHaystack[index + normalizedNeedle.length] ?? ''
    const leadingBoundaryOk =
      !needsLeadingBoundary ||
      !before ||
      !/[\p{Script=Latin}\p{N}_]/u.test(before)
    const trailingBoundaryOk =
      !needsTrailingBoundary ||
      !after ||
      !/[\p{Script=Latin}\p{N}_]/u.test(after)
    if (leadingBoundaryOk && trailingBoundaryOk) return true
    offset = index + 1
  }
  return false
}

function selectRelevantProjectResources(
  resources: FrozenProjectResource[],
  sourceText: string,
  taskBrief: string,
): FrozenProjectResource[] {
  const normalizedSourceText = normalizeLiteral(sourceText)
  const normalizedTaskBrief = normalizeLiteral(taskBrief)
  const requestText = `${normalizedSourceText}\n${normalizedTaskBrief}`
  return resources.filter(({ revision }) => {
    const { scope, kind, content } = revision
    if (
      scope.level !== 'project' &&
      !containsExactLiteral(requestText, scope.selector)
    ) {
      return false
    }
    if (scope.pinned) return true
    if (kind === 'style_rule' || kind === 'context_note') return true

    if (
      kind === 'term' ||
      kind === 'proper_noun' ||
      kind === 'approved_decision'
    ) {
      return (
        containsExactLiteral(requestText, content.sourceText) ||
        containsExactLiteral(normalizedTaskBrief, content.targetText)
      )
    }

    const exactCandidates = [
      content.sourceText,
      content.targetText,
      content.instruction,
      content.note,
    ]
    const contentMatches = exactCandidates.some((candidate) =>
      containsExactLiteral(requestText, candidate),
    )

    // Character/document-scoped voice and example entries become relevant
    // once their mandatory selector matches. Project-wide examples still need
    // an exact literal anchor so a large project snapshot is not injected whole.
    return scope.level !== 'project' || contentMatches
  })
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
      const supportsClientRequestId = (
        db.prepare('PRAGMA table_info(sessions)').all() as Array<{
          name: string
        }>
      ).some((column) => column.name === 'client_request_id')
      const supportsIdempotencyHash = tableExists(
        db,
        'session_idempotency_records',
      )
      const requestHash = sessionRequestHash(input)
      const findIdempotentSession = (): SessionRow | undefined => {
        if (!input.clientRequestId || !supportsClientRequestId) return undefined
        const existing = db.prepare(
          'SELECT * FROM sessions WHERE client_request_id=?',
        ).get(input.clientRequestId) as SessionRow | undefined
        if (!existing) return undefined

        if (supportsIdempotencyHash) {
          const record = db.prepare(
            `SELECT request_hash, session_id
             FROM session_idempotency_records
             WHERE client_request_id=?`,
          ).get(input.clientRequestId) as
            | { request_hash: string; session_id: string }
            | undefined
          if (record) {
            if (
              record.session_id !== existing.id ||
              record.request_hash !== requestHash
            ) {
              throw new SessionIdempotencyConflictError()
            }
            return existing
          }
        }

        if (!legacySessionMatchesRequest(existing, input)) {
          throw new SessionIdempotencyConflictError()
        }
        if (supportsIdempotencyHash) {
          db.prepare(
            `INSERT OR IGNORE INTO session_idempotency_records (
               client_request_id, request_hash, session_id
             ) VALUES (?, ?, ?)`,
          ).run(input.clientRequestId, requestHash, existing.id)
          const backfilled = db.prepare(
            `SELECT request_hash, session_id
             FROM session_idempotency_records
             WHERE client_request_id=?`,
          ).get(input.clientRequestId) as
            | { request_hash: string; session_id: string }
            | undefined
          if (
            !backfilled ||
            backfilled.session_id !== existing.id ||
            backfilled.request_hash !== requestHash
          ) {
            throw new SessionIdempotencyConflictError()
          }
        }
        return existing
      }
      if (input.clientRequestId && supportsClientRequestId) {
        const existing = findIdempotentSession()
        if (existing) return existing
      }

      // 1. Guards. Compare a previously used key first so every changed
      // payload consistently reports an idempotency conflict.
      assertSourceNonEmpty(input.sourceText)

      const agents = repos.translatorAgents
        .list()
        .filter((agent) => agent.endpoint_id != null)
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
        const selectedPromptRevision = input.promptBundleRevisionId
          ? db.prepare(
              `SELECT r.payload_json, f.direction
               FROM prompt_bundle_revisions r
               JOIN prompt_bundle_families f ON f.id=r.bundle_id
               WHERE r.id=? AND f.deleted_at IS NULL`,
            ).get(input.promptBundleRevisionId) as
              | { payload_json: string; direction: TranslationDirection }
              | undefined
          : undefined
        if (
          input.promptBundleRevisionId &&
          (!selectedPromptRevision ||
            selectedPromptRevision.direction !== direction)
        ) {
          throw new InvalidCustomDirectionError(
            'Prompt bundle revision is missing or does not match the session direction.',
          )
        }
        const promptBundle = selectedPromptRevision
          ? JSON.parse(selectedPromptRevision.payload_json)
          : vnext.directionPrompts.getLatest(direction)
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
        const profile = createWorkspaceModelProfilesRepo(db).get(direction)
        const firstAgent = agents[0]
        const coordinator = repos.coordinatorConfig.get()
        const defaultWorker =
          presetRevision?.contract.defaultWorkerBinding ??
          (profile?.defaultWorker.endpointId && profile.defaultWorker.model
            ? profile.defaultWorker
            : {
            endpointId:
              firstAgent?.endpoint_id ??
              coordinator?.endpoint_id ??
              endpoints[0]?.id ??
              null,
            model: firstAgent?.model ?? coordinator?.model ?? '',
            contextWindow: null,
          })
        const mainAgent =
          presetRevision?.contract.mainAgentBinding ??
          (profile?.mainAgent.endpointId && profile.mainAgent.model
            ? profile.mainAgent
            : {
          endpointId: coordinator?.endpoint_id ?? defaultWorker.endpointId,
          model: coordinator?.model ?? defaultWorker.model,
          contextWindow: null,
        })
        const roleBinding = (
          presetBinding: ModelBinding | undefined,
          profileBinding: ModelBinding | undefined,
        ): ModelBinding =>
          presetBinding ??
          (profileBinding?.endpointId && profileBinding.model
            ? profileBinding
            : mainAgent)
        const reviewAgent = roleBinding(
          presetRevision?.contract.reviewAgentBinding,
          profile?.reviewAgent,
        )
        const filterAgent = roleBinding(
          presetRevision?.contract.filterAgentBinding,
          profile?.filterAgent,
        )
        const orchestrateAgent = roleBinding(
          presetRevision?.contract.orchestrateAgentBinding,
          profile?.orchestrateAgent,
        )
        const assembleAgent = roleBinding(
          presetRevision?.contract.assembleAgentBinding,
          profile?.assembleAgent,
        )
        const editingAgent =
          presetRevision?.contract.editingAgentBinding ??
          (profile?.editingAgent.endpointId && profile.editingAgent.model
            ? profile.editingAgent
            : {
          endpointId: coordinator?.chat_endpoint_id ?? mainAgent.endpointId,
          model: coordinator?.chat_model || mainAgent.model,
          contextWindow: null,
        })
        Object.assign(snapshot, {
          version: 3 as const,
          direction,
          promptBundleSnapshot: promptBundle,
          agentVariantSnapshots: executionVariants,
          endpointSnapshots: endpoints.map((endpoint) => ({
            id: endpoint.id,
            name: endpoint.name,
            baseUrl: endpoint.base_url,
            chatCompletionsPath:
              endpoint.chat_completions_path ?? '/v1/chat/completions',
            hasApiKey: endpoint.api_key.length > 0,
            contextWindow: endpoint.context_window ?? null,
          })),
          modelBindings: {
            defaultWorker,
            mainAgent,
            reviewAgent,
            filterAgent,
            orchestrateAgent,
            assembleAgent,
            editingAgent,
          },
          presetRevisionSnapshot: presetRevision,
          promptBundleRevisionId: input.promptBundleRevisionId ?? null,
          taskBrief: input.taskBrief ?? '',
          constraints: {
            ...(presetRevision?.contract.constraints ?? {}),
            ...(input.constraints ?? {}),
          },
          orchestrationPolicy: {
            teamPolicy: presetRevision?.contract.teamPolicy ?? 'dynamic',
            reviewMode:
              input.reviewMode ??
              presetRevision?.contract.reviewMode ??
              'main_editor',
            mainEditorRunMode:
              input.mainEditorRunMode ??
              presetRevision?.contract.mainEditorRunMode ??
              'fixed_pipeline',
            maxAgentCalls: presetRevision?.contract.maxAgentCalls ?? 5,
            candidateAnnotationMode:
              presetRevision?.contract.candidateAnnotationMode ?? 'body_only',
          },
        })
      }

      const resolveProjectFreezePlan = () => {
        if (!input.projectId) return null
        if (
          !tableExists(db, 'translation_projects') ||
          !tableExists(db, 'session_project_contexts')
        ) {
          throw new ProjectRepositoryError(
            'project_not_found',
            `Translation project ${input.projectId} was not found.`,
          )
        }
        const projectRepositories = createProjectRepositories(db)
        const project = projectRepositories.projects.get(input.projectId)
        if (!project) {
          throw new ProjectRepositoryError(
            'project_not_found',
            `Translation project ${input.projectId} was not found.`,
          )
        }
        if (project.status !== 'active') {
          throw new ProjectRepositoryError(
            'project_archived',
            `Translation project ${input.projectId} is archived and cannot start a new session.`,
          )
        }
        if (project.direction !== direction) {
          throw new ProjectRepositoryError(
            'direction_mismatch',
            `Project direction ${project.direction} does not match session direction ${direction}.`,
          )
        }
        if (!project.currentSnapshotId) {
          throw new ProjectRepositoryError(
            'snapshot_not_found',
            `Translation project ${input.projectId} has no current snapshot.`,
          )
        }
        const snapshotResources = projectRepositories.snapshots.getResources(
          project.id,
          project.currentSnapshotId,
        )
        const resources = selectRelevantProjectResources(
          snapshotResources,
          input.sourceText,
          input.taskBrief ?? '',
        )
        const projectFreezePlan = {
          repositories: projectRepositories,
          projectId: project.id,
          projectSnapshotId: project.currentSnapshotId,
          resourceRevisionIds: resources.map(
            (resource) => resource.revision.id,
          ),
          tokenEstimate: estimateProjectContextTokens(resources),
        }
        Object.assign(snapshot, {
          projectId: project.id,
          projectSnapshotId: project.currentSnapshotId,
        })
        return projectFreezePlan
      }
      const id = randomUUID()

      // 3. Transaction: resolve the current project snapshot, insert the
      // session and children, then freeze the selected resource subset.
      const txn = db.transaction(() => {
        const projectFreezePlan = resolveProjectFreezePlan()
        if (snapshot.version === 3) {
          const preflight = runSessionPreflight({
            sourceText: input.sourceText,
            taskBrief: input.taskBrief,
            projectContextTokens: projectFreezePlan?.tokenEstimate ?? 0,
            snapshot: snapshot as unknown as ConfigSnapshotVNext,
          })
          Object.assign(snapshot, { preflight })
          assertSessionPreflight(preflight)
        }
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
        if (
          input.clientRequestId &&
          supportsClientRequestId
        ) {
          db.prepare(
            'UPDATE sessions SET client_request_id=? WHERE id=?',
          ).run(input.clientRequestId, id)
          if (supportsIdempotencyHash) {
            db.prepare(
              `INSERT INTO session_idempotency_records (
                 client_request_id, request_hash, session_id
               ) VALUES (?, ?, ?)`,
            ).run(input.clientRequestId, requestHash, id)
          }
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

        if (projectFreezePlan) {
          projectFreezePlan.repositories.sessionProjectContexts.freezeForSession({
            sessionId: id,
            projectId: projectFreezePlan.projectId,
            projectSnapshotId: projectFreezePlan.projectSnapshotId,
            direction,
            resourceRevisionIds: projectFreezePlan.resourceRevisionIds,
            tokenEstimate: projectFreezePlan.tokenEstimate,
          })
        }
      })

      try {
        txn()
      } catch (error) {
        // A concurrent creator may have committed the same key after our
        // initial lookup. Re-validate its request hash before replaying it.
        if (input.clientRequestId && supportsClientRequestId) {
          const existing = findIdempotentSession()
          if (existing) return existing
        }
        throw error
      }

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
