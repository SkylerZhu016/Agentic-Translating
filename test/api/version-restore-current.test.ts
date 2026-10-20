import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../src/lib/db/migrate'
import { createHandlers as createDetailHandlers } from '../../app/api/sessions/[id]/handlers'
import { createHandlers as createRestoreHandlers } from '../../app/api/sessions/[id]/versions/[versionNo]/restore/handlers'
import { GET as exportSession } from '../../app/api/sessions/[id]/export/route'

describe('restored version publication', () => {
  let db: Database.Database
  let previousVersionId: number

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    globalThis.__db = db
    db.prepare(`
      INSERT INTO sessions (id, source_text, state, config_snapshot)
      VALUES ('restore-session', 'Source text', 'refining', '{}')
    `).run()
    const insert = db.prepare(`
      INSERT INTO final_versions (session_id, version_no, text, source)
      VALUES ('restore-session', ?, ?, ?)
    `)
    insert.run(1, 'Original text', 'assemble')
    previousVersionId = Number(insert.run(2, 'Edited text', 'edit').lastInsertRowid)
    db.prepare(
      "UPDATE sessions SET final_version_id=?, updated_at='2026-01-01 00:00:00' WHERE id='restore-session'",
    ).run(previousVersionId)
  })

  afterEach(() => {
    delete globalThis.__db
    db.close()
  })

  function restore() {
    return createRestoreHandlers(db).POST(
      new NextRequest('http://localhost/api/sessions/restore-session/versions/1/restore', { method: 'POST' }),
      { params: Promise.resolve({ id: 'restore-session', versionNo: '1' }) },
    )
  }

  it('makes the restored version current in the response, workspace, audit message and export', async () => {
    const response = await restore()
    expect(response.status).toBe(200)
    const version = await response.json()
    expect(version).toMatchObject({ version_no: 3, text: 'Original text', source: 'restore' })

    const detailResponse = await createDetailHandlers(db).GET(
      new NextRequest('http://localhost/api/sessions/restore-session?view=workspace'),
      { params: Promise.resolve({ id: 'restore-session' }) },
    )
    const detail = await detailResponse.json()
    expect(detail.session.final_version_id).toBe(version.id)
    expect(detail.finalVersion).toMatchObject({ id: version.id, text: 'Original text' })
    expect(detail.latest_version_no).toBe(3)
    expect(detail.versions.map((item: { text: string }) => item.text)).toEqual([
      'Original text', 'Edited text', 'Original text',
    ])
    expect(detail.messages.at(-1)).toMatchObject({
      role: 'tool', version_id: version.id, content: '已恢复到版本 1',
    })
    expect(detail.session.updated_at).not.toBe('2026-01-01 00:00:00')

    const exportedResponse = await exportSession(
      new Request('http://localhost/api/sessions/restore-session/export?format=json'),
      { params: Promise.resolve({ id: 'restore-session' }) },
    )
    expect(exportedResponse.status).toBe(200)
    const exported = await exportedResponse.json()
    expect(exported.session.final_version_id).toBe(version.id)
    expect(exported.versions.find((item: { id: number }) => item.id === exported.session.final_version_id))
      .toMatchObject({ version_no: 3, text: 'Original text' })
  })

  it('rolls back both the new version and its pointer if the audit write fails', async () => {
    db.exec(`
      CREATE TRIGGER reject_restore_audit BEFORE INSERT ON chat_messages
      BEGIN SELECT RAISE(ABORT, 'test audit failure'); END;
    `)
    await expect(restore()).rejects.toThrow('test audit failure')
    expect(db.prepare(
      "SELECT final_version_id FROM sessions WHERE id='restore-session'",
    ).pluck().get()).toBe(previousVersionId)
    expect(db.prepare(
      "SELECT COUNT(*) FROM final_versions WHERE session_id='restore-session'",
    ).pluck().get()).toBe(2)
    expect(db.prepare(
      "SELECT COUNT(*) FROM chat_messages WHERE session_id='restore-session'",
    ).pluck().get()).toBe(0)
  })
})
