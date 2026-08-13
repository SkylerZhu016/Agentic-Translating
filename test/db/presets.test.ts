/**
 * presets.test.ts — tests for the preset repository (Wave 3 Task 16)
 *
 * Covers:
 *   - createPreset + getPreset roundtrip
 *   - duplicatePreset independence (modifying copy does not affect source)
 *   - loadPresetWithValidation orphan detection
 *   - applyPresetToGlobalConfig transactional (mock failure → rollback)
 *
 * Uses real SQLite in-memory DB per test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { createRepositories, type Repositories } from '../../src/lib/db/repositories'

// ── Inline migration SQL ─────────────────────────────────────────
const MIGRATION_SQL_0001 = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/db/migrations/0001_init.sql'),
  'utf-8',
)
const MIGRATION_SQL_0002 = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/db/migrations/0002_presets_and_drop_parsed_output.sql'),
  'utf-8',
)

// =============================================================================
// Helpers
// =============================================================================

function createMemoryDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(MIGRATION_SQL_0001)
  db.exec(MIGRATION_SQL_0002)
  return db
}

/** Insert a preset agent row that references a non-existent endpoint.
 *  Requires temporarily disabling FK checks since the schema enforces
 *  `endpoint_id REFERENCES endpoints(id)`. */
function insertOrphanAgentRef(
  db: Database.Database,
  presetId: number,
  agentName: string,
  orphanEndpointId: number,
  sortOrder: number = 0,
): void {
  // db.pragma('foreign_keys', { simple: true }) returns 1 or 0 (number)
  const wasFkOn = db.pragma('foreign_keys', { simple: true }) === 1
  if (wasFkOn) db.pragma('foreign_keys = OFF')
  try {
    db.prepare(
      'INSERT INTO config_preset_agents (preset_id, name, endpoint_id, model, prompt_override, sort_order) VALUES (?, ?, ?, ?, NULL, ?)',
    ).run(presetId, agentName, orphanEndpointId, 'm', sortOrder)
  } finally {
    if (wasFkOn) db.pragma('foreign_keys = ON')
  }
}

/** Insert a preset coordinator row that references non-existent endpoints. */
function insertOrphanCoordinatorRef(
  db: Database.Database,
  presetId: number,
  orphanEndpointId: number | null,
  orphanChatEndpointId: number | null,
): void {
  const wasFkOn = db.pragma('foreign_keys', { simple: true }) === 1
  if (wasFkOn) db.pragma('foreign_keys = OFF')
  try {
    db.prepare(
      'INSERT INTO config_preset_coordinator (preset_id, endpoint_id, model, chat_endpoint_id, chat_model) VALUES (?, ?, ?, ?, ?)',
    ).run(presetId, orphanEndpointId, 'coord', orphanChatEndpointId, 'chat')
  } finally {
    if (wasFkOn) db.pragma('foreign_keys = ON')
  }
}

/** Seed an endpoint with id=1 and return its id */
function seedEndpoint(repos: Repositories, id: number = 1): number {
  repos.endpoints.insert({
    name: `test-ep-${id}`,
    base_url: 'https://api.test.com',
    api_key: 'sk-test',
  })
  return id
}

/** Build a full preset content payload (agents + coordinator + prompts) */
function fullPresetContent() {
  return {
    agents: [
      { name: 'Agent A', endpoint_id: 1, model: 'gpt-4', prompt_override: null, sort_order: 0 },
      { name: 'Agent B', endpoint_id: 1, model: 'claude-3', prompt_override: 'Custom', sort_order: 1 },
    ],
    coordinator: {
      endpoint_id: 1,
      model: 'gpt-4o',
      chat_endpoint_id: 1,
      chat_model: 'gpt-4o-mini',
    },
    prompts: [
      { kind: 'translator' as const, name: '默认翻译', content: 'Translate {{source_text}}' },
      { kind: 'review' as const, name: '审查', content: 'Review: {{context}}' },
      { kind: 'filter' as const, name: '筛选', content: 'Filter: {{context}}' },
      { kind: 'orchestrate' as const, name: '编排', content: 'Orchestrate: {{context}}' },
      { kind: 'assemble' as const, name: '组装', content: 'Assemble: {{context}}' },
    ],
  }
}

// =============================================================================
// Suite
// =============================================================================

describe('Presets Repository', () => {
  let db: Database.Database
  let repos: Repositories

  beforeEach(() => {
    db = createMemoryDb()
    repos = createRepositories(db)
    seedEndpoint(repos)
  })

  afterEach(() => {
    db.close()
  })

  // ===========================================================================
  // createPreset + getPreset roundtrip
  // ===========================================================================

  describe('create + getFull roundtrip', () => {
    it('create returns the new preset id; getFull returns the preset header', () => {
      const id = repos.presets.create('My Preset', 'A description')
      expect(typeof id).toBe('number')
      expect(id).toBeGreaterThan(0)

      const full = repos.presets.getFull(id)
      expect(full).not.toBeNull()
      expect(full!.preset.id).toBe(id)
      expect(full!.preset.name).toBe('My Preset')
      expect(full!.preset.description).toBe('A description')
      expect(full!.preset.is_builtin).toBe(0)
    })

    it('saveContent stores agents, coordinator, and prompts; getFull returns them', () => {
      const id = repos.presets.create('Content Preset')
      const content = fullPresetContent()
      repos.presets.saveContent(id, content.agents, content.coordinator, content.prompts)

      const full = repos.presets.getFull(id)!
      expect(full.agents).toHaveLength(2)
      expect(full.agents[0].name).toBe('Agent A')
      expect(full.agents[1].prompt_override).toBe('Custom')
      expect(full.coordinator).not.toBeNull()
      expect(full.coordinator!.model).toBe('gpt-4o')
      expect(full.coordinator!.chat_model).toBe('gpt-4o-mini')
      expect(full.prompts).toHaveLength(5)
      const kinds = full.prompts.map((p) => p.kind).sort()
      expect(kinds).toEqual(['assemble', 'filter', 'orchestrate', 'review', 'translator'])
    })

    it('saveContent with empty arrays stores no children', () => {
      const id = repos.presets.create('Empty Preset')
      repos.presets.saveContent(id, [], null, [])

      const full = repos.presets.getFull(id)!
      expect(full.agents).toEqual([])
      expect(full.coordinator).toBeNull()
      expect(full.prompts).toEqual([])
    })

    it('saveContent replaces previous content on re-save', () => {
      const id = repos.presets.create('Re-save Preset')
      const c1 = fullPresetContent()
      repos.presets.saveContent(id, c1.agents, c1.coordinator, c1.prompts)
      expect(repos.presets.getFull(id)!.agents).toHaveLength(2)

      // Re-save with different content
      repos.presets.saveContent(
        id,
        [{ name: 'Solo Agent', endpoint_id: 1, model: 'gpt-4', prompt_override: null, sort_order: 0 }],
        null,
        [{ kind: 'translator', name: 'only', content: 'only prompt' }],
      )

      const full = repos.presets.getFull(id)!
      expect(full.agents).toHaveLength(1)
      expect(full.agents[0].name).toBe('Solo Agent')
      expect(full.coordinator).toBeNull()
      expect(full.prompts).toHaveLength(1)
      expect(full.prompts[0].kind).toBe('translator')
    })

    it('create deduplicates names with (n) suffix', () => {
      const id1 = repos.presets.create('Same Name')
      const id2 = repos.presets.create('Same Name')
      const id3 = repos.presets.create('Same Name')

      expect(id1).not.toBe(id2)
      expect(id2).not.toBe(id3)

      const p1 = repos.presets.getFull(id1)!
      const p2 = repos.presets.getFull(id2)!
      const p3 = repos.presets.getFull(id3)!
      expect(p1.preset.name).toBe('Same Name')
      expect(p2.preset.name).toBe('Same Name (2)')
      expect(p3.preset.name).toBe('Same Name (3)')
    })

    it('list returns all presets ordered by id', () => {
      repos.presets.create('First')
      repos.presets.create('Second')
      repos.presets.create('Third')

      const list = repos.presets.list()
      expect(list).toHaveLength(3)
      expect(list[0].name).toBe('First')
      expect(list[1].name).toBe('Second')
      expect(list[2].name).toBe('Third')
    })

    it('delete removes the preset and its children (CASCADE)', () => {
      const id = repos.presets.create('To Delete')
      const content = fullPresetContent()
      repos.presets.saveContent(id, content.agents, content.coordinator, content.prompts)

      // Verify children exist
      const before = repos.presets.getFull(id)!
      expect(before.agents.length).toBeGreaterThan(0)

      repos.presets.delete(id)

      expect(repos.presets.getFull(id)).toBeNull()
      // Children must be cascade-deleted
      const agents = db.prepare('SELECT * FROM config_preset_agents WHERE preset_id = ?').all(id)
      expect(agents).toHaveLength(0)
    })
  })

  // ===========================================================================
  // duplicatePreset independence
  // ===========================================================================

  describe('duplicate', () => {
    it('creates an independent copy — modifying the copy does not affect source', () => {
      const srcId = repos.presets.create('Source Preset')
      const content = fullPresetContent()
      repos.presets.saveContent(srcId, content.agents, content.coordinator, content.prompts)

      const copyId = repos.presets.duplicate(srcId, 'Copied Preset')
      expect(copyId).not.toBe(srcId)

      // Verify both have the same content initially
      const src = repos.presets.getFull(srcId)!
      const copy = repos.presets.getFull(copyId)!
      expect(copy.agents).toHaveLength(src.agents.length)
      expect(copy.prompts).toHaveLength(src.prompts.length)
      expect(copy.coordinator?.model).toBe(src.coordinator?.model)

      // Modify the copy
      repos.presets.saveContent(
        copyId,
        [{ name: 'Different Agent', endpoint_id: 1, model: 'claude-3', prompt_override: null, sort_order: 0 }],
        null,
        [{ kind: 'translator', name: 'different', content: 'different prompt' }],
      )

      // Source must be unchanged
      const srcAfter = repos.presets.getFull(srcId)!
      expect(srcAfter.agents).toHaveLength(2)
      expect(srcAfter.agents[0].name).toBe('Agent A')
      expect(srcAfter.prompts).toHaveLength(5)

      // Copy must reflect the new content
      const copyAfter = repos.presets.getFull(copyId)!
      expect(copyAfter.agents).toHaveLength(1)
      expect(copyAfter.agents[0].name).toBe('Different Agent')
      expect(copyAfter.prompts).toHaveLength(1)
    })

    it('throws when source preset does not exist', () => {
      expect(() => repos.presets.duplicate(9999, 'Copy')).toThrow(/not found/i)
    })

    it('deduplicates the new name if it already exists', () => {
      const srcId = repos.presets.create('Original')
      repos.presets.create('Original Copy') // occupy the name

      const copyId = repos.presets.duplicate(srcId, 'Original Copy')
      const copy = repos.presets.getFull(copyId)!
      // Name should be deduplicated to 'Original Copy (2)'
      expect(copy.preset.name).toBe('Original Copy (2)')
    })

    it('preserves agent sort_order and prompt_override in the copy', () => {
      const srcId = repos.presets.create('Source')
      repos.presets.saveContent(
        srcId,
        [
          { name: 'A', endpoint_id: 1, model: 'm-a', prompt_override: 'override-a', sort_order: 5 },
          { name: 'B', endpoint_id: 1, model: 'm-b', prompt_override: null, sort_order: 10 },
        ],
        null,
        [],
      )

      const copyId = repos.presets.duplicate(srcId, 'Copy')
      const copy = repos.presets.getFull(copyId)!
      expect(copy.agents[0].sort_order).toBe(5)
      expect(copy.agents[0].prompt_override).toBe('override-a')
      expect(copy.agents[1].sort_order).toBe(10)
      expect(copy.agents[1].prompt_override).toBeNull()
    })
  })

  // ===========================================================================
  // loadPresetWithValidation — orphan endpoint detection
  // ===========================================================================

  describe('loadWithValidation', () => {
    it('returns valid=true when all endpoint references exist', () => {
      const id = repos.presets.create('Valid Preset')
      const content = fullPresetContent()
      repos.presets.saveContent(id, content.agents, content.coordinator, content.prompts)

      const result = repos.presets.loadWithValidation(id, [{ id: 1 }])
      expect(result.valid).toBe(true)
      expect(result.orphanEndpointRefs).toHaveLength(0)
      expect(result.preset.preset.id).toBe(id)
    })

    it('returns valid=false with orphan refs when endpoint does not exist', () => {
      const id = repos.presets.create('Orphan Preset')
      // Agent A references endpoint 1 (exists); Agent B references endpoint 99 (orphan).
      // The schema has a FK on endpoint_id, so we insert Agent B with FK off.
      repos.presets.saveContent(
        id,
        [{ name: 'A', endpoint_id: 1, model: 'm', prompt_override: null, sort_order: 0 }],
        { endpoint_id: 1, model: 'coord', chat_endpoint_id: 1, chat_model: 'chat' },
        [],
      )
      insertOrphanAgentRef(db, id, 'B', 99, 1)

      const result = repos.presets.loadWithValidation(id, [{ id: 1 }])
      expect(result.valid).toBe(false)
      // Should report orphan refs for endpoint 99 (agent)
      const orphanIds = result.orphanEndpointRefs.map((r) => r.endpointId)
      expect(orphanIds).toContain(99)
      // endpoint_id=1 references must NOT be flagged as orphans
      expect(orphanIds).not.toContain(1)
    })

    it('detects orphan chat_endpoint_id on coordinator', () => {
      const id = repos.presets.create('Chat Orphan')
      // Use the helper to insert a coordinator row referencing chat_endpoint_id=777 (orphan)
      insertOrphanCoordinatorRef(db, id, 1, 777)

      const result = repos.presets.loadWithValidation(id, [{ id: 1 }])
      expect(result.valid).toBe(false)
      const chatOrphan = result.orphanEndpointRefs.find((r) => r.kind === 'coordinator.chat_endpoint')
      expect(chatOrphan).toBeDefined()
      expect(chatOrphan!.endpointId).toBe(777)
    })

    it('detects orphan endpoint on agent and includes agentIndex', () => {
      const id = repos.presets.create('Agent Orphan')
      // Insert one valid agent via saveContent
      repos.presets.saveContent(
        id,
        [{ name: 'ok', endpoint_id: 1, model: 'm', prompt_override: null, sort_order: 0 }],
        null,
        [],
      )
      // Then append an orphan-referencing agent at index 1
      insertOrphanAgentRef(db, id, 'orphan', 42, 1)

      const result = repos.presets.loadWithValidation(id, [{ id: 1 }])
      expect(result.valid).toBe(false)
      const agentOrphan = result.orphanEndpointRefs.find((r) => r.kind === 'agent.endpoint')
      expect(agentOrphan).toBeDefined()
      expect(agentOrphan!.agentIndex).toBe(1)
      expect(agentOrphan!.endpointId).toBe(42)
    })

    it('throws when preset does not exist', () => {
      expect(() => repos.presets.loadWithValidation(9999, [])).toThrow(/not found/i)
    })

    it('returns valid=true when no endpoints are referenced (all null)', () => {
      const id = repos.presets.create('No Endpoints')
      repos.presets.saveContent(
        id,
        [], // no agents
        { endpoint_id: null, model: 'm', chat_endpoint_id: null, chat_model: 'chat' },
        [],
      )

      const result = repos.presets.loadWithValidation(id, [])
      expect(result.valid).toBe(true)
      expect(result.orphanEndpointRefs).toHaveLength(0)
    })
  })

  // ===========================================================================
  // applyPresetToGlobalConfig — transactional behavior
  // ===========================================================================

  describe('applyToGlobalConfig', () => {
    it('replaces global translator_agents, coordinator_config, and prompt_templates', () => {
      // Seed some existing global config
      repos.translatorAgents.insert({
        name: 'old-agent', endpoint_id: 1, model: 'old-model',
        prompt_override: null, sort_order: 0,
      })
      repos.promptTemplates.insert({
        kind: 'translator', name: 'old-default',
        content: 'old prompt', is_builtin: 1,
      })

      // Build a preset
      const id = repos.presets.create('Apply Preset')
      const content = fullPresetContent()
      repos.presets.saveContent(id, content.agents, content.coordinator, content.prompts)

      // Apply
      repos.presets.applyToGlobalConfig(id, [])

      // Global translator_agents should now match the preset's agents
      const agents = repos.translatorAgents.list()
      expect(agents).toHaveLength(2)
      expect(agents[0].name).toBe('Agent A')
      expect(agents[1].name).toBe('Agent B')
      // Old agent must be gone
      expect(agents.find((a) => a.name === 'old-agent')).toBeUndefined()

      // Coordinator must match
      const coord = repos.coordinatorConfig.get()
      expect(coord!.model).toBe('gpt-4o')
      expect(coord!.chat_model).toBe('gpt-4o-mini')

      // Prompts must match (old built-in prompt replaced)
      const prompts = repos.promptTemplates.list()
      const translatorPrompt = prompts.find((p) => p.kind === 'translator')
      expect(translatorPrompt).toBeDefined()
      expect(translatorPrompt!.content).toBe('Translate {{source_text}}')
    })

    it('skips agents that reference orphaned endpoints', () => {
      const id = repos.presets.create('Orphan Apply')
      // Insert a valid agent via saveContent
      repos.presets.saveContent(
        id,
        [{ name: 'Keep', endpoint_id: 1, model: 'm', prompt_override: null, sort_order: 0 }],
        { endpoint_id: 1, model: 'coord', chat_endpoint_id: 1, chat_model: 'chat' },
        [],
      )
      // Append an orphan-referencing agent at index 1
      insertOrphanAgentRef(db, id, 'Skip', 99, 1)
      // Replace the coordinator with one that references orphan chat_endpoint_id=99
      // (delete the existing one first)
      db.prepare('DELETE FROM config_preset_coordinator WHERE preset_id = ?').run(id)
      insertOrphanCoordinatorRef(db, id, 1, 99)

      // Apply with endpoint 99 marked as orphan
      repos.presets.applyToGlobalConfig(id, [99])

      // Agent 'Skip' must NOT be in global config (orphan endpoint)
      const agents = repos.translatorAgents.list()
      expect(agents).toHaveLength(1)
      expect(agents[0].name).toBe('Keep')

      // Coordinator: endpoint_id=1 kept, chat_endpoint_id=99 nullified
      const coord = repos.coordinatorConfig.get()
      expect(coord!.endpoint_id).toBe(1)
      expect(coord!.chat_endpoint_id).toBeNull()
    })

    it('coordinator endpoint_id is nullified when it references an orphan', () => {
      const id = repos.presets.create('Coord Orphan')
      // Insert a coordinator referencing orphan endpoint_id=55
      insertOrphanCoordinatorRef(db, id, 55, null)

      repos.presets.applyToGlobalConfig(id, [55])

      const coord = repos.coordinatorConfig.get()
      expect(coord!.endpoint_id).toBeNull()
      // model is still applied
      expect(coord!.model).toBe('coord')
    })

    it('throws when preset does not exist', () => {
      expect(() => repos.presets.applyToGlobalConfig(9999, [])).toThrow(/not found/i)
    })

    it('is transactional: a mid-apply failure rolls back global changes', () => {
      // Trigger a deterministic insert failure after the transaction has
      // deleted the current live configuration. Nullable endpoint bindings
      // are now valid and are skipped, so a NOT NULL violation is no longer
      // an appropriate rollback fixture.
      const id = repos.presets.create('Txn Fail')
      repos.presets.saveContent(
        id,
        [
          { name: 'Bad', endpoint_id: 1, model: 'm', prompt_override: null, sort_order: 0 },
        ],
        null,
        [],
      )
      db.exec(`
        CREATE TRIGGER fail_bad_translator_agent_insert
        BEFORE INSERT ON translator_agents
        WHEN NEW.name = 'Bad'
        BEGIN
          SELECT RAISE(ABORT, 'forced transactional test failure');
        END;
      `)

      // Seed an existing global agent that should survive rollback
      repos.translatorAgents.insert({
        name: 'survivor', endpoint_id: 1, model: 'm',
        prompt_override: null, sort_order: 0,
      })
      expect(repos.translatorAgents.list()).toHaveLength(1)

      // The apply must throw after its initial delete.
      expect(() => repos.presets.applyToGlobalConfig(id, [])).toThrow()

      // After rollback: the original 'survivor' agent must still exist
      // (DELETE FROM translator_agents was rolled back)
      const afterAgents = repos.translatorAgents.list()
      expect(afterAgents).toHaveLength(1)
      expect(afterAgents[0].name).toBe('survivor')

      // Coordinator upsert must also have been rolled back — coordinator_config
      // should still be in its pre-apply state (no row, since we never seeded one).
      // `get()` returns undefined when no row exists.
      const coord = repos.coordinatorConfig.get()
      expect(coord).toBeUndefined()
    })
  })
})
