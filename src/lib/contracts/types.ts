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
  parsed_output: string | null
  error: string | null
}

/** A version of the final translated text */
export interface FinalVersion {
  id: number
  session_id: string
  version_no: number
  text: string
  source: 'assemble' | 'edit' | 'restore'
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

/** Deep-frozen config snapshot at session creation */
export interface ConfigSnapshot {
  endpoint: EndpointConfig | null
  agents: TranslatorAgentConfig[]
  coordinator: CoordinatorConfig | null
  prompts: Record<string, string> // kind → content
}
