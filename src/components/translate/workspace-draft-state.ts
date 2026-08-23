import type {
  AgentDirectionVariant,
  TranslationConstraints,
  WorkspaceDraft,
} from '@/src/lib/contracts/vnext'

export const DEFAULT_POETRY_CONSTRAINTS: TranslationConstraints = {
  poetryMode: 'auto',
  poetryTargetForm: 'preserve',
  chineseRhymeSystem: 'mandarin',
  englishRhymeMode: 'natural',
  rhymePositions: 'auto',
  firstLineRhyme: 'auto',
  rhymeChange: 'source',
  poetryPriority: 'balanced',
  rhymeEvidence: true,
}

type MeaningfulDraftState = Pick<
  WorkspaceDraft,
  | 'sourceText'
  | 'taskBrief'
  | 'selectedProjectId'
  | 'selectedPresetRevisionId'
  | 'allowedAgentVariantIds'
  | 'reviewMode'
  | 'mainEditorRunMode'
  | 'promptBundleRevisionId'
  | 'constraints'
>

function hasNonDefaultPoetryConstraints(
  constraints: TranslationConstraints | undefined,
): boolean {
  if (!constraints) return false
  const merged = {
    ...DEFAULT_POETRY_CONSTRAINTS,
    ...constraints,
  }
  return (
    Object.entries(DEFAULT_POETRY_CONSTRAINTS).some(
      ([key, value]) =>
        merged[key as keyof TranslationConstraints] !== value,
    ) ||
    Object.keys(constraints).some(
      (key) => !(key in DEFAULT_POETRY_CONSTRAINTS),
    )
  )
}

function hasChangedAgentSelection(
  allowedAgentVariantIds: readonly string[],
  variants: readonly Pick<AgentDirectionVariant, 'id'>[],
): boolean {
  // Seeded and historical empty rows mean "use the catalogue defaults". The
  // UI persists an explicit non-empty subset once a person changes selection.
  if (allowedAgentVariantIds.length === 0) return false
  const allowed = new Set(allowedAgentVariantIds)
  const available = new Set(variants.map((variant) => variant.id))
  return (
    allowed.size !== available.size ||
    [...allowed].some((id) => !available.has(id))
  )
}

/**
 * Keep recovery detection and the direction switch "dirty" indicator on the
 * same definition of draft state. A draft may be meaningful even when both
 * text fields are blank because workflow settings affect the eventual run.
 */
export function hasMeaningfulDraft(
  draft: MeaningfulDraftState | null | undefined,
  variants: readonly Pick<AgentDirectionVariant, 'id'>[],
): boolean {
  if (!draft) return false
  return (
    draft.sourceText.trim().length > 0 ||
    draft.taskBrief.trim().length > 0 ||
    draft.selectedProjectId != null ||
    draft.selectedPresetRevisionId != null ||
    (draft.promptBundleRevisionId ?? null) != null ||
    draft.reviewMode !== 'main_editor' ||
    (draft.mainEditorRunMode ?? 'fixed_pipeline') !== 'fixed_pipeline' ||
    hasNonDefaultPoetryConstraints(draft.constraints) ||
    hasChangedAgentSelection(draft.allowedAgentVariantIds, variants)
  )
}
