import { z } from 'zod'

export const translationToolReferenceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)

export const translationToolNameSchema = z.enum([
  'write_draft',
  'replace_text',
  'inspect_evidence',
  'search_project_memory',
  'request_review',
  'record_issue',
  'propose_patch',
])

export const translationToolStageSchema = z.enum([
  'team',
  'candidate',
  'draft',
  'review',
  'filter',
  'orchestrate',
  'assemble',
  'edit',
])

export const translationToolActorSchema = z.enum([
  'main_agent',
  'review_subagent',
  'user',
])

export const evidenceInheritanceModeSchema = z.enum([
  'body_only',
  'body_and_annotation',
])

export const translationToolStatusSchema = z.enum([
  'running',
  'complete',
  'failed',
  'cancelled',
])

export const translationToolDeterminismLevelSchema = z.enum([
  'local_deterministic',
  'seeded_best_effort',
  'provider_default',
  'not_applicable',
])

export const TRANSLATION_TOOL_SCHEMA_VERSION = 'translation-tools/v1'
export const TRANSLATION_TOOL_HANDLER_VERSION = 'translation-tool-runtime/v1'

export const reviewIssueCategorySchema = z.enum([
  'fidelity',
  'logic',
  'naturalness',
  'terminology',
  'style',
  'format',
  'task_constraint',
  'other',
])

export const reviewIssueSeveritySchema = z.enum([
  'low',
  'medium',
  'high',
  'critical',
])

export const reviewIssueStatusSchema = z.enum([
  'open',
  'resolved',
  'dismissed',
])

const nonBlankExactTextSchema = z
  .string()
  .min(1)
  .max(200_000)
  .refine((value) => value.trim().length > 0, 'Text must not be blank.')

const explanatoryTextSchema = z.string().trim().min(1).max(8_000)

export const evidenceIdListSchema = z
  .array(translationToolReferenceIdSchema)
  .min(1)
  .max(64)
  .superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: 'custom',
        message: 'Evidence IDs must be unique.',
      })
    }
  })

export const writeDraftArgsSchema = z
  .object({
    text: nonBlankExactTextSchema,
    reason: explanatoryTextSchema,
    evidenceInvocationIds: evidenceIdListSchema.min(2),
  })
  .strict()

export const replaceTextArgsSchema = z
  .object({
    old_string: nonBlankExactTextSchema,
    new_string: z.string().max(200_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.old_string === value.new_string) {
      context.addIssue({
        code: 'custom',
        path: ['new_string'],
        message: 'Replacement text must differ from the old text.',
      })
    }
  })

export const inspectEvidenceArgsSchema = z
  .object({
    evidenceIds: evidenceIdListSchema,
    inheritanceMode: evidenceInheritanceModeSchema,
  })
  .strict()

export const projectMemoryKindSchema = z.enum([
  'terminology',
  'style',
  'character',
  'fact',
  'example',
  'other',
])

export const searchProjectMemoryArgsSchema = z
  .object({
    query: z.string().trim().min(1).max(2_000),
    kinds: z.array(projectMemoryKindSchema).max(6).optional(),
    maxResults: z.number().int().min(1).max(20).default(8),
  })
  .strict()

export const requestReviewArgsSchema = z
  .object({
    segment: nonBlankExactTextSchema.max(20_000),
    question: explanatoryTextSchema,
    evidenceIds: evidenceIdListSchema,
  })
  .strict()

export const issueLocationSchema = z
  .object({
    quote: nonBlankExactTextSchema.max(20_000),
    startOffset: z.number().int().nonnegative().optional(),
    endOffset: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.startOffset !== undefined &&
      value.endOffset !== undefined &&
      value.endOffset <= value.startOffset
    ) {
      context.addIssue({
        code: 'custom',
        path: ['endOffset'],
        message: 'endOffset must be greater than startOffset.',
      })
    }
    if (
      (value.startOffset === undefined) !== (value.endOffset === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'startOffset and endOffset must be supplied together.',
      })
    }
  })

export const recordIssueArgsSchema = z
  .object({
    title: z.string().trim().min(1).max(240),
    details: explanatoryTextSchema,
    location: issueLocationSchema,
    category: reviewIssueCategorySchema,
    severity: reviewIssueSeveritySchema,
    evidenceIds: evidenceIdListSchema,
  })
  .strict()

export const proposePatchArgsSchema = z
  .object({
    baseVersionId: z.number().int().positive(),
    oldText: nonBlankExactTextSchema,
    replacement: z.string().max(200_000),
    reason: explanatoryTextSchema,
    evidenceIds: evidenceIdListSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.oldText === value.replacement) {
      context.addIssue({
        code: 'custom',
        path: ['replacement'],
        message: 'Replacement text must differ from the old text.',
      })
    }
  })

export const translationToolCallSchema = z.discriminatedUnion('name', [
  z.object({ name: z.literal('write_draft'), args: writeDraftArgsSchema }).strict(),
  z.object({ name: z.literal('replace_text'), args: replaceTextArgsSchema }).strict(),
  z
    .object({
      name: z.literal('inspect_evidence'),
      args: inspectEvidenceArgsSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal('search_project_memory'),
      args: searchProjectMemoryArgsSchema,
    })
    .strict(),
  z
    .object({ name: z.literal('request_review'), args: requestReviewArgsSchema })
    .strict(),
  z
    .object({ name: z.literal('record_issue'), args: recordIssueArgsSchema })
    .strict(),
  z
    .object({ name: z.literal('propose_patch'), args: proposePatchArgsSchema })
    .strict(),
])

export const translationToolExecutionContextSchema = z
  .object({
    sessionId: translationToolReferenceIdSchema,
    runId: translationToolReferenceIdSchema,
    invocationId: translationToolReferenceIdSchema.nullable().default(null),
    parentToolCallId: translationToolReferenceIdSchema.nullable().default(null),
    stage: translationToolStageSchema,
    actor: translationToolActorSchema,
    depth: z.number().int().min(0).max(1),
    allowedInheritanceMode: evidenceInheritanceModeSchema,
    knownEvidenceIds: z.array(translationToolReferenceIdSchema).optional(),
    baseVersion: z
      .object({
        id: z.number().int().positive(),
        text: z.string().max(400_000),
      })
      .strict()
      .nullable()
      .default(null),
    providerSeed: z.number().int().nullable().default(null),
    determinismLevel: translationToolDeterminismLevelSchema.default(
      'not_applicable',
    ),
  })
  .strict()

export const annotationMetadataSchema = z
  .object({
    source: z.string().trim().min(1).max(200),
    version: z.string().trim().min(1).max(80),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

const evidenceMaterialObjectSchema = z
  .object({
    evidenceId: translationToolReferenceIdSchema,
    sourceType: z.enum([
      'agent_invocation',
      'stage_output',
      'review_issue',
      'project_memory',
    ]),
    sourceId: translationToolReferenceIdSchema,
    raw: z.string(),
    body: z.string(),
    annotation: z.string().nullable(),
    annotationMetadata: annotationMetadataSchema.nullable(),
  })
  .strict()

export const evidenceMaterialSchema = evidenceMaterialObjectSchema
  .superRefine((value, context) => {
    if ((value.annotation !== null) !== (value.annotationMetadata !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['annotationMetadata'],
        message: 'Annotation source, version, and hash accompany every annotation.',
      })
    }
  })

// Select from the unrefined object; Zod intentionally disallows pick() on
// schemas with refinements.
export const bodyOnlyEvidenceItemSchema = evidenceMaterialObjectSchema
  .pick({ evidenceId: true, sourceType: true, sourceId: true, body: true })
  .strict()

export const bodyAndAnnotationEvidenceItemSchema = evidenceMaterialSchema

export const evidenceInspectionResultSchema = z.discriminatedUnion(
  'inheritanceMode',
  [
    z
      .object({
        inheritanceMode: z.literal('body_only'),
        items: z.array(bodyOnlyEvidenceItemSchema),
      })
      .strict(),
    z
      .object({
        inheritanceMode: z.literal('body_and_annotation'),
        items: z.array(bodyAndAnnotationEvidenceItemSchema),
      })
      .strict(),
  ],
)

export const projectMemorySearchResultSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: translationToolReferenceIdSchema,
          kind: projectMemoryKindSchema,
          title: z.string().max(500),
          content: z.string().max(100_000),
          score: z.number().finite().min(0).max(1).nullable().default(null),
          revisionId: translationToolReferenceIdSchema.nullable().default(null),
        })
        .strict(),
    ),
  })
  .strict()

export const requestReviewResultSchema = z
  .object({
    reviewInvocationId: translationToolReferenceIdSchema,
    evidence: evidenceInspectionResultSchema,
  })
  .strict()

export const recordIssueResultSchema = z
  .object({
    issueId: translationToolReferenceIdSchema,
    status: z.literal('open'),
  })
  .strict()

export const proposePatchResultSchema = z
  .object({
    proposalId: translationToolReferenceIdSchema,
    status: z.literal('proposed'),
  })
  .strict()

export const writeDraftResultSchema = z
  .object({
    versionId: z.number().int().positive(),
    versionNo: z.number().int().positive(),
  })
  .strict()

export const replaceTextResultSchema = z
  .object({
    newText: z.string().max(400_000),
    diffSummary: z.string().max(20_000),
  })
  .strict()

export const translationToolResultSchema = z.union([
  evidenceInspectionResultSchema,
  projectMemorySearchResultSchema,
  requestReviewResultSchema,
  recordIssueResultSchema,
  proposePatchResultSchema,
  writeDraftResultSchema,
  replaceTextResultSchema,
])

export const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
)

const timestampSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)),
  'Expected an ISO-compatible timestamp.',
)

const toolErrorCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9._:-]*$/)

export const agentToolCallRecordSchema = z
  .object({
    id: translationToolReferenceIdSchema,
    sessionId: translationToolReferenceIdSchema.nullable(),
    runId: translationToolReferenceIdSchema.nullable(),
    invocationId: translationToolReferenceIdSchema.nullable(),
    parentToolCallId: translationToolReferenceIdSchema.nullable(),
    providerToolCallId: z.string().min(1).max(256).nullable(),
    logicalCallKey: z.string().min(1).max(200).nullable(),
    stage: translationToolStageSchema,
    actor: translationToolActorSchema,
    depth: z.number().int().min(0).max(1),
    toolName: translationToolNameSchema,
    schemaVersion: z.string().min(1).max(80),
    handlerVersion: z.string().min(1).max(80),
    input: jsonValueSchema,
    output: jsonValueSchema.nullable(),
    inputSummary: z.string().max(500),
    outputSummary: z.string().max(500).nullable(),
    status: translationToolStatusSchema,
    errorCode: toolErrorCodeSchema.nullable(),
    errorMessage: z.string().nullable(),
    evidenceIds: z.array(translationToolReferenceIdSchema),
    providerSeed: z.number().int().nullable(),
    determinismLevel: translationToolDeterminismLevelSchema,
    baseVersionId: z.number().int().positive().nullable(),
    oldTextHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    oldTextLength: z.number().int().nonnegative().nullable(),
    replacementHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    replacementLength: z.number().int().nonnegative().nullable(),
    startedAt: timestampSchema,
    completedAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const terminal = value.status !== 'running'
    if (terminal !== (value.completedAt !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'Only terminal tool calls have a completed timestamp.',
      })
    }
    const failed = value.status === 'failed' || value.status === 'cancelled'
    if (failed !== (value.errorCode !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['errorCode'],
        message: 'Failed or cancelled calls require an error code.',
      })
    }
    if (!failed && value.errorMessage !== null) {
      context.addIssue({
        code: 'custom',
        path: ['errorMessage'],
        message: 'Successful or running calls cannot carry an error message.',
      })
    }
    if (value.status === 'complete' !== (value.output !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['output'],
        message: 'Only completed calls carry a result.',
      })
    }
    const patchMetadata = [
      value.baseVersionId,
      value.oldTextHash,
      value.oldTextLength,
      value.replacementHash,
      value.replacementLength,
    ]
    if (
      value.toolName === 'propose_patch' !==
      patchMetadata.every((item) => item !== null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['oldTextHash'],
        message: 'Only propose_patch records carry complete exact-match metadata.',
      })
    }
  })

export const reviewIssueRecordSchema = z
  .object({
    id: translationToolReferenceIdSchema,
    sessionId: translationToolReferenceIdSchema.nullable(),
    runId: translationToolReferenceIdSchema.nullable(),
    invocationId: translationToolReferenceIdSchema.nullable(),
    sourceToolCallId: translationToolReferenceIdSchema.nullable(),
    stage: translationToolStageSchema,
    title: z.string().min(1).max(240),
    details: z.string().min(1).max(8_000),
    location: issueLocationSchema,
    category: reviewIssueCategorySchema,
    severity: reviewIssueSeveritySchema,
    status: reviewIssueStatusSchema,
    evidenceIds: z.array(translationToolReferenceIdSchema),
    resolution: z.string().nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    resolvedAt: timestampSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.status === 'open') !== (value.resolvedAt === null)) {
      context.addIssue({
        code: 'custom',
        path: ['resolvedAt'],
        message: 'Only resolved or dismissed issues have a resolved timestamp.',
      })
    }
    if (value.status === 'open' && value.resolution !== null) {
      context.addIssue({
        code: 'custom',
        path: ['resolution'],
        message: 'Open issues cannot carry a resolution.',
      })
    }
  })

export type TranslationToolReferenceId = z.infer<
  typeof translationToolReferenceIdSchema
>
export type TranslationToolName = z.infer<typeof translationToolNameSchema>
export type TranslationToolStage = z.infer<typeof translationToolStageSchema>
export type TranslationToolActor = z.infer<typeof translationToolActorSchema>
export type EvidenceInheritanceMode = z.infer<
  typeof evidenceInheritanceModeSchema
>
export type TranslationToolCall = z.infer<typeof translationToolCallSchema>
export type TranslationToolExecutionContext = z.infer<
  typeof translationToolExecutionContextSchema
>
export type EvidenceMaterial = z.infer<typeof evidenceMaterialSchema>
export type EvidenceInspectionResult = z.infer<
  typeof evidenceInspectionResultSchema
>
export type ProjectMemorySearchResult = z.infer<
  typeof projectMemorySearchResultSchema
>
export type RequestReviewResult = z.infer<typeof requestReviewResultSchema>
export type AgentToolCallRecord = z.infer<typeof agentToolCallRecordSchema>
export type ReviewIssueRecord = z.infer<typeof reviewIssueRecordSchema>
export type ReviewIssueStatus = z.infer<typeof reviewIssueStatusSchema>
