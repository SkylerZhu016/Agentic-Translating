import { z } from 'zod'

export const modelBindingSchema = z.object({
  endpointId: z.number().int().positive().nullable(),
  model: z.string(),
  contextWindow: z.number().int().positive().nullable().optional(),
})

export const agentVariantSnapshotSchema = z.object({
  id: z.string().min(1),
  archetypeId: z.string().min(1),
  direction: z.enum(['en_to_zh', 'zh_to_en', 'custom']),
  catalogName: z.string().min(1),
  catalogDescription: z.string(),
  rolePrompt: z.string().min(1),
  promptLanguage: z.enum(['zh', 'en']),
  promptVersion: z.number().int().positive(),
  enabled: z.boolean(),
  endpointOverrideId: z.number().int().positive().nullable(),
  modelOverride: z.string().nullable(),
  sortOrder: z.number().int(),
})

export const translationConstraintsSchema = z.object({
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
})

export const workflowPresetContractSchema = z.object({
  sourceLang: z.string().min(1),
  targetLang: z.string().min(1),
  taskBriefTemplate: z.string(),
  teamPolicy: z.enum(['fixed', 'dynamic']),
  reviewMode: z.enum(['main_editor', 'four_stage']),
  agentVariantIds: z.array(z.string().min(1)).min(2),
  agentVariantSnapshots: z.array(agentVariantSnapshotSchema).min(2),
  defaultWorkerBinding: modelBindingSchema,
  agentBindingOverrides: z.record(z.string(), modelBindingSchema),
  mainAgentBinding: modelBindingSchema,
  editingAgentBinding: modelBindingSchema,
  promptBundleVersion: z.number().int().positive(),
  maxAgentCalls: z.number().int().min(2).max(10),
  batchConcurrency: z.number().int().min(1).max(4),
  constraints: translationConstraintsSchema,
})

export function validatePresetContractDirection(
  direction: 'en_to_zh' | 'zh_to_en' | 'custom',
  contract: z.infer<typeof workflowPresetContractSchema>,
): string | null {
  const ids = new Set(contract.agentVariantIds)
  const snapshotIds = new Set(
    contract.agentVariantSnapshots.map((variant) => variant.id),
  )
  if (ids.size !== contract.agentVariantIds.length) {
    return 'Agent IDs must be unique.'
  }
  if (
    ids.size !== snapshotIds.size ||
    [...ids].some((id) => !snapshotIds.has(id))
  ) {
    return 'Agent IDs and frozen variant snapshots must match exactly.'
  }
  if (
    contract.agentVariantSnapshots.some(
      (variant) => variant.direction !== direction,
    )
  ) {
    return 'A preset revision cannot mix translation directions.'
  }
  const expectedLanguage =
    direction === 'en_to_zh' ? 'zh' : direction === 'zh_to_en' ? 'en' : null
  if (
    expectedLanguage &&
    contract.agentVariantSnapshots.some(
      (variant) => variant.promptLanguage !== expectedLanguage,
    )
  ) {
    return 'Agent prompt language does not match the preset direction.'
  }
  return null
}

export const workflowPresetCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  direction: z.enum(['en_to_zh', 'zh_to_en', 'custom']),
  contract: workflowPresetContractSchema,
}).superRefine((value, context) => {
  const error = validatePresetContractDirection(value.direction, value.contract)
  if (error) {
    context.addIssue({
      code: 'custom',
      path: ['contract', 'agentVariantSnapshots'],
      message: error,
    })
  }
})
