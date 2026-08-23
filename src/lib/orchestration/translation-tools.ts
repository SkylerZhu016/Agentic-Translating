import { createHash } from 'crypto'
import { z } from 'zod'
import {
  bodyAndAnnotationEvidenceItemSchema,
  bodyOnlyEvidenceItemSchema,
  evidenceInspectionResultSchema,
  evidenceMaterialSchema,
  translationToolCallSchema,
  translationToolExecutionContextSchema,
  type EvidenceInheritanceMode,
  type EvidenceInspectionResult,
  type EvidenceMaterial,
  type TranslationToolCall,
  type TranslationToolExecutionContext,
  type TranslationToolName,
} from '../contracts/translation-tools'

export const MAX_REVIEW_REQUESTS_PER_STAGE = 2
export const MAX_REVIEW_DEPTH = 1

export type TranslationToolPolicyErrorCode =
  | 'invalid_tool_call'
  | 'read_only_agent'
  | 'inheritance_mode_forbidden'
  | 'review_depth_exceeded'
  | 'review_limit_exceeded'
  | 'evidence_not_found'
  | 'base_version_required'
  | 'base_version_mismatch'
  | 'patch_target_not_found'
  | 'patch_target_ambiguous'
  | 'replacement_unchanged'
  | 'annotation_hash_mismatch'

export class TranslationToolPolicyError extends Error {
  constructor(
    public readonly code: TranslationToolPolicyErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'TranslationToolPolicyError'
  }
}

export interface TranslationFunctionDefinition {
  type: 'function'
  function: {
    name: TranslationToolName
    description: string
    parameters: Record<string, unknown>
  }
}

const idArray = {
  type: 'array',
  minItems: 1,
  uniqueItems: true,
  items: { type: 'string' },
}

export const TRANSLATION_TOOL_DEFINITIONS: TranslationFunctionDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'write_draft',
      description:
        'Save a complete translation draft supported by at least two candidate invocation IDs.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'reason', 'evidenceInvocationIds'],
        properties: {
          text: { type: 'string', minLength: 1 },
          reason: { type: 'string', minLength: 1 },
          evidenceInvocationIds: { ...idArray, minItems: 2 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace_text',
      description:
        'Replace one exact, unique passage in the current translation.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['old_string', 'new_string'],
        properties: {
          old_string: { type: 'string', minLength: 1 },
          new_string: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_evidence',
      description:
        'Read named evidence using the explicitly permitted FSBP inheritance mode.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['evidenceIds', 'inheritanceMode'],
        properties: {
          evidenceIds: idArray,
          inheritanceMode: {
            type: 'string',
            enum: ['body_only', 'body_and_annotation'],
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_project_memory',
      description:
        'Search the frozen project memory for terminology, style, character, factual, or example evidence.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', minLength: 1 },
          kinds: {
            type: 'array',
            uniqueItems: true,
            items: {
              type: 'string',
              enum: [
                'terminology',
                'style',
                'character',
                'fact',
                'example',
                'other',
              ],
            },
          },
          maxResults: { type: 'integer', minimum: 1, maximum: 20 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_review',
      description:
        'Ask one read-only review subagent a focused question about an explicit segment and cited evidence.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['segment', 'question', 'evidenceIds'],
        properties: {
          segment: { type: 'string', minLength: 1 },
          question: { type: 'string', minLength: 1 },
          evidenceIds: idArray,
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'record_issue',
      description:
        'Record a located translation issue with category, severity, and evidence.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: [
          'title',
          'details',
          'location',
          'category',
          'severity',
          'evidenceIds',
        ],
        properties: {
          title: { type: 'string', minLength: 1 },
          details: { type: 'string', minLength: 1 },
          location: {
            type: 'object',
            additionalProperties: false,
            required: ['quote'],
            properties: {
              quote: { type: 'string', minLength: 1 },
              startOffset: { type: 'integer', minimum: 0 },
              endOffset: { type: 'integer', minimum: 1 },
            },
          },
          category: {
            type: 'string',
            enum: [
              'fidelity',
              'logic',
              'naturalness',
              'terminology',
              'style',
              'format',
              'task_constraint',
              'other',
            ],
          },
          severity: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'critical'],
          },
          evidenceIds: idArray,
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_patch',
      description:
        'Propose a version-bound edit using an exact unique old passage, replacement, reason, and evidence IDs. This does not apply the patch.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: [
          'baseVersionId',
          'oldText',
          'replacement',
          'reason',
          'evidenceIds',
        ],
        properties: {
          baseVersionId: { type: 'integer', minimum: 1 },
          oldText: { type: 'string', minLength: 1 },
          replacement: { type: 'string' },
          reason: { type: 'string', minLength: 1 },
          evidenceIds: idArray,
        },
      },
    },
  },
]

export const TRANSLATION_DOMAIN_TOOL_DEFINITIONS =
  TRANSLATION_TOOL_DEFINITIONS.filter(({ function: definition }) =>
    [
      'inspect_evidence',
      'search_project_memory',
      'request_review',
      'record_issue',
      'propose_patch',
    ].includes(definition.name),
  )

export const READ_ONLY_TRANSLATION_TOOLS = new Set<TranslationToolName>([
  'inspect_evidence',
  'search_project_memory',
])

function evidenceIdsForCall(call: TranslationToolCall): string[] {
  switch (call.name) {
    case 'write_draft':
      return call.args.evidenceInvocationIds
    case 'inspect_evidence':
    case 'request_review':
    case 'record_issue':
    case 'propose_patch':
      return call.args.evidenceIds
    case 'replace_text':
    case 'search_project_memory':
      return []
  }
}

export function getTranslationToolEvidenceIds(
  call: TranslationToolCall,
): string[] {
  return [...evidenceIdsForCall(call)]
}

export function countExactOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let cursor = 0
  while (cursor <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, cursor)
    if (index < 0) break
    count += 1
    cursor = index + 1
  }
  return count
}

function assertEvidenceReferences(
  call: TranslationToolCall,
  context: TranslationToolExecutionContext,
): void {
  if (!context.knownEvidenceIds) return
  const known = new Set(context.knownEvidenceIds)
  const missing = evidenceIdsForCall(call).filter((id) => !known.has(id))
  if (missing.length > 0) {
    throw new TranslationToolPolicyError(
      'evidence_not_found',
      `Unknown evidence IDs: ${missing.join(', ')}`,
    )
  }
}

function assertExactVersionTarget(
  call: Extract<TranslationToolCall, { name: 'propose_patch' | 'replace_text' }>,
  context: TranslationToolExecutionContext,
): void {
  if (!context.baseVersion) {
    throw new TranslationToolPolicyError(
      'base_version_required',
      `${call.name} requires the current base version and its complete text.`,
    )
  }
  if (
    call.name === 'propose_patch' &&
    call.args.baseVersionId !== context.baseVersion.id
  ) {
    throw new TranslationToolPolicyError(
      'base_version_mismatch',
      `Patch base version ${call.args.baseVersionId} is stale; current version is ${context.baseVersion.id}.`,
    )
  }
  const oldText =
    call.name === 'propose_patch' ? call.args.oldText : call.args.old_string
  const replacement =
    call.name === 'propose_patch' ? call.args.replacement : call.args.new_string
  if (oldText === replacement) {
    throw new TranslationToolPolicyError(
      'replacement_unchanged',
      'Replacement text must differ from the exact old text.',
    )
  }
  const occurrenceCount = countExactOccurrences(context.baseVersion.text, oldText)
  if (occurrenceCount === 0) {
    throw new TranslationToolPolicyError(
      'patch_target_not_found',
      'The exact old text does not occur in the base version.',
    )
  }
  if (occurrenceCount > 1) {
    throw new TranslationToolPolicyError(
      'patch_target_ambiguous',
      'The exact old text occurs more than once in the base version.',
    )
  }
}

export function validateTranslationToolInvocation(input: {
  call: unknown
  context: unknown
  reviewRequestsInStage?: number
}): {
  call: TranslationToolCall
  context: TranslationToolExecutionContext
} {
  let call: TranslationToolCall
  let context: TranslationToolExecutionContext
  try {
    call = translationToolCallSchema.parse(input.call)
    context = translationToolExecutionContextSchema.parse(input.context)
  } catch (error) {
    throw new TranslationToolPolicyError(
      'invalid_tool_call',
      error instanceof z.ZodError
        ? z.prettifyError(error)
        : 'Invalid translation tool invocation.',
      error,
    )
  }

  if (
    context.actor === 'review_subagent' &&
    !READ_ONLY_TRANSLATION_TOOLS.has(call.name)
  ) {
    throw new TranslationToolPolicyError(
      'read_only_agent',
      `Review subagents cannot call mutating tool ${call.name}.`,
    )
  }

  if (
    call.name === 'inspect_evidence' &&
    call.args.inheritanceMode !== context.allowedInheritanceMode
  ) {
    throw new TranslationToolPolicyError(
      'inheritance_mode_forbidden',
      `Evidence inheritance is frozen to ${context.allowedInheritanceMode}.`,
    )
  }

  if (call.name === 'request_review') {
    if (context.depth >= MAX_REVIEW_DEPTH) {
      throw new TranslationToolPolicyError(
        'review_depth_exceeded',
        `Review requests cannot exceed depth ${MAX_REVIEW_DEPTH}.`,
      )
    }
    if (
      (input.reviewRequestsInStage ?? 0) >= MAX_REVIEW_REQUESTS_PER_STAGE
    ) {
      throw new TranslationToolPolicyError(
        'review_limit_exceeded',
        `A stage can reserve at most ${MAX_REVIEW_REQUESTS_PER_STAGE} review requests.`,
      )
    }
  }

  assertEvidenceReferences(call, context)
  if (call.name === 'propose_patch' || call.name === 'replace_text') {
    assertExactVersionTarget(call, context)
  }

  return { call, context }
}

/**
 * Project persisted FSBP evidence for a caller. The mode is mandatory. The
 * body-only branch constructs a fresh allowlisted object, so raw output and
 * annotation cannot leak through object spreading or a future schema field.
 */
export function projectEvidenceForInheritance(
  materials: EvidenceMaterial[],
  inheritanceMode: EvidenceInheritanceMode,
): EvidenceInspectionResult {
  const parsed = materials.map((item) => evidenceMaterialSchema.parse(item))
  for (const item of parsed) {
    if (
      item.annotation !== null &&
      item.annotationMetadata?.hash !==
        createHash('sha256').update(item.annotation).digest('hex')
    ) {
      throw new TranslationToolPolicyError(
        'annotation_hash_mismatch',
        `Annotation hash does not match evidence ${item.evidenceId}.`,
      )
    }
  }
  if (inheritanceMode === 'body_only') {
    return evidenceInspectionResultSchema.parse({
      inheritanceMode,
      items: parsed.map((item) =>
        bodyOnlyEvidenceItemSchema.parse({
          evidenceId: item.evidenceId,
          sourceType: item.sourceType,
          sourceId: item.sourceId,
          body: item.body,
        }),
      ),
    })
  }
  return evidenceInspectionResultSchema.parse({
    inheritanceMode,
    items: parsed.map((item) => bodyAndAnnotationEvidenceItemSchema.parse(item)),
  })
}
