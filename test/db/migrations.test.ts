import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../../src/lib/db/migrate'
import { closeDb } from '../../src/lib/db/index'
import fs from 'fs'
import path from 'path'

const TEST_DB_PATH = path.join(process.cwd(), 'data', 'test-migrations.db')

function createMemoryDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  return db
}

function createFileDb(): Database.Database {
  try { fs.unlinkSync(TEST_DB_PATH) } catch { /* ok */ }
  const db = new Database(TEST_DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  return db
}

function listTables(db: Database.Database): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all() as { name: string }[]
  return rows.map(r => r.name)
}

describe('DB Migrations — In-Memory DB', () => {
  let db: Database.Database

  beforeEach(() => { db = createMemoryDb() })
  afterEach(() => { db.close(); closeDb() })

  it('creates migrations table', () => {
    migrate(db)
    const tables = listTables(db)
    expect(tables).toContain('migrations')
  })

  it('creates all domain tables', () => {
    migrate(db)
    const tables = listTables(db)
    expect(tables).toContain('endpoints')
    expect(tables).toContain('prompt_templates')
    expect(tables).toContain('translator_agents')
    expect(tables).toContain('coordinator_config')
    expect(tables).toContain('settings')
    expect(tables).toContain('sessions')
    expect(tables).toContain('translation_results')
    expect(tables).toContain('stage_outputs')
    expect(tables).toContain('final_versions')
    expect(tables).toContain('chat_messages')
    // Migration 0002 adds preset tables
    expect(tables).toContain('config_presets')
    expect(tables).toContain('config_preset_agents')
    expect(tables).toContain('config_preset_coordinator')
    expect(tables).toContain('config_preset_prompts')
    // Migration 0003 adds the direction-aware vNext domain tables.
    expect(tables).toContain('agent_archetypes')
    expect(tables).toContain('agent_direction_variants')
    expect(tables).toContain('direction_prompt_bundles')
    expect(tables).toContain('workspace_drafts')
    expect(tables).toContain('workflow_presets')
    expect(tables).toContain('workflow_preset_revisions')
    expect(tables).toContain('agent_invocations')
    expect(tables).toContain('run_events')
    expect(tables).toContain('text_patches')
    expect(tables).toContain('batch_jobs')
    expect(tables).toContain('batch_items')
    expect(tables).toContain('workspace_model_profiles')
    expect(tables).toContain('prompt_bundle_families')
    expect(tables).toContain('prompt_bundle_revisions')
    expect(tables).toContain('session_run_controls')
    // Migrations 0009-0014 add project memory, onboarding capability profiles,
    // the privacy-safe LLM call ledger, draft binding, idempotency hashes, and
    // non-destructive legacy Agent endpoint removal.
    expect(tables).toContain('translation_projects')
    expect(tables).toContain('project_resources')
    expect(tables).toContain('project_resource_revisions')
    expect(tables).toContain('project_snapshots')
    expect(tables).toContain('project_snapshot_entries')
    expect(tables).toContain('project_memory_suggestions')
    expect(tables).toContain('session_project_contexts')
    expect(tables).toContain('project_idempotency_records')
    expect(tables).toContain('session_idempotency_records')
    expect(tables).toContain('onboarding_state')
    expect(tables).toContain('endpoint_capability_profiles')
    expect(tables).toContain('llm_call_records')
    const draftColumns = db.prepare(
      "PRAGMA table_info('workspace_drafts')",
    ).all() as Array<{ name: string }>
    expect(draftColumns.map((column) => column.name)).toContain(
      'selected_project_id',
    )
    expect(tables.length).toBeGreaterThanOrEqual(35)
  })

  it('is idempotent — 3x migrate → 1 version', () => {
    migrate(db); migrate(db); migrate(db)
    const version = (db.prepare('SELECT MAX(version) as v FROM migrations').get() as { v: number | null }).v
    expect(version).toBe(14)
    const count = (db.prepare('SELECT COUNT(*) as c FROM migrations').get() as { c: number }).c
    expect(count).toBe(14)
  })

  it('creates config_presets and child tables (migration 0002)', () => {
    migrate(db)
    const tables = listTables(db)
    expect(tables).toContain('config_presets')
    expect(tables).toContain('config_preset_agents')
    expect(tables).toContain('config_preset_coordinator')
    expect(tables).toContain('config_preset_prompts')
  })

  it('drops parsed_output column from stage_outputs (migration 0002)', () => {
    migrate(db)
    const cols = db.prepare("PRAGMA table_info('stage_outputs')").all() as { name: string }[]
    const names = cols.map((c) => c.name)
    expect(names).not.toContain('parsed_output')
    expect(names).toContain('raw_output')
  })

  it('has correct endpoints columns', () => {
    migrate(db)
    const cols = db.prepare("PRAGMA table_info('endpoints')").all() as { name: string }[]
    const names = cols.map(c => c.name)
    ;['id','name','base_url','chat_completions_path','api_key','created_at'].forEach(n => expect(names).toContain(n))
  })

  it('CHECK on prompt_templates.kind', () => {
    migrate(db)
    expect(() => db.prepare("INSERT INTO prompt_templates (kind,name,content) VALUES ('x','t','c')").run()).toThrow()
  })

  it('CHECK on coordinator_config id=1', () => {
    migrate(db)
    expect(() => db.prepare("INSERT INTO coordinator_config (id,model) VALUES (2,'gpt-4')").run()).toThrow()
  })

  it('CHECK on translation_results.status', () => {
    migrate(db)
    expect(() => db.prepare("INSERT INTO translation_results (session_id,agent_key,agent_snapshot,status) VALUES ('s1','a1','{}','bad')").run()).toThrow()
  })

  it('UNIQUE(session_id, agent_key)', () => {
    migrate(db)
    db.prepare("INSERT INTO sessions (id,source_text,config_snapshot) VALUES ('s1','t','{}')").run()
    db.prepare("INSERT INTO translation_results (session_id,agent_key,agent_snapshot) VALUES ('s1','a1','{}')").run()
    expect(() => db.prepare("INSERT INTO translation_results (session_id,agent_key,agent_snapshot) VALUES ('s1','a1','{}')").run()).toThrow()
  })

  it('UNIQUE(session_id, stage)', () => {
    migrate(db)
    db.prepare("INSERT INTO sessions (id,source_text,config_snapshot) VALUES ('s1','t','{}')").run()
    db.prepare("INSERT INTO stage_outputs (session_id,stage) VALUES ('s1','review')").run()
    expect(() => db.prepare("INSERT INTO stage_outputs (session_id,stage) VALUES ('s1','review')").run()).toThrow()
  })

  it('UNIQUE(session_id, version_no)', () => {
    migrate(db)
    db.prepare("INSERT INTO sessions (id,source_text,config_snapshot) VALUES ('s1','t','{}')").run()
    db.prepare("INSERT INTO final_versions (session_id,version_no,text,source) VALUES ('s1',1,'t','assemble')").run()
    expect(() => db.prepare("INSERT INTO final_versions (session_id,version_no,text,source) VALUES ('s1',1,'t2','edit')").run()).toThrow()
  })

  it('accepts every append-only text version source', () => {
    migrate(db)
    db.prepare(
      "INSERT INTO sessions (id,source_text,config_snapshot) VALUES ('s1','t','{}')",
    ).run()
    for (const [index, source] of [
      'assemble',
      'main_draft',
      'edit',
      'restore',
      'revert',
    ].entries()) {
      db.prepare(
        'INSERT INTO final_versions (session_id,version_no,text,source) VALUES (?,?,?,?)',
      ).run('s1', index + 1, source, source)
    }
    expect(
      (
        db.prepare(
          "SELECT COUNT(*) AS count FROM final_versions WHERE session_id='s1'",
        ).get() as { count: number }
      ).count,
    ).toBe(5)
  })
})

describe('DB Migrations — File DB', () => {
  let db: Database.Database

  beforeEach(() => { db = createFileDb() })
  afterEach(() => { db.close(); closeDb(); try { fs.unlinkSync(TEST_DB_PATH) } catch { /* ok */ } })

  it('persists migration across connections', () => {
    migrate(db)
    db.close()
    const db2 = new Database(TEST_DB_PATH)
    db2.pragma('journal_mode = WAL')
    db2.pragma('foreign_keys = ON')
    migrate(db2)
    const v = (db2.prepare('SELECT MAX(version) as v FROM migrations').get() as { v: number | null }).v
    expect(v).toBe(14)
    expect(listTables(db2)).toContain('endpoints')
    expect(listTables(db2)).toContain('config_presets')
    expect(listTables(db2)).toContain('agent_direction_variants')
    db2.close()
  })
})

describe('DB Migrations — Cascade Delete', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createMemoryDb()
    migrate(db)
    db.prepare("INSERT INTO sessions (id,source_text,config_snapshot) VALUES ('s1','Hello','{}')").run()
    db.prepare("INSERT INTO translation_results (session_id,agent_key,agent_snapshot) VALUES ('s1','a1','{}')").run()
    db.prepare("INSERT INTO stage_outputs (session_id,stage) VALUES ('s1','review')").run()
    db.prepare("INSERT INTO final_versions (session_id,version_no,text,source) VALUES ('s1',1,'text','assemble')").run()
    db.prepare("INSERT INTO chat_messages (session_id,role,content) VALUES ('s1','user','hi')").run()
  })
  afterEach(() => { db.close(); closeDb() })

  it('CASCADE translation_results', () => {
    db.prepare("DELETE FROM sessions WHERE id='s1'").run()
    expect((db.prepare("SELECT COUNT(*) as c FROM translation_results").get() as {c:number}).c).toBe(0)
  })
  it('CASCADE stage_outputs', () => {
    db.prepare("DELETE FROM sessions WHERE id='s1'").run()
    expect((db.prepare("SELECT COUNT(*) as c FROM stage_outputs").get() as {c:number}).c).toBe(0)
  })
  it('CASCADE final_versions', () => {
    db.prepare("DELETE FROM sessions WHERE id='s1'").run()
    expect((db.prepare("SELECT COUNT(*) as c FROM final_versions").get() as {c:number}).c).toBe(0)
  })
  it('CASCADE chat_messages', () => {
    db.prepare("DELETE FROM sessions WHERE id='s1'").run()
    expect((db.prepare("SELECT COUNT(*) as c FROM chat_messages").get() as {c:number}).c).toBe(0)
  })
})
