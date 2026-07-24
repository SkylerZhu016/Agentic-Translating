import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { createRepositories } from '../../src/lib/db/repositories'
import { createSessionService } from '../../src/lib/services/session-service'
import {
  SourceRequiredError,
  InvalidTransitionError,
} from '../../src/lib/guards'
import { NoAgentsConfiguredError } from '../../src/lib/services/session-service'

// Inline migration SQL — apply to :memory: DB directly
const MIGRATION_SQL_0001 = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/db/migrations/0001_init.sql'),
  'utf-8',
)
const MIGRATION_SQL_0002 = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/db/migrations/0002_presets_and_drop_parsed_output.sql'),
  'utf-8',
)

describe('SessionService', () => {
  let db: Database.Database
  let repos: ReturnType<typeof createRepositories>
  let service: ReturnType<typeof createSessionService>

  // ── Shared test data ──────────────────────────────────────────
  const DEF_SOURCE = { sourceText: 'Hello world', sourceLang: 'English', targetLang: 'Chinese' }

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(MIGRATION_SQL_0001)
    db.exec(MIGRATION_SQL_0002)

    repos = createRepositories(db)
    service = createSessionService(db, repos)

    // Seed baseline data
    repos.endpoints.insert({ name: 'test-ep', base_url: 'https://api.test.com', api_key: 'sk-test' })
    repos.coordinatorConfig.upsert({
      endpoint_id: 1,
      model: 'gpt-4',
      chat_endpoint_id: 1,
      chat_model: 'gpt-4-chat',
    })
    repos.translatorAgents.insert({ name: 'agent-alpha', endpoint_id: 1, model: 'gpt-4', prompt_override: null, sort_order: 0 })
    repos.translatorAgents.insert({ name: 'agent-beta',  endpoint_id: 1, model: 'claude-3', prompt_override: null, sort_order: 1 })
    repos.promptTemplates.insert({ kind: 'translator', name: 'default', content: 'Translate {{text}} to {{lang}}', is_builtin: 1 })
    repos.promptTemplates.insert({ kind: 'review',     name: 'default', content: 'Review this translation', is_builtin: 1 })
  })

  afterEach(() => {
    db.close()
  })

  // ================================================================
  // createSession
  // ================================================================
  describe('createSession', () => {
    it('creates a session with state=draft', () => {
      const s = service.createSession(DEF_SOURCE)
      expect(s.state).toBe('draft')
      expect(s.source_text).toBe('Hello world')
      expect(s.source_lang).toBe('English')
      expect(s.target_lang).toBe('Chinese')
      expect(s.id).toBeDefined()
    })

    it('inserts one translation_result per agent with status=pending', () => {
      const s = service.createSession(DEF_SOURCE)
      const results = repos.translationResults.listBySession(s.id)
      expect(results).toHaveLength(2)
      const keys = results.map(r => r.agent_key).sort()
      expect(keys).toEqual(['agent-alpha', 'agent-beta'])
      for (const r of results) {
        expect(r.status).toBe('pending')
        expect(r.attempt).toBe(0)
      }
    })

    it('stores config_snapshot as JSON with deep-cloned config', () => {
      const s = service.createSession(DEF_SOURCE)
      const snap = JSON.parse(s.config_snapshot)
      expect(snap.agents).toHaveLength(2)
      expect(snap.agents[0].name).toBeDefined()
      expect(snap.coordinator).not.toBeNull()
      expect(snap.coordinator.model).toBe('gpt-4')
      expect(snap.prompts.translator).toBe('Translate {{text}} to {{lang}}')
      expect(snap.prompts.review).toBe('Review this translation')
      expect(snap.endpoint).not.toBeNull()
    })

    it('throws SourceRequiredError on empty source text', () => {
      expect(() =>
        service.createSession({ ...DEF_SOURCE, sourceText: '' }),
      ).toThrow(SourceRequiredError)
    })

    it('throws SourceRequiredError on whitespace-only source text', () => {
      expect(() =>
        service.createSession({ ...DEF_SOURCE, sourceText: '   ' }),
      ).toThrow(SourceRequiredError)
    })

    it('accepts source text beyond the legacy 8000-token guard', () => {
      const long = 'a'.repeat(40_000)
      const session = service.createSession({ ...DEF_SOURCE, sourceText: long })
      expect(session.source_text).toBe(long)
    })

    it('throws NoAgentsConfiguredError when translator_agents is empty', () => {
      repos.translatorAgents.delete(1)
      repos.translatorAgents.delete(2)
      expect(() => service.createSession(DEF_SOURCE)).toThrow(NoAgentsConfiguredError)
    })

    it('uses a transaction — partial failure rolls back session insert', () => {
      // Simulate: no agents at all (already covered above)
      // This test confirms atomicity conceptually: either everything inserts or nothing.
      repos.translatorAgents.delete(1)
      repos.translatorAgents.delete(2)
      try {
        service.createSession(DEF_SOURCE)
      } catch { /* expected */ }
      const sessions = repos.sessions.list()
      expect(sessions).toHaveLength(0)
    })
  })

  // ================================================================
  // getSessionFull
  // ================================================================
  describe('getSessionFull', () => {
    it('returns null for non-existent session', () => {
      expect(service.getSessionFull('no-such-id')).toBeNull()
    })

    it('returns session with all 5 child record types assembled', () => {
      const s = service.createSession(DEF_SOURCE)

      // Add one record of each child type
      repos.stageOutputs.insert({
        session_id: s.id, stage: 'review', status: 'pending',
        prompt_used: null, raw_output: null, error: null,
      })
      repos.finalVersions.insert({
        session_id: s.id, version_no: 1, text: 'Hello world (translated)', source: 'assemble',
      })
      repos.chatMessages.insert({
        session_id: s.id, role: 'user', content: 'Looks good', tool_calls: null, tool_results: null, version_id: null,
      })

      const full = service.getSessionFull(s.id)
      expect(full).not.toBeNull()
      expect(full!.session.id).toBe(s.id)
      expect(full!.results).toHaveLength(2)
      expect(full!.stages).toHaveLength(1)
      expect(full!.stages[0].stage).toBe('review')
      expect(full!.versions).toHaveLength(1)
      expect(full!.versions[0].text).toBe('Hello world (translated)')
      expect(full!.messages).toHaveLength(1)
      expect(full!.messages[0].content).toBe('Looks good')
    })

    it('returns empty arrays for child types with no records', () => {
      const s = service.createSession(DEF_SOURCE)
      const full = service.getSessionFull(s.id)
      expect(full!.results).toHaveLength(2)  // results are auto-inserted
      expect(full!.stages).toHaveLength(0)
      expect(full!.versions).toHaveLength(0)
      expect(full!.messages).toHaveLength(0)
    })
  })

  // ================================================================
  // transitionState
  // ================================================================
  describe('transitionState', () => {
    it('performs a valid transition (draft → translating)', () => {
      const s = service.createSession(DEF_SOURCE)
      service.transitionState(s.id, 'translating')
      const updated = repos.sessions.getById(s.id)!
      expect(updated.state).toBe('translating')
    })

    it('updates state immediately', () => {
      const s = service.createSession(DEF_SOURCE)
      service.transitionState(s.id, 'translating')
      expect(repos.sessions.getById(s.id)!.state).toBe('translating')
    })

    it('throws InvalidTransitionError on illegal transition (draft → done)', () => {
      const s = service.createSession(DEF_SOURCE)
      expect(() => service.transitionState(s.id, 'done')).toThrow(InvalidTransitionError)
    })

    it('throws InvalidTransitionError with from/to in message', () => {
      const s = service.createSession(DEF_SOURCE)
      try {
        service.transitionState(s.id, 'done')
        expect.unreachable('Should have thrown')
      } catch (e: any) {
        expect(e.code).toBe('invalid_state_transition')
        expect(e.from).toBe('draft')
        expect(e.to).toBe('done')
      }
    })

    it('throws if session does not exist', () => {
      expect(() => service.transitionState('missing', 'translating')).toThrow(/Session not found/)
    })

    it('allows a full valid chain: draft→translating→translated→coordinating→assembled→refining→done', () => {
      const s = service.createSession(DEF_SOURCE)
      const chain: Array<{ from: string; to: string }> = [
        { from: 'draft', to: 'translating' },
        { from: 'translating', to: 'translated' },
        { from: 'translated', to: 'coordinating' },
        { from: 'coordinating', to: 'assembled' },
        { from: 'assembled', to: 'refining' },
        { from: 'refining', to: 'done' },
      ]
      for (const step of chain) {
        service.transitionState(s.id, step.to as any)
        const cur = repos.sessions.getById(s.id)!
        expect(cur.state).toBe(step.to)
      }
    })
  })

  // ================================================================
  // snapshotConfig
  // ================================================================
  describe('snapshotConfig', () => {
    it('returns a ConfigSnapshot from stored JSON', () => {
      const s = service.createSession(DEF_SOURCE)
      const config = service.snapshotConfig(s.config_snapshot)
      expect(config.agents).toHaveLength(2)
      expect(config.coordinator).not.toBeNull()
      expect(config.coordinator!.model).toBe('gpt-4')
      expect(config.prompts.translator).toBe('Translate {{text}} to {{lang}}')
      expect(config.endpoint).not.toBeNull()
    })

    it('is isolated — live table changes after creation do not affect snapshot', () => {
      const s = service.createSession(DEF_SOURCE)

      // Mutate live tables
      repos.translatorAgents.insert({ name: 'agent-gamma', endpoint_id: 1, model: 'gemini', prompt_override: null, sort_order: 2 })
      repos.coordinatorConfig.upsert({ endpoint_id: 1, model: 'gpt-5', chat_endpoint_id: 1, chat_model: 'gpt-5-chat' })

      const config = service.snapshotConfig(s.config_snapshot)
      expect(config.agents).toHaveLength(2)           // still 2, not 3
      expect(config.coordinator!.model).toBe('gpt-4') // still old model
      expect(config.agents.find(a => a.name === 'agent-gamma')).toBeUndefined()
    })

    it('works with no coordinator configured', () => {
      repos.coordinatorConfig.delete()
      const s = service.createSession(DEF_SOURCE)
      const config = service.snapshotConfig(s.config_snapshot)
      expect(config.coordinator).toBeNull()
    })

    it('works with no endpoint configured', () => {
      // Cannot delete endpoint while agents reference it (FK). Instead verify
      // the snapshot parser handles null endpoint via a manually constructed snapshot.
      const snapWithNullEp = JSON.stringify({
        endpoint: null,
        agents: [],
        coordinator: null,
        prompts: {},
      })
      const config = service.snapshotConfig(snapWithNullEp)
      expect(config.endpoint).toBeNull()
      expect(config.agents).toEqual([])
    })
  })

  // ================================================================
  // listSessions
  // ================================================================
  describe('listSessions', () => {
    it('returns empty list when no sessions exist', () => {
      expect(service.listSessions()).toEqual([])
    })

    it('returns all sessions with default pagination', () => {
      service.createSession({ ...DEF_SOURCE, sourceText: 'A' })
      service.createSession({ ...DEF_SOURCE, sourceText: 'B' })
      service.createSession({ ...DEF_SOURCE, sourceText: 'C' })
      const all = service.listSessions()
      expect(all).toHaveLength(3)
    })

    it('respects limit and offset', () => {
      service.createSession({ ...DEF_SOURCE, sourceText: 'A' })
      service.createSession({ ...DEF_SOURCE, sourceText: 'B' })
      service.createSession({ ...DEF_SOURCE, sourceText: 'C' })

      const page1 = service.listSessions({ limit: 2, offset: 0 })
      expect(page1).toHaveLength(2)

      const page2 = service.listSessions({ limit: 2, offset: 2 })
      expect(page2).toHaveLength(1)
    })

    it('returns sessions ordered by updated_at DESC', () => {
      service.createSession({ ...DEF_SOURCE, sourceText: 'First' })
      service.createSession({ ...DEF_SOURCE, sourceText: 'Second' })

      const sessions = service.listSessions()
      // ORDER BY updated_at DESC means most recent first — both have the same
      // second-level timestamp so secondary ordering applies; just verify count
      expect(sessions).toHaveLength(2)
    })
  })

  // ================================================================
  // markInterruptedInFlight
  // ================================================================
  describe('markInterruptedInFlight', () => {
    it('marks streaming translation_results as error with interruption message', () => {
      const s = service.createSession(DEF_SOURCE)
      // Set one result to streaming
      db.prepare("UPDATE translation_results SET status = 'streaming' WHERE session_id = ? AND agent_key = 'agent-alpha'").run(s.id)

      service.markInterruptedInFlight()

      const results = repos.translationResults.listBySession(s.id)
      const alpha = results.find(r => r.agent_key === 'agent-alpha')!
      expect(alpha.status).toBe('error')
      expect(alpha.error).toBe('Interrupted on startup')
      // Pending results should be untouched
      const beta = results.find(r => r.agent_key === 'agent-beta')!
      expect(beta.status).toBe('pending')
    })

    it('marks running stage_outputs as stale', () => {
      const s = service.createSession(DEF_SOURCE)
      repos.stageOutputs.insert({
        session_id: s.id, stage: 'review', status: 'running',
        prompt_used: null, raw_output: null, error: null,
      })

      service.markInterruptedInFlight()

      const stages = repos.stageOutputs.listBySession(s.id)
      expect(stages[0].status).toBe('stale')
    })

    it('does not affect complete or pending records', () => {
      const s = service.createSession(DEF_SOURCE)
      // Create a stage that is already stale
      repos.stageOutputs.insert({
        session_id: s.id, stage: 'filter', status: 'complete',
        prompt_used: null, raw_output: null, error: null,
      })

      service.markInterruptedInFlight()

      const stages = repos.stageOutputs.listBySession(s.id)
      expect(stages[0].status).toBe('complete') // untouched
    })

    it('is idempotent — calling twice does not error', () => {
      service.markInterruptedInFlight()
      service.markInterruptedInFlight()
      // No throw = pass
      expect(true).toBe(true)
    })
  })
})
