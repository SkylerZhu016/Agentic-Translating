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
  api_key: z.string().min(0).default(''),
})

export const endpointUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  base_url: z.string().url().optional(),
  api_key: z.string().optional(),
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
// C2 — Four stage output schemas (exact per plan lines 62–65)
// ===========================================================================

/** `review` output: array of assessments */
export const reviewOutputSchema = z.object({
  assessments: z
    .array(
      z.object({
        agent_id: z.string().min(1),
        strengths: z.array(z.string()),
        weaknesses: z.array(z.string()),
        quality_score: z.number().int().min(1).max(10),
        keep: z.boolean(),
      })
    )
    .min(1),
})

/** `filter` output: selected / rejected agent ids */
export const filterOutputSchema = z.object({
  selected_agent_ids: z.array(z.string().min(1)),
  rationale: z.string().min(1),
  rejected_agent_ids: z.array(z.string().min(1)),
})

/** `orchestrate` output: segment assignments */
export const orchestrateOutputSchema = z.object({
  structure_notes: z.string().min(1),
  segment_assignments: z
    .array(
      z.object({
        segment_index: z.number().int().min(0),
        source_agent_id: z.string().min(1),
        source_segment: z.string().min(1),
        rationale: z.string().min(1),
      })
    )
    .min(1),
})

/** `assemble` output: final text + notes */
export const assembleOutputSchema = z.object({
  final_text: z.string().min(1, 'final_text must not be empty'),
  notes: z.string().min(0),
})

// ===========================================================================
// replace_text tool parameters (C4)
// ===========================================================================

export const replaceTextParamsSchema = z.object({
  old_string: z.string().min(1, 'old_string must not be empty'),
  new_string: z.string(),
})
