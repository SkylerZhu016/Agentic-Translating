import { z } from 'zod'

// Core domain schemas and type definitions.
// This file defines SessionState, ALLOWED_TRANSITIONS, and related types
// that guards and services depend on.

// ─── Session State ──────────────────────────────────────────────

export type SessionState =
  | 'draft'
  | 'translating'
  | 'translated'
  | 'coordinating'
  | 'assembled'
  | 'refining'
  | 'done'

// ─── State Machine Transitions (C5) ─────────────────────────────

/**
 * Maps each session state to the set of states it may transition to.
 *
 * C5 diagram:
 *   draft → translating → translated → coordinating → assembled → refining ⇄ done
 *
 * - translated can go back to translating (re-translate)
 * - coordinating can stay in coordinating (re-run a stage)
 * - refining can stay in refining (multiple chat rounds)
 * - done can go back to refining (restore + edit)
 */
export const ALLOWED_TRANSITIONS: Record<SessionState, SessionState[]> = {
  draft: ['translating'],
  translating: ['translated'],
  translated: ['coordinating', 'translating'],
  coordinating: ['assembled', 'coordinating'],
  assembled: ['refining', 'done'],
  refining: ['refining', 'done'],
  done: ['refining'],
}

// ===========================================================================
// Config CRUD schemas
// ===========================================================================

export const endpointCreateSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  base_url: z.string().url('Must be a valid URL'),
  chat_completions_path: z.string().min(1).default('/v1/chat/completions'),
  api_key: z.string().min(0).default(''),
  context_window: z.number().int().positive().nullable().optional(),
})

export const endpointUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  base_url: z.string().url().optional(),
  chat_completions_path: z.string().min(1).optional(),
  api_key: z.string().optional(),
  context_window: z.number().int().positive().nullable().optional(),
})

export const sessionCreateSchema = z.object({
  clientRequestId: z.string().uuid().optional(),
  sourceText: z.string(),
  direction: z.enum(['en_to_zh', 'zh_to_en', 'custom']).default('en_to_zh'),
  sourceLang: z.string().min(1).optional(),
  targetLang: z.string().min(1).optional(),
  taskBrief: z.string().default(''),
  reviewMode: z.enum(['main_editor', 'four_stage']).default('main_editor'),
  mainEditorRunMode: z
    .enum(['fixed_pipeline', 'tool_enabled'])
    .default('fixed_pipeline'),
  presetRevisionId: z.string().min(1).nullable().optional(),
  promptBundleRevisionId: z.string().min(1).nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  allowedAgentVariantIds: z.array(z.string().min(1)).optional(),
  constraints: z.object({
    preserveParagraphs: z.boolean().optional(),
    preserveStanzas: z.boolean().optional(),
    expectedStanzas: z.number().int().positive().optional(),
    targetCharsOrWordsPerLine: z.number().int().positive().optional(),
    forbiddenTerms: z.array(z.string()).optional(),
    requiredTerms: z.array(z.string()).optional(),
    rhymeEvidence: z.boolean().optional(),
    poetryMode: z.enum(['auto', 'on', 'off']).optional(),
    poetryTargetForm: z.enum([
      'preserve',
      'free_verse',
      'classical',
      'regulated',
      'custom',
    ]).optional(),
    chineseRhymeSystem: z.enum(['mandarin', 'pingshui', 'dual']).optional(),
    englishRhymeMode: z.enum(['natural', 'exact', 'near', 'none']).optional(),
    rhymePositions: z.enum([
      'auto',
      'even_lines',
      'all_lines',
      'custom',
    ]).optional(),
    customRhymeLines: z.array(z.number().int().positive()).optional(),
    rhymeScheme: z.string().max(128).optional(),
    firstLineRhyme: z.enum(['auto', 'yes', 'no']).optional(),
    rhymeChange: z.enum(['source', 'single', 'by_stanza', 'custom']).optional(),
    poetryPriority: z.enum(['meaning', 'balanced', 'form']).optional(),
  }).default({}),
}).superRefine((value, context) => {
  if (
    value.direction === 'custom' &&
    (!value.sourceLang?.trim() || !value.targetLang?.trim())
  ) {
    context.addIssue({
      code: 'custom',
      path: ['sourceLang'],
      message: 'Custom directions require explicit sourceLang and targetLang.',
    })
  }
})

export const agentCreateSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  endpoint_id: z.number().int().positive('endpoint_id is required'),
  model: z.string().min(1, 'Model is required'),
  prompt_override: z.string().nullable().optional(),
  sort_order: z.number().int().min(0).default(0),
})

export const agentUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  endpoint_id: z.number().int().positive().optional(),
  model: z.string().min(1).optional(),
  prompt_override: z.string().nullable().optional(),
  sort_order: z.number().int().min(0).optional(),
})

export const coordinatorUpdateSchema = z.object({
  endpoint_id: z.number().int().positive().nullable().optional(),
  model: z.string().min(1, 'Model is required'),
  chat_endpoint_id: z.number().int().positive().nullable().optional(),
  chat_model: z.string().min(1, 'Chat model is required'),
})

export const promptCreateSchema = z.object({
  kind: z.enum(['translator', 'review', 'filter', 'orchestrate', 'assemble']),
  name: z.string().min(1, 'Name is required'),
  content: z.string().min(1, 'Content is required'),
})

export const promptUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
})

// ===========================================================================
// replace_text tool parameters (C4)
// ===========================================================================

export const replaceTextParamsSchema = z.object({
  old_string: z.string().min(1, 'old_string must not be empty'),
  new_string: z.string(),
})
