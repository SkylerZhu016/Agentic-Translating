import { createHash, randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { decryptSecret } from '@/src/lib/security/secrets'
import type {
  FrozenProjectResource,
  ProjectMemorySuggestion,
  ProjectResource,
  ProjectResourceContent,
  ProjectResourceRevision,
  ProjectResourceScope,
  ProjectResourceSource,
  ProjectResourceWithCurrentRevision,
  ProjectSnapshot,
  ProjectSnapshotSummary,
  SessionProjectContext,
  TranslationProject,
} from '@/src/lib/contracts/projects'
import {
  frozenProjectResourcesSchema,
  isProjectDirectionCompatible,
  isScopeDirectionCompatible,
  projectArchiveSchema,
  projectCreateSchema,
  projectListQuerySchema,
  projectResourceContentSchema,
  projectResourceCreateSchema,
  projectResourceDecisionSchema,
  projectResourceKindSchema,
  projectResourceListQuerySchema,
  projectResourceRevisionCreateSchema,
  projectResourceScopeSchema,
  projectResourceSourceSchema,
  projectSnapshotRevisionIdsSchema,
  projectSuggestionCreateSchema,
  projectSuggestionListQuerySchema,
  projectUpdateSchema,
  sessionProjectContextFreezeSchema,
  validateProjectResourceContent,
} from '@/src/lib/contracts/project-schemas'

type ProjectCreateInput = z.infer<typeof projectCreateSchema>
type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>
type ProjectArchiveInput = z.infer<typeof projectArchiveSchema>
type ProjectListFilters = z.infer<typeof projectListQuerySchema>
type ResourceCreateInput = z.infer<typeof projectResourceCreateSchema>
type ResourceRevisionInput = z.infer<
  typeof projectResourceRevisionCreateSchema
>
type ResourceDecisionInput = z.infer<typeof projectResourceDecisionSchema>
type ResourceListFilters = z.infer<typeof projectResourceListQuerySchema>
type SuggestionCreateInput = z.infer<typeof projectSuggestionCreateSchema>
type SuggestionListFilters = z.infer<typeof projectSuggestionListQuerySchema>
type SessionContextFreezeInput = z.infer<
  typeof sessionProjectContextFreezeSchema
>

export type ProjectRepositoryErrorCode =
  | 'project_not_found'
  | 'project_archived'
  | 'resource_not_found'
  | 'revision_not_found'
  | 'snapshot_not_found'
  | 'suggestion_not_found'
  | 'session_not_found'
  | 'direction_mismatch'
  | 'scope_direction_mismatch'
  | 'stale_project_version'
  | 'stale_resource_revision'
  | 'revision_not_suggested'
  | 'suggestion_not_pending'
  | 'suggestion_already_materialized'
  | 'idempotency_conflict'
  | 'context_already_frozen'
  | 'snapshot_membership_mismatch'
  | 'token_estimate_mismatch'
  | 'secret_content_rejected'
  | 'source_reference_invalid'
  | 'invalid_stored_json'
  | 'snapshot_integrity_error'
  | 'validation_failed'

export class ProjectRepositoryError extends Error {
  constructor(
    public readonly code: ProjectRepositoryErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ProjectRepositoryError'
  }
}

interface ProjectRow {
  id: string
  name: string
  description: string
  direction: 'en_to_zh' | 'zh_to_en' | 'custom'
  source_lang: string
  target_lang: string
  status: 'active' | 'archived'
  current_snapshot_id: string | null
  current_snapshot_revision_no: number | null
  idempotency_key: string | null
  created_at: string
  updated_at: string
}

interface ResourceRow {
  id: string
  project_id: string
  idempotency_key: string | null
  created_at: string
}

interface RevisionRow {
  id: string
  resource_id: string
  revision_no: number
  kind: z.infer<typeof projectResourceKindSchema>
  content_json: string
  status: 'suggested' | 'approved' | 'rejected' | 'retired'
  source_json: string
  scope_json: string
  idempotency_key: string | null
  created_at: string
}

interface SnapshotRow {
  id: string
  project_id: string
  revision_no: number
  approved_resource_revision_ids_json: string
  content_hash: string
  created_by_revision_id: string | null
  created_by_resource_id: string | null
  idempotency_key: string | null
  created_at: string
}

interface SuggestionRow {
  id: string
  project_id: string
  kind: z.infer<typeof projectResourceKindSchema>
  content_json: string
  source_json: string
  scope_json: string
  status: 'pending' | 'approved' | 'rejected'
  materialized_resource_id: string | null
  resolved_revision_id: string | null
  idempotency_key: string | null
  created_at: string
  resolved_at: string | null
}

interface ContextRow {
  id: string
  session_id: string
  project_id: string
  project_snapshot_id: string
  direction: 'en_to_zh' | 'zh_to_en' | 'custom'
  source_lang: string
  target_lang: string
  resource_revision_ids_json: string
  resources_json: string
  token_estimate: number
  created_at: string
}

const PROJECT_SELECT = `
  SELECT
    p.*,
    s.revision_no AS current_snapshot_revision_no
  FROM translation_projects p
  LEFT JOIN project_snapshots s ON s.id = p.current_snapshot_id
`

function nowAfter(previous?: string): string {
  const previousMs = previous ? Date.parse(previous) : Number.NaN
  const nextMs = Number.isFinite(previousMs)
    ? Math.max(Date.now(), previousMs + 1)
    : Date.now()
  return new Date(nextMs).toISOString()
}

function parseJson<T>(
  label: string,
  raw: string,
  schema: z.ZodType<T>,
): T {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new ProjectRepositoryError(
      'invalid_stored_json',
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new ProjectRepositoryError(
      'invalid_stored_json',
      `${label} failed validation: ${parsed.error.message}`,
    )
  }
  return parsed.data
}

function mapProject(
  row: ProjectRow,
  db: Database.Database,
): TranslationProject {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    direction: row.direction,
    sourceLang: row.source_lang,
    targetLang: row.target_lang,
    status: row.status,
    currentSnapshotId: row.current_snapshot_id,
    currentSnapshotRevisionNo: row.current_snapshot_revision_no,
    currentSnapshotSummary: getCurrentSnapshotSummary(db, row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapResource(row: ResourceRow): ProjectResource {
  return {
    id: row.id,
    projectId: row.project_id,
    createdAt: row.created_at,
  }
}

function mapRevision(row: RevisionRow): ProjectResourceRevision {
  return {
    id: row.id,
    resourceId: row.resource_id,
    revisionNo: row.revision_no,
    kind: row.kind,
    content: parseJson(
      `project_resource_revisions(${row.id}).content_json`,
      row.content_json,
      projectResourceContentSchema,
    ),
    status: row.status,
    source: parseJson(
      `project_resource_revisions(${row.id}).source_json`,
      row.source_json,
      projectResourceSourceSchema,
    ),
    scope: parseJson(
      `project_resource_revisions(${row.id}).scope_json`,
      row.scope_json,
      projectResourceScopeSchema,
    ),
    createdAt: row.created_at,
  }
}

export function hashSnapshotRevisionIds(revisionIds: string[]): string {
  const stableIds = [...revisionIds].sort()
  return createHash('sha256').update(JSON.stringify(stableIds)).digest('hex')
}

export function estimateProjectContextTokens(
  resources: FrozenProjectResource[],
): number {
  const injectableText = resources
    .map(({ revision }) =>
      canonicalJson({
        kind: revision.kind,
        content: revision.content,
        scope: revision.scope,
      }),
    )
    .join('\n')
  let cjkCharacters = 0
  let otherCharacters = 0
  for (const character of injectableText) {
    if (/\p{Script=Han}/u.test(character)) cjkCharacters += 1
    else otherCharacters += 1
  }
  return cjkCharacters + Math.ceil(otherCharacters / 4)
}

function getCurrentSnapshotSummary(
  db: Database.Database,
  project: Pick<
    ProjectRow,
    'id' | 'current_snapshot_id' | 'current_snapshot_revision_no'
  >,
): ProjectSnapshotSummary {
  if (!project.current_snapshot_id) {
    return {
      snapshotId: null,
      revisionNo: null,
      resourceCount: 0,
      tokenEstimate: 0,
    }
  }

  const snapshotRow = db
    .prepare(
      'SELECT * FROM project_snapshots WHERE id = ? AND project_id = ?',
    )
    .get(project.current_snapshot_id, project.id) as SnapshotRow | undefined
  if (!snapshotRow) {
    throw new ProjectRepositoryError(
      'snapshot_integrity_error',
      `Current project snapshot ${project.current_snapshot_id} is missing.`,
    )
  }
  const snapshot = mapSnapshot(snapshotRow, db)
  if (snapshot.revisionNo !== project.current_snapshot_revision_no) {
    throw new ProjectRepositoryError(
      'snapshot_integrity_error',
      `Current project snapshot ${snapshot.id} revision does not match the project.`,
    )
  }

  const revisionRows = db
    .prepare(
      `SELECT revision.*
       FROM project_snapshot_entries entry
       JOIN project_resource_revisions revision
         ON revision.id = entry.resource_revision_id
       JOIN project_resources resource ON resource.id = revision.resource_id
       WHERE entry.snapshot_id = ? AND entry.project_id = ?
         AND resource.project_id = ?
       ORDER BY entry.resource_revision_id`,
    )
    .all(snapshot.id, project.id, project.id) as RevisionRow[]
  if (
    revisionRows.length !== snapshot.approvedResourceRevisionIds.length ||
    revisionRows.some(
      (revision, index) =>
        revision.id !== snapshot.approvedResourceRevisionIds[index] ||
        revision.status !== 'approved',
    )
  ) {
    throw new ProjectRepositoryError(
      'snapshot_integrity_error',
      `Approved resource revisions are missing from current snapshot ${snapshot.id}.`,
    )
  }
  const resources = revisionRows.map((row) => {
    const revision = mapRevision(row)
    return { resourceId: revision.resourceId, revision }
  })
  assertProjectContentHasNoApiKey(db, resources)

  return {
    snapshotId: snapshot.id,
    revisionNo: snapshot.revisionNo,
    resourceCount: resources.length,
    tokenEstimate: estimateProjectContextTokens(resources),
  }
}

function mapSnapshot(
  row: SnapshotRow,
  db: Database.Database,
): ProjectSnapshot {
  const approvedResourceRevisionIds = parseJson(
    `project_snapshots(${row.id}).approved_resource_revision_ids_json`,
    row.approved_resource_revision_ids_json,
    projectSnapshotRevisionIdsSchema,
  )
  if (hashSnapshotRevisionIds(approvedResourceRevisionIds) !== row.content_hash) {
    throw new ProjectRepositoryError(
      'snapshot_integrity_error',
      `Project snapshot ${row.id} content hash does not match its manifest.`,
    )
  }
  const normalizedRevisionIds = (
    db
      .prepare(
        `SELECT resource_revision_id
         FROM project_snapshot_entries
         WHERE snapshot_id = ? AND project_id = ?
         ORDER BY resource_revision_id`,
      )
      .all(row.id, row.project_id) as Array<{ resource_revision_id: string }>
  ).map((entry) => entry.resource_revision_id)
  if (
    JSON.stringify(normalizedRevisionIds) !==
    JSON.stringify(approvedResourceRevisionIds)
  ) {
    throw new ProjectRepositoryError(
      'snapshot_integrity_error',
      `Project snapshot ${row.id} manifest does not match its normalized entries.`,
    )
  }
  return {
    id: row.id,
    projectId: row.project_id,
    revisionNo: row.revision_no,
    approvedResourceRevisionIds,
    contentHash: row.content_hash,
    createdAt: row.created_at,
  }
}

function mapSuggestion(row: SuggestionRow): ProjectMemorySuggestion {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    content: parseJson(
      `project_memory_suggestions(${row.id}).content_json`,
      row.content_json,
      projectResourceContentSchema,
    ),
    source: parseJson(
      `project_memory_suggestions(${row.id}).source_json`,
      row.source_json,
      projectResourceSourceSchema,
    ),
    scope: parseJson(
      `project_memory_suggestions(${row.id}).scope_json`,
      row.scope_json,
      projectResourceScopeSchema,
    ),
    status: row.status,
    materializedResourceId: row.materialized_resource_id,
    resolvedRevisionId: row.resolved_revision_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }
}

function mapContext(row: ContextRow): SessionProjectContext {
  const resourceRevisionIds = parseJson(
    `session_project_contexts(${row.id}).resource_revision_ids_json`,
    row.resource_revision_ids_json,
    projectSnapshotRevisionIdsSchema,
  )
  const resources = parseJson(
    `session_project_contexts(${row.id}).resources_json`,
    row.resources_json,
    frozenProjectResourcesSchema,
  )
  if (
    resources.length !== resourceRevisionIds.length ||
    resources.some(
      (resource, index) => resource.revision.id !== resourceRevisionIds[index],
    )
  ) {
    throw new ProjectRepositoryError(
      'invalid_stored_json',
      `Session project context ${row.id} resource manifest does not match its frozen resources.`,
    )
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    projectId: row.project_id,
    projectSnapshotId: row.project_snapshot_id,
    direction: row.direction,
    sourceLang: row.source_lang,
    targetLang: row.target_lang,
    resourceRevisionIds,
    resources,
    tokenEstimate: row.token_estimate,
    createdAt: row.created_at,
  }
}

const FORBIDDEN_SECRET_KEYS = new Set([
  'apikey',
  'authorization',
  'xapikey',
  'accesstoken',
  'bearertoken',
  'clientsecret',
  'secretkey',
])

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function inspectForSecretKeys(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectForSecretKeys(item, `${path}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_SECRET_KEYS.has(normalizeKey(key))) {
      throw new ProjectRepositoryError(
        'secret_content_rejected',
        `Secret-bearing field ${path}.${key} is not allowed in project content.`,
      )
    }
    inspectForSecretKeys(child, `${path}.${key}`)
  }
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringValues)
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(stringValues)
  }
  return []
}

export function assertProjectContentHasNoApiKey(
  db: Database.Database,
  value: unknown,
): void {
  inspectForSecretKeys(value, 'content')
  const values = stringValues(value)
  const configuredSecrets = db
    .prepare("SELECT api_key FROM endpoints WHERE trim(api_key) <> ''")
    .all() as Array<{ api_key: string }>

  for (const secret of configuredSecrets.map((row) =>
    decryptSecret(row.api_key).trim(),
  )) {
    const leaked =
      secret.length > 0 && values.some((candidate) => candidate.includes(secret))
    if (leaked) {
      throw new ProjectRepositoryError(
        'secret_content_rejected',
        'Configured API keys cannot be stored in project content.',
      )
    }
  }

  const genericApiKeyPattern = /\b(?:sk|rk)[-_][A-Za-z0-9_-]{16,}\b/
  const encryptedSecretPattern = /enc:v1:[A-Za-z0-9+/=]+/
  if (
    values.some(
      (candidate) =>
        genericApiKeyPattern.test(candidate) ||
        encryptedSecretPattern.test(candidate),
    )
  ) {
    throw new ProjectRepositoryError(
      'secret_content_rejected',
      'API-key-like values cannot be stored in project content.',
    )
  }
}

function defaultSource(): ProjectResourceSource {
  return {
    type: 'user',
    sessionId: null,
    referenceId: null,
    note: '',
  }
}

function defaultScope(
  direction: 'en_to_zh' | 'zh_to_en' | 'custom',
): ProjectResourceScope {
  return {
    direction,
    level: 'project',
    selector: null,
    pinned: false,
  }
}

function operationKey(
  operation: 'revision' | 'approve' | 'reject',
  key: string | undefined,
): string | null {
  return key ? `${operation}:${key}` : null
}

type ProjectIdempotencyOperation =
  | 'project_create'
  | 'project_archive'
  | 'resource_create'
  | 'resource_revision'
  | 'resource_approve'
  | 'resource_reject'
  | 'suggestion_create'

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function normalizedLanguageLabel(value: string): string {
  return value.trim().toLocaleLowerCase().replaceAll('_', '-')
}

function idempotencyRequestHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function assertScopeMatchesProject(
  project: TranslationProject,
  scope: ProjectResourceScope,
): void {
  if (!isScopeDirectionCompatible(project.direction, scope.direction)) {
    throw new ProjectRepositoryError(
      'scope_direction_mismatch',
      'Resource scope direction does not match the owning project.',
    )
  }
}

function assertContentMatchesKind(
  kind: z.infer<typeof projectResourceKindSchema>,
  content: ProjectResourceContent,
): void {
  const message = validateProjectResourceContent(kind, content)
  if (message) {
    throw new ProjectRepositoryError('validation_failed', message)
  }
}

export function createProjectRepositories(db: Database.Database) {
  const findIdempotentResult = (
    operation: ProjectIdempotencyOperation,
    ownerId: string,
    key: string | undefined,
    request: unknown,
  ): string | undefined => {
    if (!key) return undefined
    const row = db
      .prepare(
        `SELECT request_hash, result_entity_id
         FROM project_idempotency_records
         WHERE operation = ? AND owner_id = ? AND idempotency_key = ?`,
      )
      .get(operation, ownerId, key) as
      | { request_hash: string; result_entity_id: string }
      | undefined
    if (!row) return undefined
    if (row.request_hash !== idempotencyRequestHash(request)) {
      throw new ProjectRepositoryError(
        'idempotency_conflict',
        'The idempotency key was already used for a different request.',
      )
    }
    return row.result_entity_id
  }

  const recordIdempotentResult = (
    operation: ProjectIdempotencyOperation,
    ownerId: string,
    key: string | undefined,
    request: unknown,
    resultEntityId: string,
    createdAt: string,
  ): void => {
    if (!key) return
    db.prepare(
      `INSERT INTO project_idempotency_records (
         operation, owner_id, idempotency_key, request_hash,
         result_entity_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      operation,
      ownerId,
      key,
      idempotencyRequestHash(request),
      resultEntityId,
      createdAt,
    )
  }

  const getProjectRow = (id: string): ProjectRow | undefined =>
    db.prepare(`${PROJECT_SELECT} WHERE p.id = ?`).get(id) as
      | ProjectRow
      | undefined

  const getProject = (id: string): TranslationProject | undefined => {
    const row = getProjectRow(id)
    return row ? mapProject(row, db) : undefined
  }

  const requireProject = (id: string): TranslationProject => {
    const project = getProject(id)
    if (!project) {
      throw new ProjectRepositoryError(
        'project_not_found',
        `Translation project ${id} was not found.`,
      )
    }
    return project
  }

  const requireActiveProject = (id: string): TranslationProject => {
    const project = requireProject(id)
    if (project.status !== 'active') {
      throw new ProjectRepositoryError(
        'project_archived',
        `Translation project ${id} is archived and read-only.`,
      )
    }
    return project
  }

  const validateSourceOwnership = (
    projectId: string,
    source: ProjectResourceSource,
  ): void => {
    if (source.type === 'user' || source.type === 'import') return
    if (!source.sessionId || !source.referenceId) {
      throw new ProjectRepositoryError(
        'source_reference_invalid',
        `${source.type} sources require a session and reference ID.`,
      )
    }
    const context = db
      .prepare(
        `SELECT project_id FROM session_project_contexts WHERE session_id = ?`,
      )
      .get(source.sessionId) as { project_id: string } | undefined
    if (!context || context.project_id !== projectId) {
      throw new ProjectRepositoryError(
        'source_reference_invalid',
        'The source session is not frozen to the owning project.',
      )
    }

    let referencedSessionId: string | undefined
    if (source.type === 'session_patch') {
      referencedSessionId = (
        db.prepare('SELECT session_id FROM text_patches WHERE id = ?').get(
          source.referenceId,
        ) as { session_id: string } | undefined
      )?.session_id
    } else if (source.type === 'agent_suggestion') {
      referencedSessionId = (
        db.prepare('SELECT session_id FROM agent_invocations WHERE id = ?').get(
          source.referenceId,
        ) as { session_id: string } | undefined
      )?.session_id
    } else {
      const hasDisagreementDecisions = Boolean(
        db
          .prepare(
            `SELECT 1 FROM sqlite_master
             WHERE type = 'table' AND name = 'disagreement_decisions'`,
          )
          .get(),
      )
      if (hasDisagreementDecisions) {
        referencedSessionId = (
          db
            .prepare(
              'SELECT session_id FROM disagreement_decisions WHERE id = ?',
            )
            .get(source.referenceId) as { session_id: string } | undefined
        )?.session_id
      }
    }
    if (referencedSessionId !== source.sessionId) {
      throw new ProjectRepositoryError(
        'source_reference_invalid',
        'The audit reference does not belong to the declared project session.',
      )
    }
  }

  const getResourceRow = (
    projectId: string,
    resourceId: string,
  ): ResourceRow | undefined =>
    db
      .prepare(
        `SELECT * FROM project_resources WHERE id = ? AND project_id = ?`,
      )
      .get(resourceId, projectId) as ResourceRow | undefined

  const requireResourceRow = (
    projectId: string,
    resourceId: string,
  ): ResourceRow => {
    const resource = getResourceRow(projectId, resourceId)
    if (!resource) {
      throw new ProjectRepositoryError(
        'resource_not_found',
        `Project resource ${resourceId} was not found in project ${projectId}.`,
      )
    }
    return resource
  }

  const getCurrentRevisionRow = (
    resourceId: string,
  ): RevisionRow | undefined =>
    db
      .prepare(
        `SELECT *
         FROM project_resource_revisions
         WHERE resource_id = ?
         ORDER BY revision_no DESC
         LIMIT 1`,
      )
      .get(resourceId) as RevisionRow | undefined

  const requireCurrentRevision = (resourceId: string): ProjectResourceRevision => {
    const row = getCurrentRevisionRow(resourceId)
    if (!row) {
      throw new ProjectRepositoryError(
        'revision_not_found',
        `Project resource ${resourceId} has no revision.`,
      )
    }
    return mapRevision(row)
  }

  const getRevisionById = (
    projectId: string,
    revisionId: string,
  ): ProjectResourceRevision | undefined => {
    const row = db
      .prepare(
        `SELECT revision.*
         FROM project_resource_revisions revision
         JOIN project_resources resource ON resource.id = revision.resource_id
         WHERE revision.id = ? AND resource.project_id = ?`,
      )
      .get(revisionId, projectId) as RevisionRow | undefined
    return row ? mapRevision(row) : undefined
  }

  const getSnapshot = (
    projectId: string,
    snapshotId: string,
  ): ProjectSnapshot | undefined => {
    const row = db
      .prepare(
        'SELECT * FROM project_snapshots WHERE id = ? AND project_id = ?',
      )
      .get(snapshotId, projectId) as SnapshotRow | undefined
    return row ? mapSnapshot(row, db) : undefined
  }

  const getFrozenSnapshotResources = (
    projectId: string,
    snapshot: ProjectSnapshot,
    selectedRevisionIds: string[] = snapshot.approvedResourceRevisionIds,
  ): FrozenProjectResource[] => {
    const stableRevisionIds = [...selectedRevisionIds].sort()
    const allowedRevisionIds = new Set(snapshot.approvedResourceRevisionIds)
    if (stableRevisionIds.some((id) => !allowedRevisionIds.has(id))) {
      throw new ProjectRepositoryError(
        'snapshot_membership_mismatch',
        'A selected resource revision is not approved in the frozen snapshot.',
      )
    }
    const frozenResources = stableRevisionIds.map((revisionId) => {
      const revision = getRevisionById(projectId, revisionId)
      if (!revision || revision.status !== 'approved') {
        throw new ProjectRepositoryError(
          'snapshot_membership_mismatch',
          `Approved resource revision ${revisionId} is missing from the project.`,
        )
      }
      return { resourceId: revision.resourceId, revision }
    })
    assertProjectContentHasNoApiKey(db, frozenResources)
    return frozenResources
  }

  const getSuggestion = (
    projectId: string,
    suggestionId: string,
  ): ProjectMemorySuggestion | undefined => {
    const row = db
      .prepare(
        `SELECT * FROM project_memory_suggestions
         WHERE id = ? AND project_id = ?`,
      )
      .get(suggestionId, projectId) as SuggestionRow | undefined
    return row ? mapSuggestion(row) : undefined
  }

  const requireSuggestion = (
    projectId: string,
    suggestionId: string,
  ): ProjectMemorySuggestion => {
    const suggestion = getSuggestion(projectId, suggestionId)
    if (!suggestion) {
      throw new ProjectRepositoryError(
        'suggestion_not_found',
        `Project suggestion ${suggestionId} was not found.`,
      )
    }
    return suggestion
  }

  const insertRevision = (input: {
    id: string
    resourceId: string
    revisionNo: number
    kind: ProjectResourceRevision['kind']
    content: ProjectResourceContent
    status: ProjectResourceRevision['status']
    source: ProjectResourceSource
    scope: ProjectResourceScope
    idempotencyKey: string | null
    createdAt: string
  }) => {
    db.prepare(
      `INSERT INTO project_resource_revisions (
        id, resource_id, revision_no, kind, content_json, status,
        source_json, scope_json, idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.resourceId,
      input.revisionNo,
      input.kind,
      JSON.stringify(input.content),
      input.status,
      JSON.stringify(input.source),
      JSON.stringify(input.scope),
      input.idempotencyKey,
      input.createdAt,
    )
  }

  const stableApprovedRevisionIds = (projectId: string): string[] => {
    const rows = db
      .prepare(
        `SELECT decisive.id
         FROM project_resources resource
         JOIN project_resource_revisions decisive
           ON decisive.resource_id = resource.id
         WHERE resource.project_id = ?
           AND decisive.revision_no = (
             SELECT MAX(candidate.revision_no)
             FROM project_resource_revisions candidate
             WHERE candidate.resource_id = resource.id
               AND candidate.status IN ('approved', 'retired')
           )
           AND decisive.status = 'approved'`,
      )
      .all(projectId) as Array<{ id: string }>
    return rows.map((row) => row.id).sort()
  }

  const projects = {
    list(filters: ProjectListFilters = {}): TranslationProject[] {
      const clauses: string[] = []
      const params: Record<string, string> = {}
      if (filters.status) {
        clauses.push('p.status = @status')
        params.status = filters.status
      }
      if (filters.direction) {
        clauses.push('p.direction = @direction')
        params.direction = filters.direction
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
      const rows = db
        .prepare(`${PROJECT_SELECT} ${where} ORDER BY p.updated_at DESC, p.id`)
        .all(params) as ProjectRow[]
      return rows.map((row) => mapProject(row, db))
    },

    get: getProject,

    create(input: ProjectCreateInput): TranslationProject {
      assertProjectContentHasNoApiKey(db, input)
      if (!isProjectDirectionCompatible(input)) {
        throw new ProjectRepositoryError(
          'direction_mismatch',
          'Project languages are incompatible with its direction.',
        )
      }
      const idempotencyRequest = {
        name: input.name,
        description: input.description,
        direction: input.direction,
        sourceLang: input.sourceLang,
        targetLang: input.targetLang,
      }
      const priorProjectId = findIdempotentResult(
        'project_create',
        'translation_projects',
        input.idempotencyKey,
        idempotencyRequest,
      )
      if (priorProjectId) return requireProject(priorProjectId)
      const id = randomUUID()
      const snapshotId = randomUUID()
      const createdAt = nowAfter()
      db.transaction(() => {
        db.prepare(
          `INSERT INTO translation_projects (
            id, name, description, direction, source_lang, target_lang,
            status, current_snapshot_id, idempotency_key, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?)`,
        ).run(
          id,
          input.name,
          input.description,
          input.direction,
          input.sourceLang,
          input.targetLang,
          input.idempotencyKey ?? null,
          createdAt,
          createdAt,
        )
        db.prepare(
          `INSERT INTO project_snapshots (
             id, project_id, revision_no,
             approved_resource_revision_ids_json, content_hash,
             created_by_revision_id, created_by_resource_id,
             idempotency_key, created_at
           ) VALUES (?, ?, 1, '[]', ?, NULL, NULL, NULL, ?)`,
        ).run(snapshotId, id, hashSnapshotRevisionIds([]), createdAt)
        db.prepare(
          `UPDATE translation_projects
           SET current_snapshot_id = ? WHERE id = ?`,
        ).run(snapshotId, id)
        recordIdempotentResult(
          'project_create',
          'translation_projects',
          input.idempotencyKey,
          idempotencyRequest,
          id,
          createdAt,
        )
      })()
      return requireProject(id)
    },

    update(id: string, input: ProjectUpdateInput): TranslationProject {
      const existing = requireActiveProject(id)
      if (existing.updatedAt !== input.expectedUpdatedAt) {
        throw new ProjectRepositoryError(
          'stale_project_version',
          'The project changed after it was loaded.',
        )
      }
      const nextName = input.name ?? existing.name
      const nextDescription = input.description ?? existing.description
      assertProjectContentHasNoApiKey(db, {
        name: nextName,
        description: nextDescription,
      })
      const updatedAt = nowAfter(existing.updatedAt)
      const result = db
        .prepare(
          `UPDATE translation_projects
           SET name = ?, description = ?, updated_at = ?
           WHERE id = ? AND updated_at = ?`,
        )
        .run(
          nextName,
          nextDescription,
          updatedAt,
          id,
          input.expectedUpdatedAt,
        )
      if (result.changes !== 1) {
        throw new ProjectRepositoryError(
          'stale_project_version',
          'The project changed while it was being updated.',
        )
      }
      return requireProject(id)
    },

    archive(id: string, input: ProjectArchiveInput): TranslationProject {
      const existing = requireProject(id)
      const idempotencyRequest = { expectedUpdatedAt: input.expectedUpdatedAt }
      const priorProjectId = findIdempotentResult(
        'project_archive',
        id,
        input.idempotencyKey,
        idempotencyRequest,
      )
      if (priorProjectId) return requireProject(priorProjectId)
      if (existing.status === 'archived') {
        recordIdempotentResult(
          'project_archive',
          id,
          input.idempotencyKey,
          idempotencyRequest,
          id,
          existing.updatedAt,
        )
        return existing
      }
      if (existing.updatedAt !== input.expectedUpdatedAt) {
        throw new ProjectRepositoryError(
          'stale_project_version',
          'The project changed after it was loaded.',
        )
      }
      const updatedAt = nowAfter(existing.updatedAt)
      db.transaction(() => {
        const result = db
          .prepare(
            `UPDATE translation_projects
             SET status = 'archived', updated_at = ?
             WHERE id = ? AND updated_at = ?`,
          )
          .run(updatedAt, id, input.expectedUpdatedAt)
        if (result.changes !== 1) {
          throw new ProjectRepositoryError(
            'stale_project_version',
            'The project changed while it was being archived.',
          )
        }
        recordIdempotentResult(
          'project_archive',
          id,
          input.idempotencyKey,
          idempotencyRequest,
          id,
          updatedAt,
        )
      })()
      return requireProject(id)
    },

    stats(id: string): {
      resourceCount: number
      tokenEstimate: number
      suggestionCount: number
    } {
      const project = requireProject(id)
      const suggestionCount = (
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM project_memory_suggestions
             WHERE project_id = ? AND status = 'pending'`,
          )
          .get(id) as { count: number }
      ).count
      return {
        resourceCount: project.currentSnapshotSummary.resourceCount,
        tokenEstimate: project.currentSnapshotSummary.tokenEstimate,
        suggestionCount,
      }
    },
  }

  const resources = {
    list(
      projectId: string,
      filters: ResourceListFilters = {},
    ): ProjectResourceWithCurrentRevision[] {
      requireProject(projectId)
      const clauses = ['resource.project_id = @projectId']
      const params: Record<string, string> = { projectId }
      if (filters.status) {
        clauses.push('revision.status = @status')
        params.status = filters.status
      }
      if (filters.kind) {
        clauses.push('revision.kind = @kind')
        params.kind = filters.kind
      }
      const rows = db
        .prepare(
          `SELECT
             resource.id AS resource_id,
             resource.project_id,
             resource.idempotency_key AS resource_idempotency_key,
             resource.created_at AS resource_created_at,
             revision.*
           FROM project_resources resource
           JOIN project_resource_revisions revision
             ON revision.resource_id = resource.id
            AND revision.revision_no = (
              SELECT MAX(candidate.revision_no)
              FROM project_resource_revisions candidate
              WHERE candidate.resource_id = resource.id
            )
           WHERE ${clauses.join(' AND ')}
           ORDER BY resource.created_at DESC, resource.id`,
        )
        .all(params) as Array<
        RevisionRow & {
          resource_id: string
          project_id: string
          resource_idempotency_key: string | null
          resource_created_at: string
        }
      >
      return rows.map((row) => ({
        resource: mapResource({
          id: row.resource_id,
          project_id: row.project_id,
          idempotency_key: row.resource_idempotency_key,
          created_at: row.resource_created_at,
        }),
        currentRevision: mapRevision(row),
      }))
    },

    get(
      projectId: string,
      resourceId: string,
    ): ProjectResourceWithCurrentRevision | undefined {
      const resourceRow = getResourceRow(projectId, resourceId)
      if (!resourceRow) return undefined
      return {
        resource: mapResource(resourceRow),
        currentRevision: requireCurrentRevision(resourceId),
      }
    },

    listRevisions(
      projectId: string,
      resourceId: string,
    ): ProjectResourceRevision[] {
      requireResourceRow(projectId, resourceId)
      const rows = db
        .prepare(
          `SELECT * FROM project_resource_revisions
           WHERE resource_id = ?
           ORDER BY revision_no DESC`,
        )
        .all(resourceId) as RevisionRow[]
      return rows.map(mapRevision)
    },

    create(
      projectId: string,
      input: ResourceCreateInput,
    ): ProjectResourceWithCurrentRevision {
      const project = requireProject(projectId)
      const idempotencyRequest = {
        kind: input.kind,
        content: input.content,
        source: input.source ?? null,
        scope: input.scope ?? null,
        suggestionId: input.suggestionId ?? null,
      }
      const priorRevisionId = findIdempotentResult(
        'resource_create',
        projectId,
        input.idempotencyKey,
        idempotencyRequest,
      )
      if (priorRevisionId) {
        const priorRevision = getRevisionById(projectId, priorRevisionId)
        if (!priorRevision) {
          throw new ProjectRepositoryError(
            'invalid_stored_json',
            'An idempotent resource result no longer exists.',
          )
        }
        const priorResource = requireResourceRow(
          projectId,
          priorRevision.resourceId,
        )
        return {
          resource: mapResource(priorResource),
          currentRevision: priorRevision,
        }
      }
      if (project.status !== 'active') {
        throw new ProjectRepositoryError(
          'project_archived',
          `Translation project ${projectId} is archived and read-only.`,
        )
      }

      const suggestion = input.suggestionId
        ? requireSuggestion(projectId, input.suggestionId)
        : null
      if (suggestion && suggestion.status !== 'pending') {
        throw new ProjectRepositoryError(
          'suggestion_not_pending',
          'Only pending suggestions can be materialized as resources.',
        )
      }
      if (suggestion?.materializedResourceId) {
        throw new ProjectRepositoryError(
          'suggestion_already_materialized',
          'This suggestion is already linked to a project resource.',
        )
      }

      const source = input.source ?? suggestion?.source ?? defaultSource()
      const scope = input.scope ?? suggestion?.scope ?? defaultScope(project.direction)
      if (
        suggestion &&
        canonicalJson({ kind: input.kind, content: input.content, source, scope }) !==
          canonicalJson({
            kind: suggestion.kind,
            content: suggestion.content,
            source: suggestion.source,
            scope: suggestion.scope,
          })
      ) {
        throw new ProjectRepositoryError(
          'validation_failed',
          'A resource materialized from a suggestion must exactly match that suggestion.',
        )
      }
      assertScopeMatchesProject(project, scope)
      validateSourceOwnership(projectId, source)
      assertContentMatchesKind(input.kind, input.content)
      assertProjectContentHasNoApiKey(db, {
        kind: input.kind,
        content: input.content,
        source,
        scope,
      })

      const resourceId = randomUUID()
      const revisionId = randomUUID()
      const createdAt = nowAfter()
      db.transaction(() => {
        db.prepare(
          `INSERT INTO project_resources (
            id, project_id, idempotency_key, created_at
          ) VALUES (?, ?, ?, ?)`,
        ).run(
          resourceId,
          projectId,
          input.idempotencyKey ?? null,
          createdAt,
        )
        insertRevision({
          id: revisionId,
          resourceId,
          revisionNo: 1,
          kind: input.kind,
          content: input.content,
          status: 'suggested',
          source,
          scope,
          idempotencyKey: null,
          createdAt,
        })
        if (suggestion) {
          db.prepare(
            `UPDATE project_memory_suggestions
             SET materialized_resource_id = ?
             WHERE id = ? AND project_id = ? AND status = 'pending'
               AND materialized_resource_id IS NULL`,
          ).run(resourceId, suggestion.id, projectId)
        }
        db.prepare(
          'UPDATE translation_projects SET updated_at = ? WHERE id = ?',
        ).run(nowAfter(project.updatedAt), projectId)
        recordIdempotentResult(
          'resource_create',
          projectId,
          input.idempotencyKey,
          idempotencyRequest,
          revisionId,
          createdAt,
        )
      })()
      return {
        resource: mapResource(requireResourceRow(projectId, resourceId)),
        currentRevision: requireCurrentRevision(resourceId),
      }
    },

    addRevision(
      projectId: string,
      resourceId: string,
      input: ResourceRevisionInput,
    ): ProjectResourceRevision {
      requireResourceRow(projectId, resourceId)
      const idempotencyRequest = {
        resourceId,
        baseRevisionId: input.baseRevisionId,
        kind: input.kind ?? null,
        content: input.content,
        source: input.source ?? null,
        scope: input.scope ?? null,
      }
      const priorRevisionId = findIdempotentResult(
        'resource_revision',
        projectId,
        input.idempotencyKey,
        idempotencyRequest,
      )
      if (priorRevisionId) {
        const priorRevision = getRevisionById(projectId, priorRevisionId)
        if (!priorRevision || priorRevision.resourceId !== resourceId) {
          throw new ProjectRepositoryError(
            'invalid_stored_json',
            'An idempotent resource revision result no longer exists.',
          )
        }
        return priorRevision
      }
      const project = requireActiveProject(projectId)
      const storedKey = operationKey('revision', input.idempotencyKey)
      const current = requireCurrentRevision(resourceId)
      if (current.id !== input.baseRevisionId) {
        throw new ProjectRepositoryError(
          'stale_resource_revision',
          'The resource changed after it was loaded.',
        )
      }
      const kind = input.kind ?? current.kind
      const source = input.source ?? current.source
      const scope = input.scope ?? current.scope
      assertScopeMatchesProject(project, scope)
      validateSourceOwnership(projectId, source)
      assertContentMatchesKind(kind, input.content)
      assertProjectContentHasNoApiKey(db, {
        kind,
        content: input.content,
        source,
        scope,
      })
      const id = randomUUID()
      const createdAt = nowAfter(current.createdAt)
      db.transaction(() => {
        insertRevision({
          id,
          resourceId,
          revisionNo: current.revisionNo + 1,
          kind,
          content: input.content,
          status: 'suggested',
          source,
          scope,
          idempotencyKey: storedKey,
          createdAt,
        })
        db.prepare(
          'UPDATE translation_projects SET updated_at = ? WHERE id = ?',
        ).run(nowAfter(project.updatedAt), projectId)
        recordIdempotentResult(
          'resource_revision',
          projectId,
          input.idempotencyKey,
          idempotencyRequest,
          id,
          createdAt,
        )
      })()
      return requireCurrentRevision(resourceId)
    },

    approve(
      projectId: string,
      resourceId: string,
      input: ResourceDecisionInput,
    ): {
      resource: ProjectResource
      revision: ProjectResourceRevision
      snapshot: ProjectSnapshot
    } {
      requireResourceRow(projectId, resourceId)
      const idempotencyRequest = { resourceId, revisionId: input.revisionId }
      const priorRevisionId = findIdempotentResult(
        'resource_approve',
        projectId,
        input.idempotencyKey,
        idempotencyRequest,
      )
      const storedKey = operationKey('approve', input.idempotencyKey)
      if (priorRevisionId) {
        const priorRevision = getRevisionById(projectId, priorRevisionId)
        if (priorRevision && priorRevision.resourceId === resourceId) {
          const priorSnapshot = db
            .prepare(
              `SELECT * FROM project_snapshots
               WHERE project_id = ? AND created_by_revision_id = ?`,
            )
            .get(projectId, priorRevision.id) as SnapshotRow | undefined
          if (!priorSnapshot) {
            throw new ProjectRepositoryError(
              'snapshot_integrity_error',
              'An idempotent approved revision is missing its snapshot.',
            )
          }
          return {
            resource: mapResource(requireResourceRow(projectId, resourceId)),
            revision: priorRevision,
            snapshot: mapSnapshot(priorSnapshot, db),
          }
        }
        throw new ProjectRepositoryError(
          'invalid_stored_json',
          'An idempotent approved revision no longer exists.',
        )
      }

      const project = requireActiveProject(projectId)
      const resource = requireResourceRow(projectId, resourceId)
      const current = requireCurrentRevision(resourceId)
      if (current.id !== input.revisionId) {
        throw new ProjectRepositoryError(
          'stale_resource_revision',
          'The resource changed after it was loaded.',
        )
      }
      if (current.status !== 'suggested') {
        throw new ProjectRepositoryError(
          'revision_not_suggested',
          'Only a suggested current revision can be approved.',
        )
      }

      const revisionId = randomUUID()
      const snapshotId = randomUUID()
      const createdAt = nowAfter(current.createdAt)
      let approvedRevisionIds: string[] = []
      let snapshotRevisionNo = 1
      db.transaction(() => {
        insertRevision({
          id: revisionId,
          resourceId,
          revisionNo: current.revisionNo + 1,
          kind: current.kind,
          content: current.content,
          status: 'approved',
          source: current.source,
          scope: current.scope,
          idempotencyKey: storedKey,
          createdAt,
        })
        approvedRevisionIds = stableApprovedRevisionIds(projectId)
        const previous = db
          .prepare(
            `SELECT COALESCE(MAX(revision_no), 0) AS revision_no
             FROM project_snapshots WHERE project_id = ?`,
          )
          .get(projectId) as { revision_no: number }
        snapshotRevisionNo = previous.revision_no + 1
        db.prepare(
          `INSERT INTO project_snapshots (
             id, project_id, revision_no,
             approved_resource_revision_ids_json, content_hash,
             created_by_revision_id, created_by_resource_id,
             idempotency_key, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          snapshotId,
          projectId,
          snapshotRevisionNo,
          JSON.stringify(approvedRevisionIds),
          hashSnapshotRevisionIds(approvedRevisionIds),
          revisionId,
          resourceId,
          storedKey,
          createdAt,
        )
        const snapshotMembers = db
          .prepare(
            `SELECT revision.id AS revision_id, revision.resource_id
             FROM project_resource_revisions revision
             JOIN project_resources resource ON resource.id = revision.resource_id
             WHERE resource.project_id = ?
               AND revision.id IN (${approvedRevisionIds.map(() => '?').join(',')})`,
          )
          .all(projectId, ...approvedRevisionIds) as Array<{
          revision_id: string
          resource_id: string
        }>
        const insertSnapshotEntry = db.prepare(
          `INSERT INTO project_snapshot_entries (
             snapshot_id, project_id, resource_id, resource_revision_id
           ) VALUES (?, ?, ?, ?)`,
        )
        if (snapshotMembers.length !== approvedRevisionIds.length) {
          throw new ProjectRepositoryError(
            'snapshot_integrity_error',
            'Approved snapshot members could not be normalized.',
          )
        }
        for (const member of snapshotMembers) {
          insertSnapshotEntry.run(
            snapshotId,
            projectId,
            member.resource_id,
            member.revision_id,
          )
        }
        db.prepare(
          `UPDATE translation_projects
           SET current_snapshot_id = ?, updated_at = ?
           WHERE id = ?`,
        ).run(snapshotId, nowAfter(project.updatedAt), projectId)
        db.prepare(
          `UPDATE project_memory_suggestions
           SET status = 'approved', resolved_revision_id = ?, resolved_at = ?
           WHERE project_id = ? AND materialized_resource_id = ?
             AND status = 'pending'`,
        ).run(revisionId, createdAt, projectId, resourceId)
        recordIdempotentResult(
          'resource_approve',
          projectId,
          input.idempotencyKey,
          idempotencyRequest,
          revisionId,
          createdAt,
        )
      })()

      return {
        resource: mapResource(resource),
        revision: requireCurrentRevision(resourceId),
        snapshot: mapSnapshot(
          db
            .prepare('SELECT * FROM project_snapshots WHERE id = ?')
            .get(snapshotId) as SnapshotRow,
          db,
        ),
      }
    },

    reject(
      projectId: string,
      resourceId: string,
      input: ResourceDecisionInput,
    ): { resource: ProjectResource; revision: ProjectResourceRevision } {
      requireResourceRow(projectId, resourceId)
      const idempotencyRequest = { resourceId, revisionId: input.revisionId }
      const priorRevisionId = findIdempotentResult(
        'resource_reject',
        projectId,
        input.idempotencyKey,
        idempotencyRequest,
      )
      const storedKey = operationKey('reject', input.idempotencyKey)
      if (priorRevisionId) {
        const priorRevision = getRevisionById(projectId, priorRevisionId)
        if (priorRevision && priorRevision.resourceId === resourceId) {
          return {
            resource: mapResource(requireResourceRow(projectId, resourceId)),
            revision: priorRevision,
          }
        }
        throw new ProjectRepositoryError(
          'invalid_stored_json',
          'An idempotent rejected revision no longer exists.',
        )
      }

      const project = requireActiveProject(projectId)
      const resource = requireResourceRow(projectId, resourceId)
      const current = requireCurrentRevision(resourceId)
      if (current.id !== input.revisionId) {
        throw new ProjectRepositoryError(
          'stale_resource_revision',
          'The resource changed after it was loaded.',
        )
      }
      if (current.status !== 'suggested') {
        throw new ProjectRepositoryError(
          'revision_not_suggested',
          'Only a suggested current revision can be rejected.',
        )
      }
      const revisionId = randomUUID()
      const createdAt = nowAfter(current.createdAt)
      db.transaction(() => {
        insertRevision({
          id: revisionId,
          resourceId,
          revisionNo: current.revisionNo + 1,
          kind: current.kind,
          content: current.content,
          status: 'rejected',
          source: current.source,
          scope: current.scope,
          idempotencyKey: storedKey,
          createdAt,
        })
        db.prepare(
          `UPDATE project_memory_suggestions
           SET status = 'rejected', resolved_revision_id = ?, resolved_at = ?
           WHERE project_id = ? AND materialized_resource_id = ?
             AND status = 'pending'`,
        ).run(revisionId, createdAt, projectId, resourceId)
        db.prepare(
          'UPDATE translation_projects SET updated_at = ? WHERE id = ?',
        ).run(nowAfter(project.updatedAt), projectId)
        recordIdempotentResult(
          'resource_reject',
          projectId,
          input.idempotencyKey,
          idempotencyRequest,
          revisionId,
          createdAt,
        )
      })()
      return {
        resource: mapResource(resource),
        revision: requireCurrentRevision(resourceId),
      }
    },
  }

  const snapshots = {
    list(projectId: string): ProjectSnapshot[] {
      requireProject(projectId)
      const rows = db
        .prepare(
          `SELECT * FROM project_snapshots
           WHERE project_id = ?
           ORDER BY revision_no DESC`,
        )
        .all(projectId) as SnapshotRow[]
      return rows.map((row) => mapSnapshot(row, db))
    },

    get: getSnapshot,

    getResources(
      projectId: string,
      snapshotId: string,
    ): FrozenProjectResource[] {
      requireProject(projectId)
      const snapshot = getSnapshot(projectId, snapshotId)
      if (!snapshot) {
        throw new ProjectRepositoryError(
          'snapshot_not_found',
          `Project snapshot ${snapshotId} was not found.`,
        )
      }
      return getFrozenSnapshotResources(projectId, snapshot)
    },
  }

  const suggestions = {
    list(
      projectId: string,
      filters: SuggestionListFilters = {},
    ): ProjectMemorySuggestion[] {
      requireProject(projectId)
      const rows = filters.status
        ? (db
            .prepare(
              `SELECT * FROM project_memory_suggestions
               WHERE project_id = ? AND status = ?
               ORDER BY created_at DESC, id`,
            )
            .all(projectId, filters.status) as SuggestionRow[])
        : (db
            .prepare(
              `SELECT * FROM project_memory_suggestions
               WHERE project_id = ?
               ORDER BY created_at DESC, id`,
            )
            .all(projectId) as SuggestionRow[])
      return rows.map(mapSuggestion)
    },

    get: getSuggestion,

    create(
      projectId: string,
      input: SuggestionCreateInput,
    ): ProjectMemorySuggestion {
      const project = requireProject(projectId)
      const idempotencyRequest = {
        kind: input.kind,
        content: input.content,
        source: input.source ?? null,
        scope: input.scope ?? null,
      }
      const priorSuggestionId = findIdempotentResult(
        'suggestion_create',
        projectId,
        input.idempotencyKey,
        idempotencyRequest,
      )
      if (priorSuggestionId) {
        return requireSuggestion(projectId, priorSuggestionId)
      }
      if (project.status !== 'active') {
        throw new ProjectRepositoryError(
          'project_archived',
          `Translation project ${projectId} is archived and read-only.`,
        )
      }
      const source = input.source ?? defaultSource()
      const scope = input.scope ?? defaultScope(project.direction)
      assertScopeMatchesProject(project, scope)
      validateSourceOwnership(projectId, source)
      assertContentMatchesKind(input.kind, input.content)
      assertProjectContentHasNoApiKey(db, {
        kind: input.kind,
        content: input.content,
        source,
        scope,
      })
      const id = randomUUID()
      const createdAt = nowAfter()
      db.transaction(() => {
        db.prepare(
          `INSERT INTO project_memory_suggestions (
            id, project_id, kind, content_json, source_json, scope_json,
            status, idempotency_key, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        ).run(
          id,
          projectId,
          input.kind,
          JSON.stringify(input.content),
          JSON.stringify(source),
          JSON.stringify(scope),
          input.idempotencyKey ?? null,
          createdAt,
        )
        db.prepare(
          'UPDATE translation_projects SET updated_at = ? WHERE id = ?',
        ).run(nowAfter(project.updatedAt), projectId)
        recordIdempotentResult(
          'suggestion_create',
          projectId,
          input.idempotencyKey,
          idempotencyRequest,
          id,
          createdAt,
        )
      })()
      return requireSuggestion(projectId, id)
    },
  }

  const sessionProjectContexts = {
    freezeForSession(input: SessionContextFreezeInput): SessionProjectContext {
      const parsed = sessionProjectContextFreezeSchema.safeParse(input)
      if (!parsed.success) {
        throw new ProjectRepositoryError(
          'validation_failed',
          parsed.error.message,
        )
      }
      const canonical = parsed.data
      const existing = db
        .prepare(
          'SELECT * FROM session_project_contexts WHERE session_id = ?',
        )
        .get(canonical.sessionId) as ContextRow | undefined
      const stableRevisionIds = [...canonical.resourceRevisionIds].sort()
      if (existing) {
        const mapped = mapContext(existing)
        if (
          mapped.projectId === canonical.projectId &&
          mapped.projectSnapshotId === canonical.projectSnapshotId &&
          mapped.direction === canonical.direction &&
          mapped.tokenEstimate === canonical.tokenEstimate &&
          JSON.stringify(mapped.resourceRevisionIds) ===
            JSON.stringify(stableRevisionIds)
        ) {
          return mapped
        }
        throw new ProjectRepositoryError(
          'context_already_frozen',
          `Session ${canonical.sessionId} already has a different frozen project context.`,
        )
      }

      const session = db
        .prepare(
          'SELECT id, direction, source_lang, target_lang FROM sessions WHERE id = ?',
        )
        .get(canonical.sessionId) as
        | {
            id: string
            direction: 'en_to_zh' | 'zh_to_en' | 'custom'
            source_lang: string
            target_lang: string
          }
        | undefined
      if (!session) {
        throw new ProjectRepositoryError(
          'session_not_found',
          `Session ${canonical.sessionId} was not found.`,
        )
      }
      const project = requireProject(canonical.projectId)
      if (
        project.direction !== canonical.direction ||
        session.direction !== canonical.direction
      ) {
        throw new ProjectRepositoryError(
          'direction_mismatch',
          'The session, project, and frozen context directions must match.',
        )
      }
      if (
        !isProjectDirectionCompatible({
          direction: session.direction,
          sourceLang: session.source_lang,
          targetLang: session.target_lang,
        })
      ) {
        throw new ProjectRepositoryError(
          'direction_mismatch',
          'The session languages are incompatible with its project direction.',
        )
      }
      if (
        project.direction === 'custom' &&
        (normalizedLanguageLabel(project.sourceLang) !==
          normalizedLanguageLabel(session.source_lang) ||
          normalizedLanguageLabel(project.targetLang) !==
            normalizedLanguageLabel(session.target_lang))
      ) {
        throw new ProjectRepositoryError(
          'direction_mismatch',
          'Custom project and session language pairs must match exactly.',
        )
      }
      const snapshot = getSnapshot(
        canonical.projectId,
        canonical.projectSnapshotId,
      )
      if (!snapshot) {
        throw new ProjectRepositoryError(
          'snapshot_not_found',
          `Project snapshot ${canonical.projectSnapshotId} was not found.`,
        )
      }
      const frozenResources = getFrozenSnapshotResources(
        canonical.projectId,
        snapshot,
        stableRevisionIds,
      )
      const estimatedTokens = estimateProjectContextTokens(frozenResources)
      if (canonical.tokenEstimate !== estimatedTokens) {
        throw new ProjectRepositoryError(
          'token_estimate_mismatch',
          `Project context token estimate must equal ${estimatedTokens}.`,
        )
      }
      const contextId = randomUUID()
      const createdAt = nowAfter()
      db.prepare(
        `INSERT INTO session_project_contexts (
          id, session_id, project_id, project_snapshot_id, direction,
          source_lang, target_lang, resource_revision_ids_json, resources_json,
          token_estimate, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        contextId,
        canonical.sessionId,
        canonical.projectId,
        canonical.projectSnapshotId,
        canonical.direction,
        project.sourceLang,
        project.targetLang,
        JSON.stringify(stableRevisionIds),
        JSON.stringify(frozenResources),
        canonical.tokenEstimate,
        createdAt,
      )
      return mapContext(
        db
          .prepare('SELECT * FROM session_project_contexts WHERE id = ?')
          .get(contextId) as ContextRow,
      )
    },

    getBySession(sessionId: string): SessionProjectContext | undefined {
      const row = db
        .prepare(
          'SELECT * FROM session_project_contexts WHERE session_id = ?',
        )
        .get(sessionId) as ContextRow | undefined
      return row ? mapContext(row) : undefined
    },

    listByProject(projectId: string): SessionProjectContext[] {
      requireProject(projectId)
      const rows = db
        .prepare(
          `SELECT * FROM session_project_contexts
           WHERE project_id = ?
           ORDER BY created_at DESC, id`,
        )
        .all(projectId) as ContextRow[]
      return rows.map(mapContext)
    },
  }

  return {
    projects,
    resources,
    snapshots,
    suggestions,
    sessionProjectContexts,
  }
}

export type ProjectRepositories = ReturnType<typeof createProjectRepositories>
