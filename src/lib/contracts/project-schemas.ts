import { z } from 'zod'
import type { TranslationDirection } from './vnext'

export const projectDirectionSchema = z.enum([
  'en_to_zh',
  'zh_to_en',
  'custom',
])

export const projectResourceKindSchema = z.enum([
  'term',
  'proper_noun',
  'character_voice',
  'style_rule',
  'approved_decision',
  'context_note',
  'parallel_excerpt',
  'counterexample',
])

export const projectResourceRevisionStatusSchema = z.enum([
  'suggested',
  'approved',
  'rejected',
  'retired',
])

export const projectSuggestionStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
])

const nullableText = (max: number) =>
  z.string().trim().max(max).nullable().default(null)

export const projectResourceContentSchema = z
  .object({
    sourceText: nullableText(200_000),
    targetText: nullableText(200_000),
    instruction: nullableText(100_000),
    note: z.string().trim().max(20_000).default(''),
  })
  .strict()

export const projectResourceSourceSchema = z
  .object({
    type: z.enum([
      'user',
      'session_patch',
      'disagreement_decision',
      'agent_suggestion',
      'import',
    ]),
    sessionId: z.string().trim().min(1).max(200).nullable().default(null),
    referenceId: z.string().trim().min(1).max(200).nullable().default(null),
    note: z.string().trim().max(20_000).default(''),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.type === 'session_patch' ||
        value.type === 'disagreement_decision' ||
        value.type === 'agent_suggestion') &&
      (!value.sessionId || !value.referenceId)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['referenceId'],
        message: `${value.type} sources require sessionId and referenceId.`,
      })
    }
    if (value.type === 'user' && (value.sessionId || value.referenceId)) {
      context.addIssue({
        code: 'custom',
        path: ['sessionId'],
        message: 'User-authored sources cannot claim an audit reference.',
      })
    }
    if (value.type === 'import' && value.sessionId) {
      context.addIssue({
        code: 'custom',
        path: ['sessionId'],
        message: 'Imported sources cannot claim a session reference.',
      })
    }
  })

export const projectResourceScopeSchema = z
  .object({
    direction: projectDirectionSchema,
    level: z.enum(['project', 'document', 'character']).default('project'),
    selector: z.string().trim().min(1).max(2_000).nullable().default(null),
    pinned: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.level === 'project' && value.selector !== null) {
      context.addIssue({
        code: 'custom',
        path: ['selector'],
        message: 'Project-wide scope cannot have a selector.',
      })
    }
    if (value.level !== 'project' && value.selector === null) {
      context.addIssue({
        code: 'custom',
        path: ['selector'],
        message: 'Document and character scopes require a selector.',
      })
    }
  })

export const projectResourceRevisionSchema = z
  .object({
    id: z.string().uuid(),
    resourceId: z.string().uuid(),
    revisionNo: z.number().int().positive(),
    kind: projectResourceKindSchema,
    content: projectResourceContentSchema,
    status: projectResourceRevisionStatusSchema,
    source: projectResourceSourceSchema,
    scope: projectResourceScopeSchema,
    createdAt: z.string().min(1),
  })
  .strict()

export const projectSnapshotRevisionIdsSchema = z
  .array(z.string().uuid())
  .max(100_000)
  .superRefine((value, context) => {
    if (new Set(value).size !== value.length) {
      context.addIssue({
        code: 'custom',
        message: 'Snapshot resource revision IDs must be unique.',
      })
    }
    const sorted = [...value].sort()
    if (value.some((id, index) => id !== sorted[index])) {
      context.addIssue({
        code: 'custom',
        message: 'Snapshot resource revision IDs must use stable sort order.',
      })
    }
  })

export const frozenProjectResourceSchema = z
  .object({
    resourceId: z.string().uuid(),
    revision: projectResourceRevisionSchema,
  })
  .strict()

export const frozenProjectResourcesSchema = z.array(frozenProjectResourceSchema)

const idempotencyKeySchema = z.string().trim().min(8).max(200)
const uuidSchema = z.string().uuid()
const isoDateSchema = z.string().datetime({ offset: true })

function languageFamily(value: string): 'en' | 'zh' | null {
  const normalized = value.trim().toLowerCase().replaceAll('_', '-')
  if (
    normalized === 'en' ||
    normalized.startsWith('en-') ||
    normalized === 'english' ||
    normalized === '英文' ||
    normalized === '英语'
  ) {
    return 'en'
  }
  if (
    normalized === 'zh' ||
    normalized.startsWith('zh-') ||
    normalized === 'chinese' ||
    normalized === '中文' ||
    normalized === '汉语' ||
    normalized === '漢語' ||
    normalized === '简体中文' ||
    normalized === '繁體中文'
  ) {
    return 'zh'
  }
  return null
}

export function isProjectDirectionCompatible(input: {
  direction: TranslationDirection
  sourceLang: string
  targetLang: string
}): boolean {
  if (input.direction === 'en_to_zh') {
    return (
      languageFamily(input.sourceLang) === 'en' &&
      languageFamily(input.targetLang) === 'zh'
    )
  }
  if (input.direction === 'zh_to_en') {
    return (
      languageFamily(input.sourceLang) === 'zh' &&
      languageFamily(input.targetLang) === 'en'
    )
  }
  return (
    input.sourceLang.trim().length > 0 &&
    input.targetLang.trim().length > 0 &&
    input.sourceLang.trim().toLocaleLowerCase() !==
      input.targetLang.trim().toLocaleLowerCase()
  )
}

export function isScopeDirectionCompatible(
  projectDirection: TranslationDirection,
  scopeDirection: TranslationDirection,
): boolean {
  return projectDirection === scopeDirection
}

export function validateProjectResourceContent(
  kind: z.infer<typeof projectResourceKindSchema>,
  content: z.infer<typeof projectResourceContentSchema>,
): string | null {
  const hasSource = Boolean(content.sourceText?.trim())
  const hasTarget = Boolean(content.targetText?.trim())
  const hasInstruction = Boolean(content.instruction?.trim())

  if (
    (kind === 'term' ||
      kind === 'proper_noun' ||
      kind === 'parallel_excerpt') &&
    (!hasSource || !hasTarget)
  ) {
    return `${kind} content requires sourceText and targetText.`
  }
  if (kind === 'character_voice' && (!hasSource || !hasInstruction)) {
    return 'character_voice content requires sourceText and instruction.'
  }
  if (
    (kind === 'style_rule' ||
      kind === 'approved_decision' ||
      kind === 'context_note' ||
      kind === 'counterexample') &&
    !hasInstruction
  ) {
    return `${kind} content requires instruction.`
  }
  return null
}

function addContentIssue(
  value: {
    kind: z.infer<typeof projectResourceKindSchema>
    content: z.infer<typeof projectResourceContentSchema>
  },
  context: z.RefinementCtx,
) {
  const message = validateProjectResourceContent(value.kind, value.content)
  if (message) {
    context.addIssue({ code: 'custom', path: ['content'], message })
  }
}

export const projectCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(20_000).default(''),
    direction: projectDirectionSchema,
    sourceLang: z.string().trim().min(1).max(100),
    targetLang: z.string().trim().min(1).max(100),
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!isProjectDirectionCompatible(value)) {
      context.addIssue({
        code: 'custom',
        path: ['direction'],
        message: 'Project languages are incompatible with its direction.',
      })
    }
  })

export const projectUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(20_000).optional(),
    expectedUpdatedAt: isoDateSchema,
  })
  .strict()
  .refine(
    (value) => value.name !== undefined || value.description !== undefined,
    { message: 'At least one editable field is required.' },
  )

export const projectArchiveSchema = z
  .object({
    expectedUpdatedAt: isoDateSchema,
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .strict()

const sourceInputSchema = projectResourceSourceSchema.optional()
const scopeInputSchema = projectResourceScopeSchema.optional()

export const projectResourceCreateSchema = z
  .object({
    kind: projectResourceKindSchema,
    content: projectResourceContentSchema,
    source: sourceInputSchema,
    scope: scopeInputSchema,
    suggestionId: uuidSchema.optional(),
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .strict()
  .superRefine(addContentIssue)

export const projectResourceRevisionCreateSchema = z
  .object({
    baseRevisionId: uuidSchema,
    kind: projectResourceKindSchema.optional(),
    content: projectResourceContentSchema,
    source: sourceInputSchema,
    scope: scopeInputSchema,
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .strict()

export const projectResourceDecisionSchema = z
  .object({
    revisionId: uuidSchema,
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .strict()

export const projectSuggestionCreateSchema = z
  .object({
    kind: projectResourceKindSchema,
    content: projectResourceContentSchema,
    source: sourceInputSchema,
    scope: scopeInputSchema,
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .strict()
  .superRefine(addContentIssue)

export const projectListQuerySchema = z
  .object({
    status: z.enum(['active', 'archived']).optional(),
    direction: projectDirectionSchema.optional(),
  })
  .strict()

export const projectResourceListQuerySchema = z
  .object({
    status: projectResourceRevisionStatusSchema.optional(),
    kind: projectResourceKindSchema.optional(),
  })
  .strict()

export const projectSuggestionListQuerySchema = z
  .object({
    status: projectSuggestionStatusSchema.optional(),
  })
  .strict()

export const sessionProjectContextFreezeSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(200),
    projectId: uuidSchema,
    projectSnapshotId: uuidSchema,
    direction: projectDirectionSchema,
    resourceRevisionIds: z.array(uuidSchema).max(5_000),
    tokenEstimate: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.resourceRevisionIds).size !== value.resourceRevisionIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['resourceRevisionIds'],
        message: 'Resource revision IDs must be unique.',
      })
    }
  })
