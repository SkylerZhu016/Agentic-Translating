import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../../src/lib/db/migrate'
import { createRepositories } from '../../src/lib/db/repositories'
import type {
  EndpointRow, PromptTemplateRow, TranslatorAgentRow,
  CoordinatorConfigRow, SettingRow, SessionRow,
  TranslationResultRow, StageOutputRow, FinalVersionRow, ChatMessageRow,
} from '../../src/lib/db/repositories'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

describe('Repositories — CRUD round-trip', () => {
  let db: Database.Database

  beforeEach(() => { db = createDb() })
  afterEach(() => { db.close() })

  it('endpoints: insert → getById → list → update → delete', () => {
    const repo = createRepositories(db).endpoints
    const { lastInsertRowid } = repo.insert({ name: 'OpenAI', base_url: 'https://api.openai.com/v1', api_key: 'sk-xxx' })
    const id = lastInsertRowid as number

    const row = repo.getById(id)
    expect(row).toBeDefined()
    expect(row!.name).toBe('OpenAI')

    const all = repo.list()
    expect(all.length).toBe(1)

    repo.update({ id, name: 'OpenAI Updated', base_url: 'https://api.openai.com/v1', api_key: 'sk-new' })
    expect(repo.getById(id)!.name).toBe('OpenAI Updated')

    repo.delete(id)
    expect(repo.getById(id)).toBeUndefined()
    expect(repo.list().length).toBe(0)
  })

  it('prompt_templates: insert/getById/update/delete/list/listByKind', () => {
    const repo = createRepositories(db).promptTemplates
    const r = repo.insert({ kind: 'translator', name: '默认翻译', content: '请翻译以下文本', is_builtin: 1 })
    const id = r.lastInsertRowid as number

    expect(repo.getById(id)!.kind).toBe('translator')
    repo.update({ id, kind: 'translator', name: '默认翻译 v2', content: '请翻译', is_builtin: 1 })
    expect(repo.getById(id)!.name).toBe('默认翻译 v2')

    expect(repo.listByKind('translator').length).toBe(1)
    expect(repo.listByKind('review').length).toBe(0)
    repo.delete(id)
    expect(repo.getById(id)).toBeUndefined()
  })

  it('translator_agents: full CRUD with endpoint FK', () => {
    const epRepo = createRepositories(db).endpoints
    const epId = epRepo.insert({ name: 'EP', base_url: 'https://x.com/v1', api_key: '' }).lastInsertRowid as number

    const repo = createRepositories(db).translatorAgents
    const r = repo.insert({ name: 'Agent A', endpoint_id: epId, model: 'gpt-4', prompt_override: '译成五言', sort_order: 1 })
    const id = r.lastInsertRowid as number

    const row = repo.getById(id)!
    expect(row.name).toBe('Agent A')
    expect(row.endpoint_id).toBe(epId)

    repo.update({ id, name: 'Agent B', endpoint_id: epId, model: 'gpt-4o', prompt_override: null, sort_order: 2 })
    expect(repo.getById(id)!.name).toBe('Agent B')

    expect(repo.listByEndpoint(epId).length).toBe(1)
    repo.delete(id)
    expect(repo.getById(id)).toBeUndefined()
  })

  it('coordinator_config: singleton upsert/get/delete', () => {
    const repo = createRepositories(db).coordinatorConfig
    // Initially no config
    expect(repo.get()).toBeUndefined()

    repo.upsert({ endpoint_id: null, model: 'gpt-4', chat_endpoint_id: null, chat_model: 'gpt-4' })
    const row = repo.get()!
    expect(row.model).toBe('gpt-4')
    expect(row.id).toBe(1)

    // Upsert updates
    repo.upsert({ endpoint_id: null, model: 'gpt-4o', chat_endpoint_id: null, chat_model: 'gpt-4o' })
    expect(repo.get()!.model).toBe('gpt-4o')

    repo.delete()
    expect(repo.get()).toBeUndefined()
  })

  it('settings: set/get/delete/list', () => {
    const repo = createRepositories(db).settings
    repo.set({ key: 'flash_warning_dismissed', value: 'true' })
    repo.set({ key: 'theme', value: 'light' })

    expect(repo.get('flash_warning_dismissed')!.value).toBe('true')
    expect(repo.get('nonexistent')).toBeUndefined()

    const all = repo.list()
    expect(all.length).toBe(2)

    repo.delete('flash_warning_dismissed')
    expect(repo.list().length).toBe(1)
  })

  it('sessions: insert/getById/update/updateState/delete/list', () => {
    const repo = createRepositories(db).sessions
    repo.insert({ id: 's1', source_text: 'Hello', source_lang: '英文', target_lang: '中文', state: 'draft', config_snapshot: '{}' })

    const row = repo.getById('s1')!
    expect(row.source_text).toBe('Hello')
    expect(row.state).toBe('draft')

    repo.updateState('translating', 's1')
    expect(repo.getById('s1')!.state).toBe('translating')

    repo.update({ id: 's1', source_text: 'World', source_lang: '英文', target_lang: '中文五言', state: 'translating', config_snapshot: '{}' })
    expect(repo.getById('s1')!.source_text).toBe('World')

    expect(repo.list().length).toBe(1)
    repo.delete('s1')
    expect(repo.getById('s1')).toBeUndefined()
  })

  it('translation_results: insert/getById/getBySessionAndAgent/update/delete/listBySession', () => {
    const sessRepo = createRepositories(db).sessions
    sessRepo.insert({ id: 's1', source_text: 'Hello', source_lang: '英文', target_lang: '中文', state: 'draft', config_snapshot: '{}' })

    const repo = createRepositories(db).translationResults
    const r = repo.insert({ session_id: 's1', agent_key: 'a1', agent_snapshot: '{}', status: 'pending', output_text: null, error: null, latency_ms: null, attempt: 0 })
    const id = r.lastInsertRowid as number

    expect(repo.getById(id)!.agent_key).toBe('a1')
    expect(repo.getBySessionAndAgent('s1', 'a1')!.status).toBe('pending')

    repo.update({ id, status: 'complete', output_text: '译文', error: null, latency_ms: 100, attempt: 1 })
    expect(repo.getById(id)!.status).toBe('complete')

    expect(repo.listBySession('s1').length).toBe(1)
    repo.delete(id)
    expect(repo.getById(id)).toBeUndefined()
  })

  it('stage_outputs: insert/getById/getBySessionAndStage/update/delete/listBySession', () => {
    const sessRepo = createRepositories(db).sessions
    sessRepo.insert({ id: 's1', source_text: 'Hello', source_lang: '英文', target_lang: '中文', state: 'draft', config_snapshot: '{}' })

    const repo = createRepositories(db).stageOutputs
    const r = repo.insert({ session_id: 's1', stage: 'review', status: 'pending', prompt_used: null, raw_output: null, parsed_output: null, error: null })
    const id = r.lastInsertRowid as number

    expect(repo.getById(id)!.stage).toBe('review')
    expect(repo.getBySessionAndStage('s1', 'review')!.status).toBe('pending')

    repo.update({ id, status: 'complete', prompt_used: 'prompt', raw_output: 'raw', parsed_output: '{}', error: null })
    expect(repo.getById(id)!.status).toBe('complete')

    expect(repo.listBySession('s1').length).toBe(1)
    repo.delete(id)
    expect(repo.getById(id)).toBeUndefined()
  })

  it('final_versions: insert/getById/getBySessionAndVersion/getLatestBySession/delete/listBySession', () => {
    const sessRepo = createRepositories(db).sessions
    sessRepo.insert({ id: 's1', source_text: 'Hello', source_lang: '英文', target_lang: '中文', state: 'draft', config_snapshot: '{}' })

    const repo = createRepositories(db).finalVersions
    repo.insert({ session_id: 's1', version_no: 1, text: 'v1', source: 'assemble' })
    const r2 = repo.insert({ session_id: 's1', version_no: 2, text: 'v2', source: 'edit' })
    const id2 = r2.lastInsertRowid as number

    expect(repo.getBySessionAndVersion('s1', 1)!.text).toBe('v1')
    expect(repo.getLatestBySession('s1')!.version_no).toBe(2)
    expect(repo.getLatestBySession('s1')!.text).toBe('v2')

    const all = repo.listBySession('s1')
    expect(all.length).toBe(2)

    repo.delete(id2)
    expect(repo.listBySession('s1').length).toBe(1)
  })

  it('chat_messages: insert/getById/update/delete/listBySession/listBySessionWithLimit', () => {
    const sessRepo = createRepositories(db).sessions
    sessRepo.insert({ id: 's1', source_text: 'Hello', source_lang: '英文', target_lang: '中文', state: 'draft', config_snapshot: '{}' })

    const repo = createRepositories(db).chatMessages
    repo.insert({ session_id: 's1', role: 'user', content: '你好', tool_calls: null, tool_results: null, version_id: null })
    repo.insert({ session_id: 's1', role: 'assistant', content: 'Hello', tool_calls: null, tool_results: null, version_id: null })
    repo.insert({ session_id: 's1', role: 'user', content: 'Hi', tool_calls: null, tool_results: null, version_id: null })

    const all = repo.listBySession('s1')
    expect(all.length).toBe(3)

    const limited = repo.listBySessionWithLimit('s1', 2)
    expect(limited.length).toBe(2)
    expect(limited[0].content).toBe('Hello')
    expect(limited[1].content).toBe('Hi')

    const msg = all[0]
    repo.update({ id: msg.id, content: '你好!', tool_calls: null, tool_results: null, version_id: null })
    expect(repo.getById(msg.id)!.content).toBe('你好!')

    repo.delete(msg.id)
    expect(repo.listBySession('s1').length).toBe(2)
  })

  it('foreign key cascade on session delete removes all child rows', () => {
    const repos = createRepositories(db)
    repos.sessions.insert({ id: 's1', source_text: 'Hello', source_lang: '英文', target_lang: '中文', state: 'draft', config_snapshot: '{}' })

    repos.translationResults.insert({ session_id: 's1', agent_key: 'a1', agent_snapshot: '{}', status: 'pending', output_text: null, error: null, latency_ms: null, attempt: 0 })
    repos.stageOutputs.insert({ session_id: 's1', stage: 'review', status: 'pending', prompt_used: null, raw_output: null, parsed_output: null, error: null })
    repos.finalVersions.insert({ session_id: 's1', version_no: 1, text: 't', source: 'assemble' })
    repos.chatMessages.insert({ session_id: 's1', role: 'user', content: 'hi', tool_calls: null, tool_results: null, version_id: null })

    repos.sessions.delete('s1')

    expect(repos.translationResults.listBySession('s1').length).toBe(0)
    expect(repos.stageOutputs.listBySession('s1').length).toBe(0)
    expect(repos.finalVersions.listBySession('s1').length).toBe(0)
    expect(repos.chatMessages.listBySession('s1').length).toBe(0)
  })
})
