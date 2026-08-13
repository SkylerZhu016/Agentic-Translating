import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { migrate } from '@/src/lib/db/migrate'
import { seed } from '@/src/lib/db/seed'
import { createProjectRepositories } from '@/src/lib/db/project-repositories'
import {
  DELETE,
  GET,
  PUT,
} from '@/app/api/workspace-drafts/[direction]/route'

describe('workspace draft project selection API', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    seed(db)
    globalThis.__db = db
  })

  afterEach(() => {
    delete globalThis.__db
    db.close()
  })

  it('round-trips selectedProjectId and clears it with the draft', async () => {
    const project = createProjectRepositories(db).projects.create({
      name: 'Draft API project',
      description: '',
      direction: 'en_to_zh',
      sourceLang: 'English',
      targetLang: 'Chinese',
    })
    const params = { params: Promise.resolve({ direction: 'en_to_zh' }) }
    const putResponse = await PUT(
      new NextRequest('http://localhost/api/workspace-drafts/en_to_zh', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceText: 'draft source',
          taskBrief: 'draft brief',
          selectedProjectId: project.id,
          selectedPresetRevisionId: null,
          allowedAgentVariantIds: [],
          reviewMode: 'main_editor',
          promptBundleRevisionId: null,
          constraints: {},
        }),
      }),
      params,
    )
    expect(putResponse.status).toBe(200)
    expect((await putResponse.json()).selectedProjectId).toBe(project.id)

    const getResponse = await GET(
      new NextRequest('http://localhost/api/workspace-drafts/en_to_zh'),
      params,
    )
    expect((await getResponse.json()).selectedProjectId).toBe(project.id)

    expect(
      (
        await DELETE(
          new NextRequest('http://localhost/api/workspace-drafts/en_to_zh', {
            method: 'DELETE',
          }),
          params,
        )
      ).status,
    ).toBe(204)
    const cleared = await GET(
      new NextRequest('http://localhost/api/workspace-drafts/en_to_zh'),
      params,
    )
    expect(await cleared.json()).toEqual(
      expect.objectContaining({ sourceText: '', selectedProjectId: null }),
    )
  })

  it('defaults omitted selectedProjectId to null for older clients', async () => {
    const response = await PUT(
      new NextRequest('http://localhost/api/workspace-drafts/en_to_zh', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceText: 'old client',
          taskBrief: '',
          selectedPresetRevisionId: null,
          allowedAgentVariantIds: [],
          reviewMode: 'main_editor',
          constraints: {},
        }),
      }),
      { params: Promise.resolve({ direction: 'en_to_zh' }) },
    )
    expect(response.status).toBe(200)
    expect((await response.json()).selectedProjectId).toBeNull()
  })
})
