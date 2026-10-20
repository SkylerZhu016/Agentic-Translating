import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { migrate } from '../../src/lib/db/migrate'
import { createSessionsRepo } from '../../src/lib/db/repositories'
import { createHandlers } from '../../app/api/sessions/handlers'

describe('bounded session history', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    migrate(db)
    const insert = db.prepare(`
      INSERT INTO sessions (
        id, source_text, source_lang, target_lang, state, config_snapshot,
        direction, created_at, updated_at
      ) VALUES (?, ?, 'source', 'target', 'draft', '{}', ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')
    `)
    for (let index = 1; index <= 9; index++) {
      insert.run(
        `session-${index}`,
        `source ${index}`,
        ['en_to_zh', 'zh_to_en', 'custom'][(index - 1) % 3],
      )
    }
  })

  afterEach(() => db.close())

  it('filters before pagination and retains the complete direction count', async () => {
    const response = await createHandlers(db).GET(
      new NextRequest('http://localhost/api/sessions?direction=zh_to_en&limit=1&offset=1'),
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.total).toBe(3)
    expect(body.sessions.map((session: { id: string }) => session.id)).toEqual(['session-5'])
  })

  it('keeps tied timestamps stable across adjacent pages', () => {
    const sessions = createSessionsRepo(db)
    const first = sessions.listPage({ limit: 4, offset: 0 })
    const second = sessions.listPage({ limit: 4, offset: 4 })
    expect([...first, ...second].map((session) => session.id)).toEqual([
      'session-9', 'session-8', 'session-7', 'session-6',
      'session-5', 'session-4', 'session-3', 'session-2',
    ])
    expect(sessions.count('custom')).toBe(3)
    expect(sessions.count()).toBe(9)
  })

  it('returns an empty out-of-range page with its correct total', async () => {
    const response = await createHandlers(db).GET(
      new NextRequest('http://localhost/api/sessions?direction=custom&offset=999999999999999999999999999999'),
    )
    const body = await response.json()
    expect(body.sessions).toEqual([])
    expect(body.total).toBe(3)
  })

  it('keeps unread sessions on their creation-order page when a background run updates them', async () => {
    const handlers = createHandlers(db)
    const first = await handlers.GET(new NextRequest(
      'http://localhost/api/sessions?direction=en_to_zh&order=created&limit=1',
    ))
    expect((await first.json()).sessions.map((session: { id: string }) => session.id)).toEqual(['session-7'])
    db.prepare(
      "UPDATE sessions SET updated_at='2026-10-20 12:00:00' WHERE id='session-4'",
    ).run()
    const second = await handlers.GET(new NextRequest(
      'http://localhost/api/sessions?direction=en_to_zh&order=created&limit=1&offset=1',
    ))
    expect((await second.json()).sessions.map((session: { id: string }) => session.id)).toEqual(['session-4'])
    const legacy = await handlers.GET(new NextRequest(
      'http://localhost/api/sessions?direction=en_to_zh&limit=1',
    ))
    expect((await legacy.json()).sessions.map((session: { id: string }) => session.id)).toEqual(['session-4'])
  })

  it('uses the history indexes without sorting full session records', () => {
    const directionPlan = db.prepare(`
      EXPLAIN QUERY PLAN SELECT * FROM sessions WHERE direction=?
      ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?
    `).all('en_to_zh', 20, 0) as Array<{ detail: string }>
    const allPlan = db.prepare(`
      EXPLAIN QUERY PLAN SELECT * FROM sessions
      ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(20, 0) as Array<{ detail: string }>
    const createdPlan = db.prepare(`
      EXPLAIN QUERY PLAN SELECT * FROM sessions WHERE direction=?
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).all('en_to_zh', 20, 0) as Array<{ detail: string }>
    const createdAllPlan = db.prepare(`
      EXPLAIN QUERY PLAN SELECT * FROM sessions
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(20, 0) as Array<{ detail: string }>
    expect(directionPlan.map((row) => row.detail).join('\n')).toContain('idx_sessions_direction_history')
    expect(allPlan.map((row) => row.detail).join('\n')).toContain('idx_sessions_history')
    expect(createdPlan.map((row) => row.detail).join('\n')).toContain('idx_sessions_direction_created_history')
    expect(createdAllPlan.map((row) => row.detail).join('\n')).toContain('idx_sessions_created_history')
    expect([...directionPlan, ...allPlan, ...createdPlan, ...createdAllPlan].some((row) => /TEMP B-TREE/.test(row.detail))).toBe(false)
  })
})
