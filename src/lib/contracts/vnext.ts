export type BuiltinDirection = 'en_to_zh' | 'zh_to_en'
export type TranslationDirection = BuiltinDirection | 'custom'
export type AgentCategory =
  | 'foundation'
  | 'expression'
  | 'domain'
  | 'creative'
  | 'adversarial'

export type ReviewMode = 'main_editor' | 'four_stage'
export type TeamPolicy = 'fixed' | 'dynamic'
export type CandidateAnnotationMode = 'body_only' | 'body_and_annotation'
export type PoetryMode = 'auto' | 'on' | 'off'
export type PoetryTargetForm =
  | 'preserve'
  | 'free_verse'
  | 'classical'
  | 'regulated'
  | 'custom'
export type ChineseRhymeSystem = 'mandarin' | 'pingshui' | 'dual'
export type EnglishRhymeMode = 'natural' | 'exact' | 'near' | 'none'
export type RhymePositionMode = 'auto' | 'even_lines' | 'all_lines' | 'custom'
export type FirstLineRhymeMode = 'auto' | 'yes' | 'no'
export type RhymeChangeMode = 'source' | 'single' | 'by_stanza' | 'custom'
export type PoetryPriority = 'meaning' | 'balanced' | 'form'

export interface ModelBinding {
  endpointId: number | null
  model: string
  contextWindow?: number | null
}

export interface AgentArchetype {
  id: string
  slug: string
  displayNameZh: string
  category: AgentCategory
  tags: string[]
  isBuiltin: boolean
}

export interface AgentDirectionVariant {
  id: string
  archetypeId: string
  direction: TranslationDirection
  catalogName: string
  catalogDescription: string
  rolePrompt: string
  promptLanguage: 'zh' | 'en'
  promptVersion: number
  enabled: boolean
  endpointOverrideId: number | null
  modelOverride: string | null
  sortOrder: number
}

export interface DirectionPromptBundle {
  direction: TranslationDirection
  promptLanguage: 'zh' | 'en'
  mainAgentSystemPrompt: string
  workerBasePrompt: string
  reviewPrompt: string
  filterPrompt: string
  orchestratePrompt: string
  assemblePrompt: string
  editingPrompt: string
  toolDescriptions: Record<string, string>
  version: number
}

export interface TranslationConstraints {
  preserveParagraphs?: boolean
  preserveStanzas?: boolean
  expectedStanzas?: number
  targetCharsOrWordsPerLine?: number
  forbiddenTerms?: string[]
  requiredTerms?: string[]
  rhymeEvidence?: boolean
  poetryMode?: PoetryMode
  poetryTargetForm?: PoetryTargetForm
  chineseRhymeSystem?: ChineseRhymeSystem
  englishRhymeMode?: EnglishRhymeMode
  rhymePositions?: RhymePositionMode
  customRhymeLines?: number[]
  rhymeScheme?: string
  firstLineRhyme?: FirstLineRhymeMode
  rhymeChange?: RhymeChangeMode
  poetryPriority?: PoetryPriority
}

export interface WorkflowPresetContract {
  sourceLang: string
  targetLang: string
  taskBriefTemplate: string
  teamPolicy: TeamPolicy
  reviewMode: ReviewMode
  candidateAnnotationMode?: CandidateAnnotationMode
  agentVariantIds: string[]
  agentVariantSnapshots: AgentDirectionVariant[]
  defaultWorkerBinding: ModelBinding
  agentBindingOverrides: Record<string, ModelBinding>
  mainAgentBinding: ModelBinding
  reviewAgentBinding?: ModelBinding
  filterAgentBinding?: ModelBinding
  orchestrateAgentBinding?: ModelBinding
  assembleAgentBinding?: ModelBinding
  editingAgentBinding: ModelBinding
  contextAnalysisBindings?: ModelBinding[]
  promptBundleVersion: number
  maxAgentCalls: number
  batchConcurrency: number
  constraints: TranslationConstraints
}

export interface WorkflowPreset {
  id: string
  name: string
  description: string
  direction: TranslationDirection
  currentRevisionNo: number
  deletedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface WorkflowPresetRevision {
  id: string
  presetId: string
  revisionNo: number
  contract: WorkflowPresetContract
  createdAt: string
}

export interface WorkspaceDraft {
  direction: BuiltinDirection
  sourceText: string
  taskBrief: string
  selectedProjectId: string | null
  selectedPresetRevisionId: string | null
  allowedAgentVariantIds: string[]
  reviewMode: ReviewMode
  promptBundleRevisionId?: string | null
  constraints: TranslationConstraints
  updatedAt: string
}

export interface SemanticAgentOutput {
  raw: string
  body: string
  annotation: string | null
}

export interface SafeEndpointSnapshot {
  id: number
  name: string
  baseUrl: string
  chatCompletionsPath: string
  hasApiKey: boolean
  contextWindow: number | null
}

export interface PrivateEndpointSnapshot extends SafeEndpointSnapshot {
  apiKey: string
}

export interface ConfigSnapshotVNext {
  version: 3
  direction: TranslationDirection
  promptBundleSnapshot: DirectionPromptBundle
  agentVariantSnapshots: AgentDirectionVariant[]
  endpointSnapshots: PrivateEndpointSnapshot[]
  modelBindings: {
    defaultWorker: ModelBinding
    mainAgent: ModelBinding
    reviewAgent?: ModelBinding
    filterAgent?: ModelBinding
    orchestrateAgent?: ModelBinding
    assembleAgent?: ModelBinding
    editingAgent: ModelBinding
  }
  presetRevisionSnapshot: WorkflowPresetRevision | null
  promptBundleRevisionId?: string | null
  projectId?: string | null
  projectSnapshotId?: string | null
  taskBrief: string
  constraints: TranslationConstraints
  orchestrationPolicy: {
    teamPolicy: TeamPolicy
    reviewMode: ReviewMode
    maxAgentCalls: number
    candidateAnnotationMode?: CandidateAnnotationMode
  }
}

export interface PublicConfigSnapshotVNext
  extends Omit<ConfigSnapshotVNext, 'endpointSnapshots'> {
  endpointSnapshots: SafeEndpointSnapshot[]
}

export interface EvidenceReference {
  invocationId: string
  quote?: string
}

export interface DiffSpan {
  type: 'equal' | 'insert' | 'delete'
  text: string
}
