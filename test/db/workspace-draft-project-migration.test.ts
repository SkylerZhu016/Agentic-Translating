import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { createVNextRepositories } from '@/src/lib/db/vnext-repositories'
import { seed } from '@/src/lib/db/seed'
import type { WorkspaceDraft } from '@/src/lib/contracts/vnext'

describe('workspace draft migrations', () => {
  let db: Database.Database | null = null

  afterEach(() => {
    db?.close()
    db = null
  })

  it('preserves an old draft and defaults newly persisted fields safely', () => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE migrations (
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        applied_at TEXT DEFAULT (datetime('now'))
      )
    `)
    const migrationsDir = path.join(
      process.cwd(),
      'src',
      'lib',
      'db',
      'migrations',
    )
    const firstEleven = fs
      .readdirSync(migrationsDir)
      .filter((file) => /^(?:000[1-9]|001[01])_.*\.sql$/.test(file))
      .sort()
    for (const file of firstEleven) {
      const version = Number(file.slice(0, 4))
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
      db.transaction(() => {
        db!.exec(sql)
        db!.prepare(
          'INSERT INTO migrations (version, name) VALUES (?, ?)',
        ).run(version, file)
      })()
    }
    db.prepare(
      `INSERT INTO workspace_drafts (
         direction, source_text, task_brief, selected_preset_revision_id,
         allowed_agent_variant_ids, review_mode
       ) VALUES ('en_to_zh', 'legacy source', 'legacy brief', NULL, '[]',
         'main_editor')`,
    ).run()

    const migrationName = '0012_workspace_draft_project.sql'
    db.exec(fs.readFileSync(path.join(migrationsDir, migrationName), 'utf8'))
    db.prepare('INSERT INTO migrations (version, name) VALUES (12, ?)').run(
      migrationName,
    )

    const runModeMigration =
      '0018_workspace_draft_main_editor_run_mode.sql'
    db.exec(
      fs.readFileSync(path.join(migrationsDir, runModeMigration), 'utf8'),
    )
    db.prepare('INSERT INTO migrations (version, name) VALUES (18, ?)').run(
      runModeMigration,
    )

    expect(
      createVNextRepositories(db).workspaceDrafts.get('en_to_zh'),
    ).toEqual(
      expect.objectContaining({
        sourceText: 'legacy source',
        taskBrief: 'legacy brief',
        selectedProjectId: null,
        mainEditorRunMode: 'fixed_pipeline',
      }),
    )
  })

  it('persists, compares, and clears project and Main Agent mode with the draft', () => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    const migrationsDir = path.join(
      process.cwd(),
      'src',
      'lib',
      'db',
      'migrations',
    )
    const files = fs
      .readdirSync(migrationsDir)
      .filter((file) => /^\d{4}_.*\.sql$/.test(file))
      .sort()
    db.exec(`
      CREATE TABLE migrations (
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        applied_at TEXT DEFAULT (datetime('now'))
      )
    `)
    for (const file of files) {
      db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'))
    }
    const projectId = '33333333-3333-4333-8333-333333333333'
    const snapshotId = '44444444-4444-4444-8444-444444444444'
    db.prepare(
      `INSERT INTO translation_projects (
         id, name, description, direction, source_lang, target_lang,
         current_snapshot_id
       ) VALUES (?, 'Draft project', '', 'en_to_zh', 'English', 'Chinese',
         NULL)`,
    ).run(projectId)
    db.prepare(
      `INSERT INTO project_snapshots (
         id, project_id, revision_no, approved_resource_revision_ids_json,
         content_hash
       ) VALUES (?, ?, 1, '[]',
         '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e0b9c4e6a2f0d9f6b7c8a9')`,
    ).run(snapshotId, projectId)
    db.prepare(
      'UPDATE translation_projects SET current_snapshot_id=? WHERE id=?',
    ).run(snapshotId, projectId)

    const drafts = createVNextRepositories(db).workspaceDrafts
    const draft = {
      direction: 'en_to_zh',
      sourceText: 'source',
      taskBrief: 'brief',
      selectedProjectId: projectId,
      selectedPresetRevisionId: null,
      allowedAgentVariantIds: [],
      reviewMode: 'main_editor',
      mainEditorRunMode: 'tool_enabled',
      promptBundleRevisionId: null,
      constraints: {},
    } satisfies Omit<WorkspaceDraft, 'updatedAt'>
    drafts.upsert(draft)
    expect(drafts.get('en_to_zh')).toEqual(
      expect.objectContaining({
        selectedProjectId: projectId,
        mainEditorRunMode: 'tool_enabled',
      }),
    )

    expect(
      drafts.clearIfMatches({ ...draft, sourceText: 'newer source' }),
    ).toBe(false)
    expect(
      drafts.clearIfMatches({ ...draft, mainEditorRunMode: 'fixed_pipeline' }),
    ).toBe(false)
    expect(drafts.get('en_to_zh')?.sourceText).toBe('source')
    expect(drafts.clearIfMatches(draft)).toBe(true)
    expect(drafts.get('en_to_zh')).toBeNull()
    seed(db)
    expect(drafts.get('en_to_zh')).toBeNull()
  })
})
