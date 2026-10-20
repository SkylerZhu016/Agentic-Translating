import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../../src/lib/db/migrate'
import { createVNextRepositories } from '../../src/lib/db/vnext-repositories'
import { POST } from '../../app/api/workflow-presets/[id]/recover/route'

describe('workflow preset recovery', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    globalThis.__db = db
    db.prepare(`
      INSERT INTO workflow_presets (
        id, name, description, direction, current_revision_no,
        deleted_at, created_at, updated_at
      ) VALUES (
        'saved', 'My workflow', 'Kept description', 'en_to_zh', 2,
        '2026-01-02 00:00:00', '2026-01-01 00:00:00', '2026-01-02 00:00:00'
      )
    `).run()
    const insert = db.prepare(`
      INSERT INTO workflow_preset_revisions (
        id, preset_id, revision_no, contract_json, created_at
      ) VALUES (?, 'saved', ?, ?, '2026-01-01 00:00:00')
    `)
    insert.run('revision-1', 1, JSON.stringify({ taskBriefTemplate: 'first' }))
    insert.run('revision-2', 2, JSON.stringify({ taskBriefTemplate: 'second' }))
  })

  afterEach(() => {
    delete globalThis.__db
    db.close()
  })

  function recover(id: string) {
    return POST(
      new Request(`http://localhost/api/workflow-presets/${id}/recover`, { method: 'POST' }),
      { params: Promise.resolve({ id }) },
    )
  }

  it('restores a deleted preset with an empty body while preserving its revision history', async () => {
    const repo = createVNextRepositories(db).workflowPresets
    const revisions = db.prepare(
      'SELECT * FROM workflow_preset_revisions ORDER BY revision_no',
    ).all()
    expect(repo.list('en_to_zh')).toEqual([])
    const response = await recover('saved')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      id: 'saved',
      name: 'My workflow',
      description: 'Kept description',
      direction: 'en_to_zh',
      currentRevisionNo: 2,
      deletedAt: null,
      createdAt: '2026-01-01 00:00:00',
    })
    expect(repo.list('en_to_zh').map((preset) => preset.id)).toEqual(['saved'])
    expect(db.prepare(
      'SELECT * FROM workflow_preset_revisions ORDER BY revision_no',
    ).all()).toEqual(revisions)
  })

  it('is idempotent for an active preset, including its metadata timestamp', async () => {
    db.prepare(`
      UPDATE workflow_presets
      SET deleted_at=NULL, updated_at='2026-01-03 00:00:00' WHERE id='saved'
    `).run()
    const before = createVNextRepositories(db).workflowPresets.get('saved')
    const first = await recover('saved')
    const second = await recover('saved')
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(await first.json()).toEqual(before)
    expect(await second.json()).toEqual(before)
    expect(createVNextRepositories(db).workflowPresets.listRevisions('saved')).toHaveLength(2)
  })

  it('returns 404 for an unknown preset without changing existing records', async () => {
    const before = db.prepare('SELECT * FROM workflow_presets').all()
    const response = await recover('unknown')
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not_found' })
    expect(db.prepare('SELECT * FROM workflow_presets').all()).toEqual(before)
  })
})
