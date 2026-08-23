import { describe, expect, it } from 'vitest'
import type {
  AgentDirectionVariant,
  WorkspaceDraft,
} from '@/src/lib/contracts/vnext'
import {
  DEFAULT_POETRY_CONSTRAINTS,
  hasMeaningfulDraft,
} from '@/src/components/translate/workspace-draft-state'

const variants = [
  { id: 'agent-a' },
  { id: 'agent-b' },
] satisfies Array<Pick<AgentDirectionVariant, 'id'>>

function draft(
  overrides: Partial<WorkspaceDraft> = {},
): WorkspaceDraft {
  return {
    direction: 'en_to_zh',
    sourceText: '',
    taskBrief: '',
    selectedProjectId: null,
    selectedPresetRevisionId: null,
    allowedAgentVariantIds: variants.map((variant) => variant.id),
    reviewMode: 'main_editor',
    mainEditorRunMode: 'fixed_pipeline',
    promptBundleRevisionId: null,
    constraints: DEFAULT_POETRY_CONSTRAINTS,
    updatedAt: '2026-08-23T00:00:00.000Z',
    ...overrides,
  }
}

describe('workspace draft meaningful-state predicate', () => {
  it('treats the untouched editor defaults as empty', () => {
    expect(hasMeaningfulDraft(draft(), variants)).toBe(false)
    expect(hasMeaningfulDraft(draft({ allowedAgentVariantIds: [] }), variants))
      .toBe(false)
  })

  it.each([
    ['prompt bundle', { promptBundleRevisionId: 'bundle-revision' }],
    ['review mode', { reviewMode: 'four_stage' as const }],
    ['Main Agent mode', { mainEditorRunMode: 'tool_enabled' as const }],
    ['Agent selection', { allowedAgentVariantIds: ['agent-a'] }],
  ])('recovers a settings-only draft changed by %s', (_label, override) => {
    expect(hasMeaningfulDraft(draft(override), variants)).toBe(true)
  })

  it('uses semantic poetry defaults instead of object serialization order', () => {
    expect(hasMeaningfulDraft(draft({
      constraints: {
        rhymeEvidence: true,
        poetryPriority: 'balanced',
        rhymeChange: 'source',
        firstLineRhyme: 'auto',
        rhymePositions: 'auto',
        englishRhymeMode: 'natural',
        chineseRhymeSystem: 'mandarin',
        poetryTargetForm: 'preserve',
        poetryMode: 'auto',
      },
    }), variants)).toBe(false)
  })
})
