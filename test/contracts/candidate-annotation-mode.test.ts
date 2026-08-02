import { describe, expect, it } from 'vitest'
import { workflowPresetContractSchema } from '../../src/lib/contracts/vnext-schemas'

function contract(candidateAnnotationMode?: 'body_only' | 'body_and_annotation') {
  const variants = ['a', 'b'].map((id, index) => ({
    id,
    archetypeId: id,
    direction: 'en_to_zh' as const,
    catalogName: id,
    catalogDescription: '',
    rolePrompt: `role ${id}`,
    promptLanguage: 'zh' as const,
    promptVersion: 1,
    enabled: true,
    endpointOverrideId: null,
    modelOverride: null,
    sortOrder: index,
  }))
  const binding = { endpointId: 1, model: 'model' }
  return {
    sourceLang: '英文',
    targetLang: '中文',
    taskBriefTemplate: '',
    teamPolicy: 'fixed' as const,
    reviewMode: 'four_stage' as const,
    ...(candidateAnnotationMode ? { candidateAnnotationMode } : {}),
    agentVariantIds: variants.map((variant) => variant.id),
    agentVariantSnapshots: variants,
    defaultWorkerBinding: binding,
    agentBindingOverrides: {},
    mainAgentBinding: binding,
    editingAgentBinding: binding,
    promptBundleVersion: 1,
    maxAgentCalls: 5,
    batchConcurrency: 2,
    constraints: {},
  }
}

describe('candidate annotation visibility contract', () => {
  it('keeps old preset revisions compatible by defaulting to body_only', () => {
    const parsed = workflowPresetContractSchema.parse(contract())
    expect(parsed.candidateAnnotationMode).toBe('body_only')
  })

  it('accepts body_and_annotation as an explicit frozen policy', () => {
    const parsed = workflowPresetContractSchema.parse(
      contract('body_and_annotation'),
    )
    expect(parsed.candidateAnnotationMode).toBe('body_and_annotation')
  })
})
