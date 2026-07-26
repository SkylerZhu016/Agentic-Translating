import type Database from 'better-sqlite3'
import type {
  ConfigPresetRow,
  ConfigPresetAgentRow,
  ConfigPresetCoordinatorRow,
  ConfigPresetPromptRow,
  FullPreset,
} from '../contracts/types'
import { decryptSecret, encryptSecret } from '../security/secrets'

// ── Type definitions ──────────────────────────────────────────────

export interface EndpointRow {
  id: number
  name: string
  base_url: string
  chat_completions_path?: string
  api_key: string
  context_window?: number | null
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
  direction?: 'en_to_zh' | 'zh_to_en' | 'custom'
  task_brief?: string
  review_mode?: 'main_editor' | 'four_stage'
  preset_revision_id?: string | null
  final_version_id?: number | null
  batch_item_id?: string | null
  client_request_id?: string | null
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
  error: string | null
  created_at: string
}

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
  const endpointColumns = (
    db.prepare('PRAGMA table_info(endpoints)').all() as Array<{ name: string }>
  )
  const hasContextWindow = endpointColumns.some(
    (column) => column.name === 'context_window',
  )
  const hasChatPath = endpointColumns.some(
    (column) => column.name === 'chat_completions_path',
  )
  const insertStmt = db.prepare(
    hasContextWindow && hasChatPath
      ? 'INSERT INTO endpoints (name, base_url, chat_completions_path, api_key, context_window) VALUES (@name, @base_url, @chat_completions_path, @api_key, @context_window)'
      : hasContextWindow
      ? 'INSERT INTO endpoints (name, base_url, api_key, context_window) VALUES (@name, @base_url, @api_key, @context_window)'
      : 'INSERT INTO endpoints (name, base_url, api_key) VALUES (@name, @base_url, @api_key)',
  )
  const getByIdStmt = db.prepare('SELECT * FROM endpoints WHERE id = ?')
  const updateStmt = db.prepare(
    hasContextWindow && hasChatPath
      ? 'UPDATE endpoints SET name = @name, base_url = @base_url, chat_completions_path = @chat_completions_path, api_key = @api_key, context_window = @context_window WHERE id = @id'
      : hasContextWindow
      ? 'UPDATE endpoints SET name = @name, base_url = @base_url, api_key = @api_key, context_window = @context_window WHERE id = @id'
      : 'UPDATE endpoints SET name = @name, base_url = @base_url, api_key = @api_key WHERE id = @id',
  )
  const deleteStmt = db.prepare('DELETE FROM endpoints WHERE id = ?')
  const listStmt = db.prepare('SELECT * FROM endpoints ORDER BY id')
  const mapEndpoint = (row: EndpointRow | undefined) =>
    row ? { ...row, api_key: decryptSecret(row.api_key) } : undefined

  return {
    insert: (row: Pick<EndpointRow, 'name' | 'base_url' | 'api_key'> & { chat_completions_path?: string; context_window?: number | null }) =>
      insertStmt.run({
        ...row,
        chat_completions_path:
          row.chat_completions_path ?? '/v1/chat/completions',
        api_key: encryptSecret(row.api_key),
        context_window: row.context_window ?? null,
      } as any),
    getById: (id: number) =>
      mapEndpoint(getByIdStmt.get(id) as EndpointRow | undefined),
    update: (row: Pick<EndpointRow, 'id' | 'name' | 'base_url' | 'api_key'> & { chat_completions_path?: string; context_window?: number | null }) =>
      updateStmt.run({
        ...row,
        chat_completions_path:
          row.chat_completions_path ?? '/v1/chat/completions',
        api_key: encryptSecret(row.api_key),
        context_window: row.context_window ?? null,
      } as any),
    delete: (id: number) => deleteStmt.run(id),
    list: () =>
      (listStmt.all() as EndpointRow[]).map(
        (row) => mapEndpoint(row)!,
      ),
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
  const insertStmt = db.prepare('INSERT INTO stage_outputs (session_id, stage, status, prompt_used, raw_output, error) VALUES (@session_id, @stage, @status, @prompt_used, @raw_output, @error)')
  const getByIdStmt = db.prepare('SELECT * FROM stage_outputs WHERE id = ?')
  const getBySessionAndStageStmt = db.prepare('SELECT * FROM stage_outputs WHERE session_id = ? AND stage = ?')
  const updateStmt = db.prepare("UPDATE stage_outputs SET status = @status, prompt_used = @prompt_used, raw_output = @raw_output, error = @error WHERE id = @id")
  const deleteStmt = db.prepare('DELETE FROM stage_outputs WHERE id = ?')
  const listBySessionStmt = db.prepare('SELECT * FROM stage_outputs WHERE session_id = ? ORDER BY id')

  return {
    insert: (row: Pick<StageOutputRow, 'session_id' | 'stage' | 'status' | 'prompt_used' | 'raw_output' | 'error'>) => insertStmt.run(row as any),
    getById: (id: number) => getByIdStmt.get(id) as StageOutputRow | undefined,
    getBySessionAndStage: (sessionId: string, stage: StageOutputRow['stage']) => getBySessionAndStageStmt.get(sessionId, stage) as StageOutputRow | undefined,
    update: (row: Pick<StageOutputRow, 'id' | 'status' | 'prompt_used' | 'raw_output' | 'error'>) => updateStmt.run(row as any),
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

// ── Presets Repository ────────────────────────────────────────────

export function createPresetsRepo(db: Database.Database) {
  // config_presets (header)
  const listStmt = db.prepare('SELECT * FROM config_presets ORDER BY id')
  const getByIdStmt = db.prepare('SELECT * FROM config_presets WHERE id = ?')
  const getByNameStmt = db.prepare('SELECT * FROM config_presets WHERE name = ?')
  const insertStmt = db.prepare('INSERT INTO config_presets (name, description) VALUES (@name, @description)')
  const updateMetaStmt = db.prepare("UPDATE config_presets SET name = @name, description = @description, updated_at = datetime('now') WHERE id = @id")
  const deleteStmt = db.prepare('DELETE FROM config_presets WHERE id = ?')

  // child reads
  const listAgentsStmt = db.prepare('SELECT * FROM config_preset_agents WHERE preset_id = ? ORDER BY sort_order, id')
  const getCoordinatorStmt = db.prepare('SELECT * FROM config_preset_coordinator WHERE preset_id = ?')
  const listPromptsStmt = db.prepare('SELECT * FROM config_preset_prompts WHERE preset_id = ? ORDER BY id')

  // child writes (for saveContent)
  const deleteAgentsStmt = db.prepare('DELETE FROM config_preset_agents WHERE preset_id = ?')
  const deleteCoordinatorStmt = db.prepare('DELETE FROM config_preset_coordinator WHERE preset_id = ?')
  const deletePromptsStmt = db.prepare('DELETE FROM config_preset_prompts WHERE preset_id = ?')
  const insertAgentStmt = db.prepare('INSERT INTO config_preset_agents (preset_id, name, endpoint_id, model, prompt_override, sort_order) VALUES (@preset_id, @name, @endpoint_id, @model, @prompt_override, @sort_order)')
  const insertCoordinatorStmt = db.prepare('INSERT INTO config_preset_coordinator (preset_id, endpoint_id, model, chat_endpoint_id, chat_model) VALUES (@preset_id, @endpoint_id, @model, @chat_endpoint_id, @chat_model)')
  const insertPromptStmt = db.prepare('INSERT INTO config_preset_prompts (preset_id, kind, name, content) VALUES (@preset_id, @kind, @name, @content)')

  // cross-table writes (for applyToGlobalConfig)
  const deleteAllTranslatorAgentsStmt = db.prepare('DELETE FROM translator_agents')
  const insertTranslatorAgentStmt = db.prepare('INSERT INTO translator_agents (name, endpoint_id, model, prompt_override, sort_order) VALUES (@name, @endpoint_id, @model, @prompt_override, @sort_order)')
  const upsertCoordinatorStmt = db.prepare(`
    INSERT INTO coordinator_config (id, endpoint_id, model, chat_endpoint_id, chat_model, updated_at)
    VALUES (1, @endpoint_id, @model, @chat_endpoint_id, @chat_model, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      endpoint_id = @endpoint_id,
      model = @model,
      chat_endpoint_id = @chat_endpoint_id,
      chat_model = @chat_model,
      updated_at = datetime('now')
  `)
  const deleteAllPromptTemplatesStmt = db.prepare('DELETE FROM prompt_templates')
  const insertPromptTemplateStmt = db.prepare('INSERT INTO prompt_templates (kind, name, content, is_builtin) VALUES (@kind, @name, @content, 0)')

  const dedupeName = (baseName: string): string => {
    let finalName = baseName
    let n = 2
    while (getByNameStmt.get(finalName)) {
      finalName = `${baseName} (${n})`
      n++
    }
    return finalName
  }

  return {
    list: () => listStmt.all() as ConfigPresetRow[],
    getById: (id: number) => getByIdStmt.get(id) as ConfigPresetRow | undefined,
    getFull: (id: number): FullPreset | null => {
      const preset = getByIdStmt.get(id) as ConfigPresetRow | undefined
      if (!preset) return null
      const agents = listAgentsStmt.all(id) as ConfigPresetAgentRow[]
      const coordinator = getCoordinatorStmt.get(id) as ConfigPresetCoordinatorRow | undefined
      const prompts = listPromptsStmt.all(id) as ConfigPresetPromptRow[]
      return { preset, agents, coordinator: coordinator ?? null, prompts }
    },
    create: (name: string, description?: string): number => {
      const finalName = dedupeName(name)
      const info = insertStmt.run({ name: finalName, description: description ?? null } as any)
      return Number(info.lastInsertRowid)
    },
    updateMeta: (id: number, name: string, description?: string) => {
      updateMetaStmt.run({ id, name, description: description ?? null } as any)
    },
    saveContent: (
      id: number,
      agents: Array<Pick<ConfigPresetAgentRow, 'name' | 'endpoint_id' | 'model' | 'prompt_override' | 'sort_order'>>,
      coordinator: { endpoint_id: number | null; model: string; chat_endpoint_id: number | null; chat_model: string } | null,
      prompts: Array<Pick<ConfigPresetPromptRow, 'kind' | 'name' | 'content'>>,
    ) => {
      const txn = db.transaction(() => {
        deleteAgentsStmt.run(id)
        deleteCoordinatorStmt.run(id)
        deletePromptsStmt.run(id)
        for (const a of agents) {
          insertAgentStmt.run({ preset_id: id, ...a } as any)
        }
        if (coordinator) {
          insertCoordinatorStmt.run({ preset_id: id, ...coordinator } as any)
        }
        for (const p of prompts) {
          insertPromptStmt.run({ preset_id: id, ...p } as any)
        }
      })
      txn()
    },
    delete: (id: number) => {
      deleteStmt.run(id)
    },
    duplicate: (srcId: number, newName: string): number => {
      const src = getByIdStmt.get(srcId) as ConfigPresetRow | undefined
      if (!src) throw new Error(`Preset ${srcId} not found`)
      const agents = listAgentsStmt.all(srcId) as ConfigPresetAgentRow[]
      const coordinator = getCoordinatorStmt.get(srcId) as ConfigPresetCoordinatorRow | undefined
      const prompts = listPromptsStmt.all(srcId) as ConfigPresetPromptRow[]
      const finalName = dedupeName(newName)
      const info = insertStmt.run({ name: finalName, description: src.description } as any)
      const newId = Number(info.lastInsertRowid)
      const txn = db.transaction(() => {
        for (const a of agents) {
          insertAgentStmt.run({ preset_id: newId, name: a.name, endpoint_id: a.endpoint_id, model: a.model, prompt_override: a.prompt_override, sort_order: a.sort_order } as any)
        }
        if (coordinator) {
          insertCoordinatorStmt.run({ preset_id: newId, endpoint_id: coordinator.endpoint_id, model: coordinator.model, chat_endpoint_id: coordinator.chat_endpoint_id, chat_model: coordinator.chat_model } as any)
        }
        for (const p of prompts) {
          insertPromptStmt.run({ preset_id: newId, kind: p.kind, name: p.name, content: p.content } as any)
        }
      })
      txn()
      return newId
    },
    loadWithValidation: (
      id: number,
      existingEndpoints: { id: number }[],
    ): { valid: boolean; orphanEndpointRefs: { kind: string; agentIndex?: number; endpointId: number }[]; preset: FullPreset } => {
      const preset = ((): FullPreset => {
        const full = ((): FullPreset | null => {
          const row = getByIdStmt.get(id) as ConfigPresetRow | undefined
          if (!row) return null
          const agents = listAgentsStmt.all(id) as ConfigPresetAgentRow[]
          const coordinator = getCoordinatorStmt.get(id) as ConfigPresetCoordinatorRow | undefined
          const prompts = listPromptsStmt.all(id) as ConfigPresetPromptRow[]
          return { preset: row, agents, coordinator: coordinator ?? null, prompts }
        })()
        if (!full) throw new Error(`Preset ${id} not found`)
        return full
      })()
      const known = new Set(existingEndpoints.map((e) => e.id))
      const orphanEndpointRefs: { kind: string; agentIndex?: number; endpointId: number }[] = []
      if (preset.coordinator) {
        if (preset.coordinator.endpoint_id != null && !known.has(preset.coordinator.endpoint_id)) {
          orphanEndpointRefs.push({ kind: 'coordinator.endpoint', endpointId: preset.coordinator.endpoint_id })
        }
        if (preset.coordinator.chat_endpoint_id != null && !known.has(preset.coordinator.chat_endpoint_id)) {
          orphanEndpointRefs.push({ kind: 'coordinator.chat_endpoint', endpointId: preset.coordinator.chat_endpoint_id })
        }
      }
      preset.agents.forEach((a, idx) => {
        if (a.endpoint_id != null && !known.has(a.endpoint_id)) {
          orphanEndpointRefs.push({ kind: 'agent.endpoint', agentIndex: idx, endpointId: a.endpoint_id })
        }
      })
      return { valid: orphanEndpointRefs.length === 0, orphanEndpointRefs, preset }
    },
    applyToGlobalConfig: (id: number, orphanEndpointIds: number[]) => {
      const full = ((): FullPreset => {
        const row = getByIdStmt.get(id) as ConfigPresetRow | undefined
        if (!row) throw new Error(`Preset ${id} not found`)
        const agents = listAgentsStmt.all(id) as ConfigPresetAgentRow[]
        const coordinator = getCoordinatorStmt.get(id) as ConfigPresetCoordinatorRow | undefined
        const prompts = listPromptsStmt.all(id) as ConfigPresetPromptRow[]
        return { preset: row, agents, coordinator: coordinator ?? null, prompts }
      })()
      const orphan = new Set(orphanEndpointIds)
      const txn = db.transaction(() => {
        deleteAllTranslatorAgentsStmt.run()
        for (const a of full.agents) {
          // translator_agents.endpoint_id is NOT NULL — skip agents referencing orphaned endpoints
          if (a.endpoint_id != null && orphan.has(a.endpoint_id)) continue
          insertTranslatorAgentStmt.run({ name: a.name, endpoint_id: a.endpoint_id, model: a.model, prompt_override: a.prompt_override, sort_order: a.sort_order } as any)
        }
        const coord = full.coordinator
        const endpointId = coord && coord.endpoint_id != null && !orphan.has(coord.endpoint_id) ? coord.endpoint_id : null
        const chatEndpointId = coord && coord.chat_endpoint_id != null && !orphan.has(coord.chat_endpoint_id) ? coord.chat_endpoint_id : null
        upsertCoordinatorStmt.run({
          endpoint_id: endpointId,
          model: coord?.model ?? '',
          chat_endpoint_id: chatEndpointId,
          chat_model: coord?.chat_model ?? '',
        } as any)
        deleteAllPromptTemplatesStmt.run()
        for (const p of full.prompts) {
          insertPromptTemplateStmt.run({ kind: p.kind, name: p.name, content: p.content } as any)
        }
      })
      txn()
    },
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
  presets: ReturnType<typeof createPresetsRepo>
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
    presets: createPresetsRepo(db),
  }
}
