import type Database from 'better-sqlite3'

// ── Type definitions ──────────────────────────────────────────────

export interface EndpointRow {
  id: number
  name: string
  base_url: string
  api_key: string
  created_at: string
}

export interface PromptTemplateRow {
  id: number
  kind: 'translator' | 'review' | 'filter' | 'orchestrate' | 'assemble'
  name: string
  content: string
  is_builtin: number
  updated_at: string
}

export interface TranslatorAgentRow {
  id: number
  name: string
  endpoint_id: number
  model: string
  prompt_override: string | null
  sort_order: number
  created_at: string
}

export interface CoordinatorConfigRow {
  id: number // always 1
  endpoint_id: number | null
  model: string
  chat_endpoint_id: number | null
  chat_model: string
  updated_at: string
}

export interface SettingRow {
  key: string
  value: string
}

export interface SessionRow {
  id: string
  source_text: string
  source_lang: string
  target_lang: string
  state: string
  config_snapshot: string
  created_at: string
  updated_at: string
}

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

export interface StageOutputRow {
  id: number
  session_id: string
  stage: 'review' | 'filter' | 'orchestrate' | 'assemble'
  status: 'pending' | 'running' | 'complete' | 'failed' | 'stale'
  prompt_used: string | null
  raw_output: string | null
  parsed_output: string | null
  error: string | null
  created_at: string
}

export interface FinalVersionRow {
  id: number
  session_id: string
  version_no: number
  text: string
  source: 'assemble' | 'edit' | 'restore'
  created_at: string
}

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

// ── Endpoints Repository ──────────────────────────────────────────

export function createEndpointsRepo(db: Database.Database) {
  const insertStmt = db.prepare('INSERT INTO endpoints (name, base_url, api_key) VALUES (@name, @base_url, @api_key)')
  const getByIdStmt = db.prepare('SELECT * FROM endpoints WHERE id = ?')
  const updateStmt = db.prepare('UPDATE endpoints SET name = @name, base_url = @base_url, api_key = @api_key WHERE id = @id')
  const deleteStmt = db.prepare('DELETE FROM endpoints WHERE id = ?')
  const listStmt = db.prepare('SELECT * FROM endpoints ORDER BY id')

  return {
    insert: (row: Pick<EndpointRow, 'name' | 'base_url' | 'api_key'>) => insertStmt.run(row as any),
    getById: (id: number) => getByIdStmt.get(id) as EndpointRow | undefined,
    update: (row: Pick<EndpointRow, 'id' | 'name' | 'base_url' | 'api_key'>) => updateStmt.run(row as any),
    delete: (id: number) => deleteStmt.run(id),
    list: () => listStmt.all() as EndpointRow[],
  }
}

// ── Prompt Templates Repository ───────────────────────────────────

export function createPromptTemplatesRepo(db: Database.Database) {
  const insertStmt = db.prepare('INSERT INTO prompt_templates (kind, name, content, is_builtin) VALUES (@kind, @name, @content, @is_builtin)')
  const getByIdStmt = db.prepare('SELECT * FROM prompt_templates WHERE id = ?')
  const updateStmt = db.prepare("UPDATE prompt_templates SET kind = @kind, name = @name, content = @content, is_builtin = @is_builtin, updated_at = datetime('now') WHERE id = @id")
  const deleteStmt = db.prepare('DELETE FROM prompt_templates WHERE id = ?')
  const listStmt = db.prepare('SELECT * FROM prompt_templates ORDER BY kind, name')
  const listByKindStmt = db.prepare('SELECT * FROM prompt_templates WHERE kind = ? ORDER BY is_builtin DESC, name')

  return {
    insert: (row: Pick<PromptTemplateRow, 'kind' | 'name' | 'content' | 'is_builtin'>) => insertStmt.run(row as any),
    getById: (id: number) => getByIdStmt.get(id) as PromptTemplateRow | undefined,
    update: (row: Pick<PromptTemplateRow, 'id' | 'kind' | 'name' | 'content' | 'is_builtin'>) => updateStmt.run(row as any),
    delete: (id: number) => deleteStmt.run(id),
    list: () => listStmt.all() as PromptTemplateRow[],
    listByKind: (kind: PromptTemplateRow['kind']) => listByKindStmt.all(kind) as PromptTemplateRow[],
  }
}

// ── Translator Agents Repository ──────────────────────────────────

export function createTranslatorAgentsRepo(db: Database.Database) {
  const insertStmt = db.prepare('INSERT INTO translator_agents (name, endpoint_id, model, prompt_override, sort_order) VALUES (@name, @endpoint_id, @model, @prompt_override, @sort_order)')
  const getByIdStmt = db.prepare('SELECT * FROM translator_agents WHERE id = ?')
  const updateStmt = db.prepare('UPDATE translator_agents SET name = @name, endpoint_id = @endpoint_id, model = @model, prompt_override = @prompt_override, sort_order = @sort_order WHERE id = @id')
  const deleteStmt = db.prepare('DELETE FROM translator_agents WHERE id = ?')
  const listStmt = db.prepare('SELECT * FROM translator_agents ORDER BY sort_order, id')
  const listByEndpointStmt = db.prepare('SELECT * FROM translator_agents WHERE endpoint_id = ? ORDER BY sort_order')

  return {
    insert: (row: Pick<TranslatorAgentRow, 'name' | 'endpoint_id' | 'model' | 'prompt_override' | 'sort_order'>) => insertStmt.run(row as any),
    getById: (id: number) => getByIdStmt.get(id) as TranslatorAgentRow | undefined,
    update: (row: Pick<TranslatorAgentRow, 'id' | 'name' | 'endpoint_id' | 'model' | 'prompt_override' | 'sort_order'>) => updateStmt.run(row as any),
    delete: (id: number) => deleteStmt.run(id),
    list: () => listStmt.all() as TranslatorAgentRow[],
    listByEndpoint: (endpointId: number) => listByEndpointStmt.all(endpointId) as TranslatorAgentRow[],
  }
}

// ── Coordinator Config Repository (singleton, id=1) ───────────────

export function createCoordinatorConfigRepo(db: Database.Database) {
  const getStmt = db.prepare('SELECT * FROM coordinator_config WHERE id = 1')
  const upsertStmt = db.prepare(`
    INSERT INTO coordinator_config (id, endpoint_id, model, chat_endpoint_id, chat_model, updated_at)
    VALUES (1, @endpoint_id, @model, @chat_endpoint_id, @chat_model, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      endpoint_id = @endpoint_id,
      model = @model,
      chat_endpoint_id = @chat_endpoint_id,
      chat_model = @chat_model,
      updated_at = datetime('now')
  `)
  const deleteStmt = db.prepare('DELETE FROM coordinator_config WHERE id = 1')

  return {
    get: () => getStmt.get() as CoordinatorConfigRow | undefined,
    upsert: (row: Pick<CoordinatorConfigRow, 'endpoint_id' | 'model' | 'chat_endpoint_id' | 'chat_model'>) => upsertStmt.run(row as any),
    delete: () => deleteStmt.run(),
  }
}

// ── Settings Repository ───────────────────────────────────────────

export function createSettingsRepo(db: Database.Database) {
  const getStmt = db.prepare('SELECT * FROM settings WHERE key = ?')
  const setStmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (@key, @value)')
  const deleteStmt = db.prepare('DELETE FROM settings WHERE key = ?')
  const listStmt = db.prepare('SELECT * FROM settings ORDER BY key')

  return {
    get: (key: string) => getStmt.get(key) as SettingRow | undefined,
    set: (row: Pick<SettingRow, 'key' | 'value'>) => setStmt.run(row as any),
    delete: (key: string) => deleteStmt.run(key),
    list: () => listStmt.all() as SettingRow[],
  }
}

// ── Sessions Repository ───────────────────────────────────────────

export function createSessionsRepo(db: Database.Database) {
  const insertStmt = db.prepare('INSERT INTO sessions (id, source_text, source_lang, target_lang, state, config_snapshot) VALUES (@id, @source_text, @source_lang, @target_lang, @state, @config_snapshot)')
  const getByIdStmt = db.prepare('SELECT * FROM sessions WHERE id = ?')
  const updateStmt = db.prepare("UPDATE sessions SET source_text = @source_text, source_lang = @source_lang, target_lang = @target_lang, state = @state, config_snapshot = @config_snapshot, updated_at = datetime('now') WHERE id = @id")
  const updateStateStmt = db.prepare("UPDATE sessions SET state = ?, updated_at = datetime('now') WHERE id = ?")
  const deleteStmt = db.prepare('DELETE FROM sessions WHERE id = ?')
  const listStmt = db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC')

  return {
    insert: (row: Pick<SessionRow, 'id' | 'source_text' | 'source_lang' | 'target_lang' | 'state' | 'config_snapshot'>) => insertStmt.run(row as any),
    getById: (id: string) => getByIdStmt.get(id) as SessionRow | undefined,
    update: (row: Pick<SessionRow, 'id' | 'source_text' | 'source_lang' | 'target_lang' | 'state' | 'config_snapshot'>) => updateStmt.run(row as any),
    updateState: (state: string, id: string) => updateStateStmt.run(state, id),
    delete: (id: string) => deleteStmt.run(id),
    list: () => listStmt.all() as SessionRow[],
  }
}

// ── Translation Results Repository ────────────────────────────────

export function createTranslationResultsRepo(db: Database.Database) {
  const insertStmt = db.prepare('INSERT INTO translation_results (session_id, agent_key, agent_snapshot, status, output_text, error, latency_ms, attempt) VALUES (@session_id, @agent_key, @agent_snapshot, @status, @output_text, @error, @latency_ms, @attempt)')
  const getByIdStmt = db.prepare('SELECT * FROM translation_results WHERE id = ?')
  const getBySessionAndAgentStmt = db.prepare('SELECT * FROM translation_results WHERE session_id = ? AND agent_key = ?')
  const updateStmt = db.prepare("UPDATE translation_results SET status = @status, output_text = @output_text, error = @error, latency_ms = @latency_ms, attempt = @attempt, updated_at = datetime('now') WHERE id = @id")
  const deleteStmt = db.prepare('DELETE FROM translation_results WHERE id = ?')
  const listBySessionStmt = db.prepare('SELECT * FROM translation_results WHERE session_id = ? ORDER BY agent_key')

  return {
    insert: (row: Pick<TranslationResultRow, 'session_id' | 'agent_key' | 'agent_snapshot' | 'status' | 'output_text' | 'error' | 'latency_ms' | 'attempt'>) => insertStmt.run(row as any),
    getById: (id: number) => getByIdStmt.get(id) as TranslationResultRow | undefined,
    getBySessionAndAgent: (sessionId: string, agentKey: string) => getBySessionAndAgentStmt.get(sessionId, agentKey) as TranslationResultRow | undefined,
    update: (row: Pick<TranslationResultRow, 'id' | 'status' | 'output_text' | 'error' | 'latency_ms' | 'attempt'>) => updateStmt.run(row as any),
    delete: (id: number) => deleteStmt.run(id),
    listBySession: (sessionId: string) => listBySessionStmt.all(sessionId) as TranslationResultRow[],
  }
}

// ── Stage Outputs Repository ──────────────────────────────────────

export function createStageOutputsRepo(db: Database.Database) {
  const insertStmt = db.prepare('INSERT INTO stage_outputs (session_id, stage, status, prompt_used, raw_output, parsed_output, error) VALUES (@session_id, @stage, @status, @prompt_used, @raw_output, @parsed_output, @error)')
  const getByIdStmt = db.prepare('SELECT * FROM stage_outputs WHERE id = ?')
  const getBySessionAndStageStmt = db.prepare('SELECT * FROM stage_outputs WHERE session_id = ? AND stage = ?')
  const updateStmt = db.prepare("UPDATE stage_outputs SET status = @status, prompt_used = @prompt_used, raw_output = @raw_output, parsed_output = @parsed_output, error = @error WHERE id = @id")
  const deleteStmt = db.prepare('DELETE FROM stage_outputs WHERE id = ?')
  const listBySessionStmt = db.prepare('SELECT * FROM stage_outputs WHERE session_id = ? ORDER BY id')

  return {
    insert: (row: Pick<StageOutputRow, 'session_id' | 'stage' | 'status' | 'prompt_used' | 'raw_output' | 'parsed_output' | 'error'>) => insertStmt.run(row as any),
    getById: (id: number) => getByIdStmt.get(id) as StageOutputRow | undefined,
    getBySessionAndStage: (sessionId: string, stage: StageOutputRow['stage']) => getBySessionAndStageStmt.get(sessionId, stage) as StageOutputRow | undefined,
    update: (row: Pick<StageOutputRow, 'id' | 'status' | 'prompt_used' | 'raw_output' | 'parsed_output' | 'error'>) => updateStmt.run(row as any),
    delete: (id: number) => deleteStmt.run(id),
    listBySession: (sessionId: string) => listBySessionStmt.all(sessionId) as StageOutputRow[],
  }
}

// ── Final Versions Repository ─────────────────────────────────────

export function createFinalVersionsRepo(db: Database.Database) {
  const insertStmt = db.prepare('INSERT INTO final_versions (session_id, version_no, text, source) VALUES (@session_id, @version_no, @text, @source)')
  const getByIdStmt = db.prepare('SELECT * FROM final_versions WHERE id = ?')
  const getBySessionAndVersionStmt = db.prepare('SELECT * FROM final_versions WHERE session_id = ? AND version_no = ?')
  const getLatestBySessionStmt = db.prepare('SELECT * FROM final_versions WHERE session_id = ? ORDER BY version_no DESC LIMIT 1')
  const deleteStmt = db.prepare('DELETE FROM final_versions WHERE id = ?')
  const listBySessionStmt = db.prepare('SELECT * FROM final_versions WHERE session_id = ? ORDER BY version_no')

  return {
    insert: (row: Pick<FinalVersionRow, 'session_id' | 'version_no' | 'text' | 'source'>) => insertStmt.run(row as any),
    getById: (id: number) => getByIdStmt.get(id) as FinalVersionRow | undefined,
    getBySessionAndVersion: (sessionId: string, versionNo: number) => getBySessionAndVersionStmt.get(sessionId, versionNo) as FinalVersionRow | undefined,
    getLatestBySession: (sessionId: string) => getLatestBySessionStmt.get(sessionId) as FinalVersionRow | undefined,
    delete: (id: number) => deleteStmt.run(id),
    listBySession: (sessionId: string) => listBySessionStmt.all(sessionId) as FinalVersionRow[],
  }
}

// ── Chat Messages Repository ──────────────────────────────────────

export function createChatMessagesRepo(db: Database.Database) {
  const insertStmt = db.prepare('INSERT INTO chat_messages (session_id, role, content, tool_calls, tool_results, version_id) VALUES (@session_id, @role, @content, @tool_calls, @tool_results, @version_id)')
  const getByIdStmt = db.prepare('SELECT * FROM chat_messages WHERE id = ?')
  const updateStmt = db.prepare('UPDATE chat_messages SET content = @content, tool_calls = @tool_calls, tool_results = @tool_results, version_id = @version_id WHERE id = @id')
  const deleteStmt = db.prepare('DELETE FROM chat_messages WHERE id = ?')
  const listBySessionStmt = db.prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id')
  const listBySessionWithLimitStmt = db.prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?')

  return {
    insert: (row: Pick<ChatMessageRow, 'session_id' | 'role' | 'content' | 'tool_calls' | 'tool_results' | 'version_id'>) => insertStmt.run(row as any),
    getById: (id: number) => getByIdStmt.get(id) as ChatMessageRow | undefined,
    update: (row: Pick<ChatMessageRow, 'id' | 'content' | 'tool_calls' | 'tool_results' | 'version_id'>) => updateStmt.run(row as any),
    delete: (id: number) => deleteStmt.run(id),
    listBySession: (sessionId: string) => listBySessionStmt.all(sessionId) as ChatMessageRow[],
    listBySessionWithLimit: (sessionId: string, limit: number) => listBySessionWithLimitStmt.all(sessionId, limit).reverse() as ChatMessageRow[],
  }
}

// ── Combined repo accessor ────────────────────────────────────────

export interface Repositories {
  endpoints: ReturnType<typeof createEndpointsRepo>
  promptTemplates: ReturnType<typeof createPromptTemplatesRepo>
  translatorAgents: ReturnType<typeof createTranslatorAgentsRepo>
  coordinatorConfig: ReturnType<typeof createCoordinatorConfigRepo>
  settings: ReturnType<typeof createSettingsRepo>
  sessions: ReturnType<typeof createSessionsRepo>
  translationResults: ReturnType<typeof createTranslationResultsRepo>
  stageOutputs: ReturnType<typeof createStageOutputsRepo>
  finalVersions: ReturnType<typeof createFinalVersionsRepo>
  chatMessages: ReturnType<typeof createChatMessagesRepo>
}

export function createRepositories(db: Database.Database): Repositories {
  return {
    endpoints: createEndpointsRepo(db),
    promptTemplates: createPromptTemplatesRepo(db),
    translatorAgents: createTranslatorAgentsRepo(db),
    coordinatorConfig: createCoordinatorConfigRepo(db),
    settings: createSettingsRepo(db),
    sessions: createSessionsRepo(db),
    translationResults: createTranslationResultsRepo(db),
    stageOutputs: createStageOutputsRepo(db),
    finalVersions: createFinalVersionsRepo(db),
    chatMessages: createChatMessagesRepo(db),
  }
}
