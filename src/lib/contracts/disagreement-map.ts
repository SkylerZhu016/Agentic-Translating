export interface DisagreementCandidate {
  invocationId: string
  agentName: string
  model: string
  body: string
  /**
   * Kept on the input so callers do not need to discard the FSBP annotation.
   * The disagreement-map derivation deliberately does not compare or emit it.
   */
  annotation?: string | null
}

export interface DisagreementMapInput {
  sourceText: string
  candidates: DisagreementCandidate[]
  finalText?: string
}

export type DisagreementSegmentationMode =
  | 'poetry_line'
  | 'sentence'
  | 'paragraph'
  | 'full_text'

export type DisagreementDifferenceKind =
  | 'wording'
  | 'punctuation'
  | 'number'
  | 'negation'
  | 'proper_noun'
  | 'terminology'
  | 'structure'

export type DisagreementHintKind = Extract<
  DisagreementDifferenceKind,
  'punctuation' | 'number' | 'negation' | 'proper_noun' | 'terminology'
>

export interface DisagreementSourceSegmentDto {
  id: string
  index: number
  text: string
  startOffset: number
  endOffset: number
  paragraphIndex: number
  stanzaIndex: number | null
  lineIndex: number | null
}

export interface DisagreementSourceRangeDto {
  segmentIds: string[]
  startOffset: number
  endOffset: number
  text: string
}

export interface DisagreementCandidateFragmentDto {
  invocationId: string
  agentName: string
  model: string
  bodySegment: string
  unitCount: number
}

export interface DisagreementHintCandidateValuesDto {
  invocationId: string
  values: string[]
}

/**
 * A hint records only a mechanically observable inventory difference. It does
 * not claim that any candidate is semantically right or wrong.
 */
export interface DisagreementHintDto {
  kind: DisagreementHintKind
  confidence: 'deterministic'
  candidateValues: DisagreementHintCandidateValuesDto[]
}

export interface DisagreementHotspotDto {
  id: string
  index: number
  sourceRange: DisagreementSourceRangeDto
  candidates: DisagreementCandidateFragmentDto[]
  finalSegment: string | null
  adoptedCandidateIds: string[]
  differenceScore: number
  differenceKinds: DisagreementDifferenceKind[]
  hints: DisagreementHintDto[]
}

export type DisagreementFallbackReason =
  | 'invalid_input'
  | 'insufficient_candidates'
  | 'empty_source'
  | 'empty_candidate'
  | 'too_large'
  | 'segmentation_failed'
  | 'alignment_failed'
  | 'internal_error'

export interface DisagreementFullTextCandidateDto {
  invocationId: string
  agentName: string
  model: string
  body: string
}

export interface DisagreementFullTextFallbackDto {
  reason: DisagreementFallbackReason
  message: '本次只能按全文比较'
  sourceText: string
  candidates: DisagreementFullTextCandidateDto[]
  finalText: string | null
}

export type DisagreementFinalAlignmentStatus =
  | 'not_provided'
  | 'aligned'
  | 'unavailable'

export interface DisagreementMapDto {
  status: 'ready' | 'full_text_fallback'
  segmenterVersion: string
  candidateSetHash: string
  segmentationMode: DisagreementSegmentationMode
  sourceSegments: DisagreementSourceSegmentDto[]
  hotspots: DisagreementHotspotDto[]
  finalAlignmentStatus: DisagreementFinalAlignmentStatus
  fallback: DisagreementFullTextFallbackDto | null
}
