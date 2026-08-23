import { createHash, randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import {
  agentToolCallRecordSchema,
  issueLocationSchema,
  jsonValueSchema,
  proposePatchArgsSchema,
  reviewIssueCategorySchema,
  reviewIssueRecordSchema,
  reviewIssueSeveritySchema,
  reviewIssueStatusSchema,
  translationToolActorSchema,
  translationToolDeterminismLevelSchema,
  translationToolNameSchema,
  translationToolReferenceIdSchema,
  translationToolStageSchema,
  TRANSLATION_TOOL_HANDLER_VERSION,
  TRANSLATION_TOOL_SCHEMA_VERSION,
  type AgentToolCallRecord,
  type ReviewIssueRecord,
  type ReviewIssueStatus,
  type TranslationToolActor,
  type TranslationToolName,
  type TranslationToolStage,
} from '../contracts/translation-tools'
import { assertProjectContentHasNoApiKey } from './project-repositories'
import { safeErrorMessageForPersistence } from '../security/credential-redaction'

interface AgentToolCallRow {
  id: string
  session_id: string | null
  run_id: string | null
  invocation_id: string | null
  parent_tool_call_id: string | null
  provider_tool_call_id: string | null
  logical_call_key: string | null
  stage: TranslationToolStage
  actor: TranslationToolActor
  depth: number
  schema_version: string
  handler_version: string
  tool_name: TranslationToolName
  input_json: string
  output_json: string | null
  input_summary: string
  output_summary: string | null
  status: 'running' | 'complete' | 'failed' | 'cancelled'
  error_code: string | null
  error_message: string | null
  evidence_ids_json: string
  provider_seed: number | null
  determinism_level: z.infer<typeof translationToolDeterminismLevelSchema>
  base_version_id: number | null
  old_text_hash: string | null
  old_text_length: number | null
  replacement_hash: string | null
  replacement_length: number | null
  started_at: string
  completed_at: string | null
  created_at: string
  updated_at: string
}

interface ReviewIssueRow {
  id: string
  session_id: string | null
  run_id: string | null
  invocation_id: string | null
  source_tool_call_id: string | null
  stage: TranslationToolStage
  title: string
  details: string
  location_json: string
  category: z.infer<typeof reviewIssueCategorySchema>
  severity: z.infer<typeof reviewIssueSeveritySchema>
  status: ReviewIssueStatus
  evidence_ids_json: string
  resolution: string | null
  resolved_at: string | null
  created_at: string
  updated_at: string
}

const evidenceIdsSchema = z
  .array(translationToolReferenceIdSchema)
  .max(128)
  .superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', message: 'Evidence IDs must be unique.' })
    }
  })

const errorCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9._:-]*$/)

export type TranslationToolRepositoryErrorCode =
  | 'call_not_found'
  | 'issue_not_found'
  | 'invalid_transition'
  | 'invalid_stored_data'
  | 'validation_failed'

export class TranslationToolRepositoryError extends Error {
  constructor(
    public readonly code: TranslationToolRepositoryErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'TranslationToolRepositoryError'
  }
}

export interface BeginAgentToolCallInput {
  id?: string
  sessionId: string
  runId: string
  invocationId?: string | null
  parentToolCallId?: string | null
  providerToolCallId?: string | null
  logicalCallKey?: string | null
  stage: TranslationToolStage
  actor: TranslationToolActor
  depth: number
  toolName: TranslationToolName
  arguments: unknown
  evidenceIds?: string[]
  schemaVersion?: string
  handlerVersion?: string
  providerSeed?: number | null
  determinismLevel?: z.infer<typeof translationToolDeterminismLevelSchema>
}

export interface CompleteAgentToolCallInput {
  result: unknown
  evidenceIds?: string[]
}

export interface FailAgentToolCallInput {
  status?: 'failed' | 'cancelled'
  errorCode: string
  errorMessage?: string | null
  evidenceIds?: string[]
}

export interface AgentToolCallFilters {
  sessionId?: string
  runId?: string
  invocationId?: string
  parentToolCallId?: string
  stage?: TranslationToolStage
  toolName?: TranslationToolName
  status?: AgentToolCallRecord['status']
}

export interface CreateReviewIssueInput {
  id?: string
  sessionId: string
  runId: string
  invocationId?: string | null
  sourceToolCallId?: string | null
  stage: TranslationToolStage
  title: string
  details: string
  location: z.input<typeof issueLocationSchema>
  category: z.infer<typeof reviewIssueCategorySchema>
  severity: z.infer<typeof reviewIssueSeveritySchema>
  evidenceIds: string[]
}

export interface ReviewIssueFilters {
  sessionId?: string
  runId?: string
  invocationId?: string
  sourceToolCallId?: string
  stage?: TranslationToolStage
  status?: ReviewIssueStatus
  category?: z.infer<typeof reviewIssueCategorySchema>
  severity?: z.infer<typeof reviewIssueSeveritySchema>
}

function encodeJson(db: Database.Database, value: unknown): string {
  assertProjectContentHasNoApiKey(db, value)
  const parsed = jsonValueSchema.safeParse(value)
  if (!parsed.success) {
    throw new TranslationToolRepositoryError(
      'validation_failed',
      `Value is not JSON-safe: ${z.prettifyError(parsed.error)}`,
      parsed.error,
    )
  }
  return JSON.stringify(parsed.data)
}

function summarizeJson(label: string, value: unknown): string {
  if (Array.isArray(value)) return `${label}: array(${value.length})`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    return `${label}: object(${keys.join(',')})`.slice(0, 500)
  }
  return `${label}: ${value === null ? 'null' : typeof value}`
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
    throw new TranslationToolRepositoryError(
      'invalid_stored_data',
      `${label} is not valid JSON.`,
      error,
    )
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new TranslationToolRepositoryError(
      'invalid_stored_data',
      `${label} failed persisted-data validation.`,
      parsed.error,
    )
  }
  return parsed.data
}

function parseReference(value: string, label: string): string {
  const parsed = translationToolReferenceIdSchema.safeParse(value)
  if (!parsed.success) {
    throw new TranslationToolRepositoryError(
      'validation_failed',
      `${label} is invalid.`,
      parsed.error,
    )
  }
  return parsed.data
}

function parseEvidenceIds(value: string[], label: string): string[] {
  const parsed = evidenceIdsSchema.safeParse(value)
  if (!parsed.success) {
    throw new TranslationToolRepositoryError(
      'validation_failed',
      `${label} are invalid.`,
      parsed.error,
    )
  }
  return parsed.data
}

function mapToolCall(row: AgentToolCallRow | undefined): AgentToolCallRecord | null {
  if (!row) return null
  try {
    return agentToolCallRecordSchema.parse({
      id: row.id,
      sessionId: row.session_id,
      runId: row.run_id,
      invocationId: row.invocation_id,
      parentToolCallId: row.parent_tool_call_id,
      providerToolCallId: row.provider_tool_call_id,
      logicalCallKey: row.logical_call_key,
      stage: row.stage,
      actor: row.actor,
      depth: row.depth,
      schemaVersion: row.schema_version,
      handlerVersion: row.handler_version,
      toolName: row.tool_name,
      input: parseJson(
        `agent_tool_calls(${row.id}).input_json`,
        row.input_json,
        jsonValueSchema,
      ),
      output:
        row.output_json === null
          ? null
          : parseJson(
              `agent_tool_calls(${row.id}).output_json`,
              row.output_json,
              jsonValueSchema,
            ),
      inputSummary: row.input_summary,
      outputSummary: row.output_summary,
      status: row.status,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      evidenceIds: parseJson(
        `agent_tool_calls(${row.id}).evidence_ids_json`,
        row.evidence_ids_json,
        evidenceIdsSchema,
      ),
      providerSeed: row.provider_seed,
      determinismLevel: row.determinism_level,
      baseVersionId: row.base_version_id,
      oldTextHash: row.old_text_hash,
      oldTextLength: row.old_text_length,
      replacementHash: row.replacement_hash,
      replacementLength: row.replacement_length,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })
  } catch (error) {
    if (error instanceof TranslationToolRepositoryError) throw error
    throw new TranslationToolRepositoryError(
      'invalid_stored_data',
      `agent_tool_calls(${row.id}) contains invalid persisted data.`,
      error,
    )
  }
}

function mapReviewIssue(row: ReviewIssueRow | undefined): ReviewIssueRecord | null {
  if (!row) return null
  try {
    return reviewIssueRecordSchema.parse({
      id: row.id,
      sessionId: row.session_id,
      runId: row.run_id,
      invocationId: row.invocation_id,
      sourceToolCallId: row.source_tool_call_id,
      stage: row.stage,
      title: row.title,
      details: row.details,
      location: parseJson(
        `review_issues(${row.id}).location_json`,
        row.location_json,
        issueLocationSchema,
      ),
      category: row.category,
      severity: row.severity,
      status: row.status,
      evidenceIds: parseJson(
        `review_issues(${row.id}).evidence_ids_json`,
        row.evidence_ids_json,
        evidenceIdsSchema,
      ),
      resolution: row.resolution,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at,
    })
  } catch (error) {
    if (error instanceof TranslationToolRepositoryError) throw error
    throw new TranslationToolRepositoryError(
      'invalid_stored_data',
      `review_issues(${row.id}) contains invalid persisted data.`,
      error,
    )
  }
}

function requireChanged(
  db: Database.Database,
  table: 'agent_tool_calls' | 'review_issues',
  id: string,
  changes: number,
): void {
  if (changes > 0) return
  const row = db.prepare(`SELECT status FROM ${table} WHERE id = ?`).get(id) as
    | { status: string }
    | undefined
  if (!row) {
    throw new TranslationToolRepositoryError(
      table === 'agent_tool_calls' ? 'call_not_found' : 'issue_not_found',
      `${table} record ${id} was not found.`,
    )
  }
  throw new TranslationToolRepositoryError(
    'invalid_transition',
    `${table} record ${id} cannot transition from ${row.status}.`,
  )
}

export function createTranslationToolRepository(db: Database.Database) {
  const getCallStatement = db.prepare(
    'SELECT * FROM agent_tool_calls WHERE id = ?',
  )
  const getIssueStatement = db.prepare('SELECT * FROM review_issues WHERE id = ?')

  const beginCall = (input: BeginAgentToolCallInput): AgentToolCallRecord => {
    const id = input.id ? parseReference(input.id, 'Tool call ID') : randomUUID()
    const sessionId = parseReference(input.sessionId, 'Session ID')
    const runId = parseReference(input.runId, 'Run ID')
    const invocationId = input.invocationId
      ? parseReference(input.invocationId, 'Invocation ID')
      : null
    const parentToolCallId = input.parentToolCallId
      ? parseReference(input.parentToolCallId, 'Parent tool call ID')
      : null
    const providerToolCallId = input.providerToolCallId == null
      ? null
      : z.string().min(1).max(256).parse(input.providerToolCallId)
    const logicalCallKey = input.logicalCallKey == null
      ? null
      : z.string().min(1).max(200).parse(input.logicalCallKey)
    const stage = translationToolStageSchema.parse(input.stage)
    const actor = translationToolActorSchema.parse(input.actor)
    const toolName = translationToolNameSchema.parse(input.toolName)
    const depth = z.number().int().min(0).max(1).parse(input.depth)
    const evidenceIds = parseEvidenceIds(input.evidenceIds ?? [], 'Evidence IDs')
    const schemaVersion = z.string().trim().min(1).max(80).parse(
      input.schemaVersion ?? TRANSLATION_TOOL_SCHEMA_VERSION,
    )
    const handlerVersion = z.string().trim().min(1).max(80).parse(
      input.handlerVersion ?? TRANSLATION_TOOL_HANDLER_VERSION,
    )
    const providerSeed = input.providerSeed ?? null
    const determinismLevel = translationToolDeterminismLevelSchema.parse(
      input.determinismLevel ??
        (providerSeed === null ? 'not_applicable' : 'seeded_best_effort'),
    )
    if (
      (providerSeed === null && determinismLevel === 'seeded_best_effort') ||
      (providerSeed !== null && determinismLevel !== 'seeded_best_effort')
    ) {
      throw new TranslationToolRepositoryError(
        'validation_failed',
        'Provider seed and determinism level are inconsistent.',
      )
    }
    const patch = toolName === 'propose_patch'
      ? proposePatchArgsSchema.parse(input.arguments)
      : null
    const inputJson = encodeJson(db, input.arguments)
    if (logicalCallKey !== null) {
      const existing = db.prepare(`
        SELECT * FROM agent_tool_calls
        WHERE run_id=? AND logical_call_key=?
      `).get(runId, logicalCallKey) as AgentToolCallRow | undefined
      if (existing) {
        if (
          existing.session_id !== sessionId ||
          existing.tool_name !== toolName ||
          existing.invocation_id !== invocationId ||
          existing.parent_tool_call_id !== parentToolCallId ||
          existing.stage !== stage ||
          existing.actor !== actor ||
          existing.depth !== depth ||
          existing.input_json !== inputJson
        ) {
          throw new TranslationToolRepositoryError(
            'invalid_transition',
            `Logical tool call ${logicalCallKey} conflicts with its persisted replay input.`,
          )
        }
        return mapToolCall(existing)!
      }
    }
    db.prepare(`
      INSERT INTO agent_tool_calls (
        id, session_id, run_id, invocation_id, parent_tool_call_id,
        provider_tool_call_id, logical_call_key,
        stage, actor, depth, schema_version, handler_version, tool_name,
        input_json, input_summary, evidence_ids_json, provider_seed,
        determinism_level, base_version_id, old_text_hash, old_text_length,
        replacement_hash, replacement_length, status
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'running'
      )
    `).run(
      id,
      sessionId,
      runId,
      invocationId,
      parentToolCallId,
      providerToolCallId,
      logicalCallKey,
      stage,
      actor,
      depth,
      schemaVersion,
      handlerVersion,
      toolName,
      inputJson,
      summarizeJson(`${toolName} input`, input.arguments),
      JSON.stringify(evidenceIds),
      providerSeed,
      determinismLevel,
      patch?.baseVersionId ?? null,
      patch
        ? createHash('sha256').update(patch.oldText).digest('hex')
        : null,
      patch?.oldText.length ?? null,
      patch
        ? createHash('sha256').update(patch.replacement).digest('hex')
        : null,
      patch?.replacement.length ?? null,
    )
    return getCall(id)!
  }

  const getCall = (id: string): AgentToolCallRecord | null =>
    mapToolCall(getCallStatement.get(id) as AgentToolCallRow | undefined)

  const completeCall = (
    id: string,
    input: CompleteAgentToolCallInput,
  ): AgentToolCallRecord => {
    if (input.result === null || input.result === undefined) {
      throw new TranslationToolRepositoryError(
        'validation_failed',
        'Completed translation tool calls require a replayable output.',
      )
    }
    const result = db.prepare(`
      UPDATE agent_tool_calls
      SET status = 'complete', output_json = ?, output_summary = ?,
          evidence_ids_json = COALESCE(?, evidence_ids_json),
          error_code = NULL, error_message = NULL,
          completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND status = 'running'
    `).run(
      encodeJson(db, input.result),
      summarizeJson('tool output', input.result),
      input.evidenceIds === undefined
        ? null
        : JSON.stringify(parseEvidenceIds(input.evidenceIds, 'Evidence IDs')),
      id,
    )
    requireChanged(db, 'agent_tool_calls', id, result.changes)
    return getCall(id)!
  }

  const failCall = (
    id: string,
    input: FailAgentToolCallInput,
  ): AgentToolCallRecord => {
    const status = z.enum(['failed', 'cancelled']).parse(input.status ?? 'failed')
    const errorCode = errorCodeSchema.parse(input.errorCode)
    const errorMessage = input.errorMessage == null
      ? null
      : safeErrorMessageForPersistence(db, input.errorMessage)
    const result = db.prepare(`
      UPDATE agent_tool_calls
      SET status = ?, output_json = NULL, output_summary = NULL,
          evidence_ids_json = COALESCE(?, evidence_ids_json),
          error_code = ?, error_message = ?,
          completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND status = 'running'
    `).run(
      status,
      input.evidenceIds === undefined
        ? null
        : JSON.stringify(parseEvidenceIds(input.evidenceIds, 'Evidence IDs')),
      errorCode,
      errorMessage,
      id,
    )
    requireChanged(db, 'agent_tool_calls', id, result.changes)
    return getCall(id)!
  }

  const listCalls = (
    filters: AgentToolCallFilters = {},
  ): AgentToolCallRecord[] => {
    const clauses: string[] = []
    const parameters: Record<string, string> = {}
    const add = (column: string, key: string, value: string | undefined) => {
      if (value === undefined) return
      clauses.push(`${column} = @${key}`)
      parameters[key] = value
    }
    add('session_id', 'session_id', filters.sessionId)
    add('run_id', 'run_id', filters.runId)
    add('invocation_id', 'invocation_id', filters.invocationId)
    add('parent_tool_call_id', 'parent_tool_call_id', filters.parentToolCallId)
    add('stage', 'stage', filters.stage)
    add('tool_name', 'tool_name', filters.toolName)
    add('status', 'status', filters.status)
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const statement = db.prepare(
      `SELECT * FROM agent_tool_calls ${where} ORDER BY created_at, id`,
    )
    const rows = Object.keys(parameters).length > 0
      ? statement.all(parameters)
      : statement.all()
    return (rows as AgentToolCallRow[]).map((row) => mapToolCall(row)!)
  }

  const countReviewRequests = (input: {
    sessionId: string
    runId: string
    stage: TranslationToolStage
  }): number => {
    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM agent_tool_calls
      WHERE session_id = ? AND run_id = ? AND stage = ?
        AND tool_name = 'request_review'
    `).get(input.sessionId, input.runId, input.stage) as { count: number }
    return row.count
  }

  const createIssue = (input: CreateReviewIssueInput): ReviewIssueRecord => {
    const id = input.id ? parseReference(input.id, 'Issue ID') : randomUUID()
    assertProjectContentHasNoApiKey(db, input)
    const evidenceIds = parseEvidenceIds(input.evidenceIds, 'Evidence IDs')
    const location = issueLocationSchema.parse(input.location)
    db.prepare(`
      INSERT INTO review_issues (
        id, session_id, run_id, invocation_id, source_tool_call_id, stage,
        title, details, location_json, category, severity, status,
        evidence_ids_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
    `).run(
      id,
      parseReference(input.sessionId, 'Session ID'),
      parseReference(input.runId, 'Run ID'),
      input.invocationId
        ? parseReference(input.invocationId, 'Invocation ID')
        : null,
      input.sourceToolCallId
        ? parseReference(input.sourceToolCallId, 'Source tool call ID')
        : null,
      translationToolStageSchema.parse(input.stage),
      z.string().trim().min(1).max(240).parse(input.title),
      z.string().trim().min(1).max(8_000).parse(input.details),
      JSON.stringify(location),
      reviewIssueCategorySchema.parse(input.category),
      reviewIssueSeveritySchema.parse(input.severity),
      JSON.stringify(evidenceIds),
    )
    return getIssue(id)!
  }

  const getIssue = (id: string): ReviewIssueRecord | null =>
    mapReviewIssue(getIssueStatement.get(id) as ReviewIssueRow | undefined)

  const updateIssueStatus = (input: {
    id: string
    status: ReviewIssueStatus
    resolution?: string | null
  }): ReviewIssueRecord => {
    const status = reviewIssueStatusSchema.parse(input.status)
    const resolution =
      input.resolution === undefined || input.resolution === null
        ? null
        : z.string().trim().min(1).max(8_000).parse(input.resolution)
    if (resolution !== null) assertProjectContentHasNoApiKey(db, resolution)
    const result = db.prepare(`
      UPDATE review_issues
      SET status = ?, resolution = ?,
          resolved_at = CASE
            WHEN ? = 'open' THEN NULL
            ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          END,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND status <> ?
    `).run(status, status === 'open' ? null : resolution, status, input.id, status)
    requireChanged(db, 'review_issues', input.id, result.changes)
    return getIssue(input.id)!
  }

  const listIssues = (
    filters: ReviewIssueFilters = {},
  ): ReviewIssueRecord[] => {
    const clauses: string[] = []
    const parameters: Record<string, string> = {}
    const add = (column: string, key: string, value: string | undefined) => {
      if (value === undefined) return
      clauses.push(`${column} = @${key}`)
      parameters[key] = value
    }
    add('session_id', 'session_id', filters.sessionId)
    add('run_id', 'run_id', filters.runId)
    add('invocation_id', 'invocation_id', filters.invocationId)
    add('source_tool_call_id', 'source_tool_call_id', filters.sourceToolCallId)
    add('stage', 'stage', filters.stage)
    add('status', 'status', filters.status)
    add('category', 'category', filters.category)
    add('severity', 'severity', filters.severity)
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const statement = db.prepare(
      `SELECT * FROM review_issues ${where} ORDER BY created_at, id`,
    )
    const rows = Object.keys(parameters).length > 0
      ? statement.all(parameters)
      : statement.all()
    return (rows as ReviewIssueRow[]).map((row) => mapReviewIssue(row)!)
  }

  return {
    runAtomically: <T>(operation: () => T): T => db.transaction(operation)(),
    beginCall,
    getCall,
    completeCall,
    failCall,
    listCalls,
    countReviewRequests,
    createIssue,
    getIssue,
    updateIssueStatus,
    listIssues,
  }
}

export type TranslationToolRepository = ReturnType<
  typeof createTranslationToolRepository
>
