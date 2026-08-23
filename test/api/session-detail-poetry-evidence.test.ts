import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { migrate } from '../../src/lib/db/migrate'

const { checkTranslationEvidence } = vi.hoisted(() => ({
  checkTranslationEvidence: vi.fn(() => ({ summary: 'checked' })),
}))

vi.mock('@/src/lib/evidence/checker', () => ({ checkTranslationEvidence }))

import { createHandlers } from '../../app/api/sessions/[id]/handlers'

describe('session detail poetry evidence', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    checkTranslationEvidence.mockClear()
  })

  afterEach(() => {
    db.close()
  })

  it('passes the frozen task brief into restored final evidence analysis', async () => {
    db.prepare(`
      INSERT INTO sessions (
        id, source_text, source_lang, target_lang, direction, state,
        task_brief, config_snapshot
      ) VALUES (?, ?, 'English', 'Chinese', 'en_to_zh', 'assembled', ?, ?)
    `).run(
      'poetry-detail',
      'One\nTwo\nThree\nFour',
      'Do not force rhyme; preserve the questions.',
      JSON.stringify({ constraints: { poetryMode: 'on' } }),
    )
    const version = db.prepare(`
      INSERT INTO final_versions (session_id, version_no, text, source)
      VALUES ('poetry-detail', 1, '一\n二\n三\n四', 'assemble')
      RETURNING id
    `).get() as { id: number }
    db.prepare(`
      UPDATE sessions SET final_version_id=? WHERE id='poetry-detail'
    `).run(version.id)

    const response = await createHandlers(db).GET(
      new NextRequest('http://localhost/api/sessions/poetry-detail'),
      { params: Promise.resolve({ id: 'poetry-detail' }) },
    )

    expect(response.status).toBe(200)
    expect(checkTranslationEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: 'en_to_zh',
        sourceText: 'One\nTwo\nThree\nFour',
        taskBrief: 'Do not force rhyme; preserve the questions.',
        translatedText: '一\n二\n三\n四',
      }),
    )
  })
})
