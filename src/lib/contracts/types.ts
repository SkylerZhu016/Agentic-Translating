import type {
  AgentDirectionVariant,
  DirectionPromptBundle,
  ModelBinding,
  ReviewMode,
  TeamPolicy,
  TranslationConstraints,
  TranslationDirection,
  WorkflowPresetRevision,
} from './vnext'

// ---------------------------------------------------------------------------
// Domain types — single source of truth for all domain entities
// ---------------------------------------------------------------------------

/** 7-state session machine */
export type SessionState =
  | 'draft'
  | 'translating'
  | 'translated'
  | 'coordinating'
  | 'assembled'
  | 'refining'
  | 'done'

/** 4-stage coordination pipeline */
export type Stage = 'review' | 'filter' | 'orchestrate' | 'assemble'

/** An LLM endpoint configuration */
export interface EndpointConfig {
  id: number
  name: string
  base_url: string
  api_key: string
  context_window?: number | null
  created_at: string
}

/** A translator agent configuration */
export interface TranslatorAgentConfig {
  id: number
  name: string
  endpoint_id: number
  model: string
  prompt_override: string | null
  sort_order: number
  created_at: string
}

/** Coordinator (and chat) configuration */
export interface CoordinatorConfig {
  id: number
  endpoint_id: number | null
  model: string
  chat_endpoint_id: number | null
  chat_model: string
  updated_at: string
}

/** Result of a single translator agent */
export interface TranslationResult {
  id: number
  session_id: string
  agent_key: string
  agent_snapshot: string
  status: 'pending' | 'streaming' | 'complete' | 'error'
  output_text: string | null
  error: string | null
  latency_ms: number | null
  attempt: number
}

/** Output of a single coordination stage */
export interface StageOutput {
  id: number
  session_id: string
  stage: Stage
  status: 'pending' | 'running' | 'complete' | 'failed' | 'stale'
  prompt_used: string | null
  raw_output: string | null
  error: string | null
}

/** A version of the final translated text */
export interface FinalVersion {
  id: number
  session_id: string
  version_no: number
  text: string
  source: 'assemble' | 'main_draft' | 'edit' | 'restore' | 'revert'
  created_at: string
}

/** A chat message in the editing conversation */
export interface ChatMessage {
  id: number
  session_id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  tool_calls: string | null
  tool_results: string | null
  version_id: number | null
  created_at: string
}

// ── DB Row types (full columns from SQL schema) ─────────────────

/** Full sessions row (includes created_at / updated_at) */
export interface SessionRow {
  id: string
  source_text: string
  source_lang: string
  target_lang: string
  state: string
  config_snapshot: string
  direction?: 'en_to_zh' | 'zh_to_en' | 'custom'
  task_brief?: string
  review_mode?: 'main_editor' | 'four_stage'
  preset_revision_id?: string | null
  final_version_id?: number | null
  batch_item_id?: string | null
  created_at: string
  updated_at: string
}

/** Full translation_results row */
export interface TranslationResultRow {
  id: number
  session_id: string
  agent_key: string
  agent_snapshot: string
  status: 'pending' | 'streaming' | 'complete' | 'error'
  output_text: string | null
  error: string | null
  latency_ms: number | null
  attempt: number
  updated_at: string
}

/** Full stage_outputs row */
export interface StageOutputRow {
  id: number
  session_id: string
  stage: Stage
  status: 'pending' | 'running' | 'complete' | 'failed' | 'stale'
  prompt_used: string | null
  raw_output: string | null
  error: string | null
  created_at: string
}

/** Full final_versions row */
export interface FinalVersionRow {
  id: number
  session_id: string
  version_no: number
  text: string
  source: 'assemble' | 'main_draft' | 'edit' | 'restore' | 'revert'
  parent_version_id?: number | null
  content_hash?: string | null
  created_by_patch_id?: string | null
  created_at: string
}

/** Full chat_messages row */
export interface ChatMessageRow {
  id: number
  session_id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  tool_calls: string | null
  tool_results: string | null
  version_id: number | null
  created_at: string
}

// ────────────────────────────────────────────────────────────────
/** Deep-frozen config snapshot at session creation */
export interface ConfigSnapshot {
  version?: 2 | 3
  endpoint: EndpointConfig | null
  endpoints?: EndpointConfig[]
  agents: TranslatorAgentConfig[]
  coordinator: CoordinatorConfig | null
  prompts: Record<string, string> // kind → content
  direction?: TranslationDirection
  promptBundleSnapshot?: DirectionPromptBundle
  agentVariantSnapshots?: AgentDirectionVariant[]
  endpointSnapshots?: Array<{
    id: number
    name: string
    baseUrl: string
    apiKey: string
    hasApiKey: boolean
    contextWindow: number | null
  }>
  modelBindings?: {
    defaultWorker: ModelBinding
    mainAgent: ModelBinding
    editingAgent: ModelBinding
  }
  presetRevisionSnapshot?: WorkflowPresetRevision | null
  taskBrief?: string
  constraints?: TranslationConstraints
  orchestrationPolicy?: {
    teamPolicy: TeamPolicy
    reviewMode: ReviewMode
    maxAgentCalls: number
  }
}

// ── Preset DB Row types ──────────────────────────────────────────

/** Full config_presets row */
export interface ConfigPresetRow {
  id: number
  name: string
  description: string | null
  is_builtin: number
  created_at: string
  updated_at: string
}

/** Full config_preset_agents row */
export interface ConfigPresetAgentRow {
  id: number
  preset_id: number
  name: string
  endpoint_id: number | null
  model: string
  prompt_override: string | null
  sort_order: number
}

/** Full config_preset_coordinator row (singleton per preset via UNIQUE preset_id) */
export interface ConfigPresetCoordinatorRow {
  id: number
  preset_id: number
  endpoint_id: number | null
  model: string
  chat_endpoint_id: number | null
  chat_model: string
}

/** Full config_preset_prompts row */
export interface ConfigPresetPromptRow {
  id: number
  preset_id: number
  kind: 'translator' | 'review' | 'filter' | 'orchestrate' | 'assemble'
  name: string
  content: string
}

/** Aggregated full preset (header row + all child rows) */
export interface FullPreset {
  preset: ConfigPresetRow
  agents: ConfigPresetAgentRow[]
  coordinator: ConfigPresetCoordinatorRow | null
  prompts: ConfigPresetPromptRow[]
}
