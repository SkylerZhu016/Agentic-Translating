import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { encryptSecret } from '@/src/lib/security/secrets'
import { migrate, getAppliedVersion } from '@/src/lib/db/migrate'
import {
  createProjectRepositories,
  estimateProjectContextTokens,
  hashSnapshotRevisionIds,
  ProjectRepositoryError,
} from '@/src/lib/db/project-repositories'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

function projectInput(
  overrides: Partial<{
    name: string
    description: string
    direction: 'en_to_zh' | 'zh_to_en' | 'custom'
    sourceLang: string
    targetLang: string
    idempotencyKey: string
  }> = {},
) {
  return {
    name: 'Poetry project',
    description: 'A durable translation memory.',
    direction: 'en_to_zh' as const,
    sourceLang: 'English',
    targetLang: 'Chinese',
    ...overrides,
  }
}

function termContent(sourceText = 'moon', targetText = '月亮') {
  return {
    sourceText,
    targetText,
    instruction: null,
    note: '',
  }
}

describe('project translation memory repository', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createDb()
  })

  afterEach(() => {
    db.close()
  })

  it('creates a project with an immutable empty genesis snapshot and archives via CAS', () => {
    const repos = createProjectRepositories(db)
    const project = repos.projects.create(projectInput())

    expect(project.status).toBe('active')
    expect(project.currentSnapshotId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(project.currentSnapshotRevisionNo).toBe(1)
    expect(repos.snapshots.list(project.id)).toEqual([
      expect.objectContaining({
        id: project.currentSnapshotId,
        revisionNo: 1,
        approvedResourceRevisionIds: [],
        contentHash: hashSnapshotRevisionIds([]),
      }),
    ])

    const updated = repos.projects.update(project.id, {
      name: 'Updated project',
      expectedUpdatedAt: project.updatedAt,
    })
    expect(updated.name).toBe('Updated project')
    expect(() =>
      repos.projects.update(project.id, {
        description: 'stale',
        expectedUpdatedAt: project.updatedAt,
      }),
    ).toThrowError(expect.objectContaining({ code: 'stale_project_version' }))

    const archived = repos.projects.archive(project.id, {
      expectedUpdatedAt: updated.updatedAt,
      idempotencyKey: 'archive-project-0001',
    })
    expect(archived.status).toBe('archived')
    expect(
      repos.projects.archive(project.id, {
        expectedUpdatedAt: archived.updatedAt,
        idempotencyKey: 'archive-project-0002',
      }),
    ).toEqual(archived)
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM project_idempotency_records
           WHERE operation = 'project_archive' AND owner_id = ?`,
        )
        .get(project.id),
    ).toEqual({ count: 2 })
    expect(() =>
      repos.projects.archive(project.id, {
        expectedUpdatedAt: updated.updatedAt,
        idempotencyKey: 'archive-project-0002',
      }),
    ).toThrowError(expect.objectContaining({ code: 'idempotency_conflict' }))
    expect(() =>
      repos.projects.update(project.id, {
        name: 'Cannot rename an archive',
        expectedUpdatedAt: archived.updatedAt,
      }),
    ).toThrowError(expect.objectContaining({ code: 'project_archived' }))
    expect(() =>
      repos.resources.create(project.id, {
        kind: 'term',
        content: termContent(),
      }),
    ).toThrowError(expect.objectContaining({ code: 'project_archived' }))
  })

  it('keeps suggestions out of snapshots until approval appends a new revision', () => {
    const repos = createProjectRepositories(db)
    const project = repos.projects.create(projectInput())
    const genesis = repos.snapshots.list(project.id)[0]

    const created = repos.resources.create(project.id, {
      kind: 'term',
      content: termContent(),
    })
    expect(created.currentRevision.status).toBe('suggested')
    expect(repos.snapshots.list(project.id)).toEqual([genesis])

    const approved = repos.resources.approve(project.id, created.resource.id, {
      revisionId: created.currentRevision.id,
      idempotencyKey: 'approve-resource-0001',
    })
    expect(approved.revision.status).toBe('approved')
    expect(approved.revision.revisionNo).toBe(2)
    expect(approved.snapshot.revisionNo).toBe(2)
    expect(approved.snapshot.approvedResourceRevisionIds).toEqual([
      approved.revision.id,
    ])
    expect(approved.snapshot.contentHash).toBe(
      hashSnapshotRevisionIds([approved.revision.id]),
    )
    expect(repos.snapshots.getResources(project.id, approved.snapshot.id)).toEqual([
      {
        resourceId: created.resource.id,
        revision: approved.revision,
      },
    ])

    const revisions = repos.resources.listRevisions(project.id, created.resource.id)
    expect(revisions.map((revision) => revision.status)).toEqual([
      'approved',
      'suggested',
    ])
    expect(() =>
      db
        .prepare(
          `UPDATE project_resource_revisions SET status = 'rejected' WHERE id = ?`,
        )
        .run(created.currentRevision.id),
    ).toThrow(/immutable/)
    expect(() =>
      db
        .prepare('DELETE FROM project_resource_revisions WHERE id = ?')
        .run(created.currentRevision.id),
    ).toThrow(/immutable/)
  })

  it('preserves every historical snapshot when a resource is revised and re-approved', () => {
    const repos = createProjectRepositories(db)
    const project = repos.projects.create(projectInput())
    const created = repos.resources.create(project.id, {
      kind: 'term',
      content: termContent(),
    })
    const firstApproval = repos.resources.approve(
      project.id,
      created.resource.id,
      { revisionId: created.currentRevision.id },
    )
    const suggestion = repos.resources.addRevision(
      project.id,
      created.resource.id,
      {
        baseRevisionId: firstApproval.revision.id,
        content: termContent('moon', '明月'),
      },
    )

    expect(suggestion.status).toBe('suggested')
    expect(
      repos.snapshots.get(project.id, firstApproval.snapshot.id)
        ?.approvedResourceRevisionIds,
    ).toEqual([firstApproval.revision.id])

    const secondApproval = repos.resources.approve(
      project.id,
      created.resource.id,
      { revisionId: suggestion.id },
    )
    expect(secondApproval.snapshot.approvedResourceRevisionIds).toEqual([
      secondApproval.revision.id,
    ])
    expect(
      repos.snapshots.get(project.id, firstApproval.snapshot.id)
        ?.approvedResourceRevisionIds,
    ).toEqual([firstApproval.revision.id])
    expect(repos.snapshots.list(project.id).map((snapshot) => snapshot.revisionNo)).toEqual([
      3,
      2,
      1,
    ])
  })

  it('materializes a pending suggestion and resolves it only through approve or reject', () => {
    const repos = createProjectRepositories(db)
    const project = repos.projects.create(projectInput())
    const suggestion = repos.suggestions.create(project.id, {
      kind: 'proper_noun',
      content: termContent('Silver', '希尔弗'),
    })
    expect(suggestion.status).toBe('pending')

    const resource = repos.resources.create(project.id, {
      kind: suggestion.kind,
      content: suggestion.content,
      suggestionId: suggestion.id,
    })
    expect(repos.suggestions.get(project.id, suggestion.id)).toEqual(
      expect.objectContaining({
        status: 'pending',
        materializedResourceId: resource.resource.id,
      }),
    )
    const rejected = repos.resources.reject(project.id, resource.resource.id, {
      revisionId: resource.currentRevision.id,
    })
    expect(rejected.revision.status).toBe('rejected')
    expect(repos.suggestions.get(project.id, suggestion.id)).toEqual(
      expect.objectContaining({
        status: 'rejected',
        resolvedRevisionId: rejected.revision.id,
      }),
    )
    expect(repos.snapshots.list(project.id)).toHaveLength(1)
  })

  it('only materializes a pending suggestion as an exactly matching resource', () => {
    const repos = createProjectRepositories(db)
    const project = repos.projects.create(projectInput())
    const suggestion = repos.suggestions.create(project.id, {
      kind: 'term',
      content: termContent('sun', '太阳'),
      scope: {
        direction: 'en_to_zh',
        level: 'project',
        selector: null,
        pinned: true,
      },
    })

    expect(() =>
      repos.resources.create(project.id, {
        kind: suggestion.kind,
        content: termContent('sun', '日轮'),
        suggestionId: suggestion.id,
      }),
    ).toThrowError(expect.objectContaining({ code: 'validation_failed' }))
    expect(() =>
      repos.resources.create(project.id, {
        kind: 'proper_noun',
        content: suggestion.content,
        suggestionId: suggestion.id,
      }),
    ).toThrowError(expect.objectContaining({ code: 'validation_failed' }))
    expect(() =>
      repos.resources.create(project.id, {
        kind: suggestion.kind,
        content: suggestion.content,
        source: { ...suggestion.source, note: 'different provenance' },
        suggestionId: suggestion.id,
      }),
    ).toThrowError(expect.objectContaining({ code: 'validation_failed' }))
    expect(() =>
      repos.resources.create(project.id, {
        kind: suggestion.kind,
        content: suggestion.content,
        scope: { ...suggestion.scope, pinned: false },
        suggestionId: suggestion.id,
      }),
    ).toThrowError(expect.objectContaining({ code: 'validation_failed' }))
    expect(repos.suggestions.get(project.id, suggestion.id)).toEqual(
      expect.objectContaining({
        status: 'pending',
        materializedResourceId: null,
      }),
    )

    const materialized = repos.resources.create(project.id, {
      kind: suggestion.kind,
      content: suggestion.content,
      source: suggestion.source,
      scope: suggestion.scope,
      suggestionId: suggestion.id,
    })
    expect(materialized.currentRevision.content).toEqual(suggestion.content)
    expect(materialized.currentRevision.source).toEqual(suggestion.source)
    expect(materialized.currentRevision.scope).toEqual(suggestion.scope)
  })

  it('rejects configured encrypted API keys from every persisted content field', () => {
    const secret = 'opaqueProviderCredential12345'
    db.prepare(
      `INSERT INTO endpoints (name, base_url, api_key)
       VALUES ('secret endpoint', 'https://example.test', ?)`,
    ).run(encryptSecret(secret))
    const repos = createProjectRepositories(db)

    expect(() =>
      repos.projects.create(
        projectInput({ description: `do not leak ${secret} here` }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'secret_content_rejected' }),
    )

    const project = repos.projects.create(projectInput())
    expect(() =>
      repos.suggestions.create(project.id, {
        kind: 'context_note',
        content: {
          sourceText: null,
          targetText: null,
          instruction: `credential=${secret}`,
          note: '',
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'secret_content_rejected' }),
    )

    expect(() =>
      repos.suggestions.create(project.id, {
        kind: 'context_note',
        content: {
          sourceText: null,
          targetText: null,
          instruction: `Never persist ${encryptSecret('another-secret-value')}`,
          note: '',
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'secret_content_rejected' }),
    )

    expect(
      repos.suggestions.create(project.id, {
        kind: 'context_note',
        content: {
          sourceText: null,
          targetText: null,
          instruction: 'Keep the phrase api-compatible as ordinary prose.',
          note: '',
        },
      }).status,
    ).toBe('pending')

    db.prepare(
      `INSERT INTO endpoints (name, base_url, api_key)
       VALUES ('short secret endpoint', 'https://short.example.test', ?)`,
    ).run(encryptSecret('tiny'))
    expect(() =>
      repos.suggestions.create(project.id, {
        kind: 'context_note',
        content: {
          sourceText: null,
          targetText: null,
          instruction: 'Never persist prefix-tiny-suffix either.',
          note: '',
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'secret_content_rejected' }),
    )
  })

  it('compares a full canonical request before replaying an idempotent write', () => {
    const repos = createProjectRepositories(db)
    const project = repos.projects.create(
      projectInput({ idempotencyKey: 'project-create-0001' }),
    )
    expect(
      repos.projects.create(
        projectInput({ idempotencyKey: 'project-create-0001' }),
      ).id,
    ).toBe(project.id)
    expect(() =>
      repos.projects.create(
        projectInput({
          idempotencyKey: 'project-create-0001',
          description: 'different',
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'idempotency_conflict' }))

    const request = {
      kind: 'term' as const,
      content: termContent(),
      scope: {
        direction: 'en_to_zh' as const,
        level: 'project' as const,
        selector: null,
        pinned: false,
      },
      idempotencyKey: 'resource-create-0001',
    }
    const first = repos.resources.create(project.id, request)
    const replay = repos.resources.create(project.id, request)
    expect(replay).toEqual(first)
    expect(() =>
      repos.resources.create(project.id, {
        ...request,
        scope: { ...request.scope, pinned: true },
      }),
    ).toThrowError(expect.objectContaining({ code: 'idempotency_conflict' }))
  })

  it('freezes approved historical resources and verifies the deterministic token estimate', () => {
    const repos = createProjectRepositories(db)
    const project = repos.projects.create(projectInput())
    const resource = repos.resources.create(project.id, {
      kind: 'term',
      content: termContent(),
    })
    const approved = repos.resources.approve(project.id, resource.resource.id, {
      revisionId: resource.currentRevision.id,
    })
    db.prepare(
      `INSERT INTO sessions (
         id, source_text, source_lang, target_lang, state, config_snapshot, direction
       ) VALUES ('session-project-1', 'The moon', 'English', 'Chinese',
         'draft', '{}', 'en_to_zh')`,
    ).run()

    const frozenResources = repos.snapshots.getResources(
      project.id,
      approved.snapshot.id,
    )
    const tokenEstimate = estimateProjectContextTokens(frozenResources)
    expect(() =>
      repos.sessionProjectContexts.freezeForSession({
        sessionId: 'session-project-1',
        projectId: project.id,
        projectSnapshotId: approved.snapshot.id,
        direction: 'en_to_zh',
        resourceRevisionIds: approved.snapshot.approvedResourceRevisionIds,
        tokenEstimate: tokenEstimate + 1,
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'token_estimate_mismatch' }),
    )
    const context = repos.sessionProjectContexts.freezeForSession({
      sessionId: 'session-project-1',
      projectId: project.id,
      projectSnapshotId: approved.snapshot.id,
      direction: 'en_to_zh',
      resourceRevisionIds: approved.snapshot.approvedResourceRevisionIds,
      tokenEstimate,
    })
    expect(context.resources).toEqual(frozenResources)
    expect(context.sourceLang).toBe('English')
    expect(context.targetLang).toBe('Chinese')

    repos.resources.addRevision(project.id, resource.resource.id, {
      baseRevisionId: approved.revision.id,
      content: termContent('moon', '明月'),
    })
    expect(repos.sessionProjectContexts.getBySession('session-project-1')).toEqual(
      context,
    )
    expect(() =>
      db
        .prepare('DELETE FROM session_project_contexts WHERE session_id = ?')
        .run('session-project-1'),
    ).toThrow(/immutable/)
    db.prepare('DELETE FROM sessions WHERE id = ?').run('session-project-1')
    expect(repos.sessionProjectContexts.getBySession('session-project-1')).toBeUndefined()
  })

  it('requires an exact language pair for custom project contexts', () => {
    const repos = createProjectRepositories(db)
    const project = repos.projects.create(
      projectInput({
        direction: 'custom',
        sourceLang: 'French',
        targetLang: 'German',
      }),
    )
    db.prepare(
      `INSERT INTO sessions (
         id, source_text, source_lang, target_lang, state, config_snapshot, direction
       ) VALUES ('custom-session', 'Hola', 'Spanish', 'Japanese',
         'draft', '{}', 'custom')`,
    ).run()
    expect(() =>
      repos.sessionProjectContexts.freezeForSession({
        sessionId: 'custom-session',
        projectId: project.id,
        projectSnapshotId: project.currentSnapshotId!,
        direction: 'custom',
        resourceRevisionIds: [],
        tokenEstimate: 0,
      }),
    ).toThrowError(expect.objectContaining({ code: 'direction_mismatch' }))
  })

  it('returns a diagnostic error when persisted revision JSON is corrupt', () => {
    const repos = createProjectRepositories(db)
    const project = repos.projects.create(projectInput())
    const resource = repos.resources.create(project.id, {
      kind: 'term',
      content: termContent(),
    })
    db.prepare(
      `INSERT INTO project_resource_revisions (
         id, resource_id, revision_no, kind, content_json, status,
         source_json, scope_json
       ) VALUES (
         '11111111-1111-4111-8111-111111111111', ?, 2, 'term',
         '{not-json', 'suggested',
         '{"type":"user","sessionId":null,"referenceId":null,"note":""}',
         '{"direction":"en_to_zh","level":"project","selector":null,"pinned":false}'
       )`,
    ).run(resource.resource.id)

    expect(() => repos.resources.list(project.id)).toThrowError(
      expect.objectContaining({ code: 'invalid_stored_json' }),
    )
  })
})

describe('migration 8 to the current project schema', () => {
  it('preserves old sessions and user agents while adding project tables', () => {
    const db = new Database(':memory:')
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
    const firstEight = fs
      .readdirSync(migrationsDir)
      .filter((file) => /^000[1-8]_.*\.sql$/.test(file))
      .sort()
    for (const file of firstEight) {
      const version = Number(file.slice(0, 4))
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
      db.transaction(() => {
        db.exec(sql)
        db.prepare('INSERT INTO migrations (version, name) VALUES (?, ?)').run(
          version,
          file,
        )
      })()
    }
    db.prepare(
      `INSERT INTO endpoints (name, base_url, api_key)
       VALUES ('legacy endpoint', 'https://legacy.test', '')`,
    ).run()
    db.prepare(
      `INSERT INTO translator_agents (
         name, endpoint_id, model, prompt_override, sort_order
       ) VALUES ('User Agent', 1, 'legacy-model', 'user prompt', 9)`,
    ).run()
    db.prepare(
      `INSERT INTO sessions (
         id, source_text, source_lang, target_lang, state, config_snapshot,
         direction, task_brief, review_mode
       ) VALUES (
         'legacy-session', 'legacy source', 'English', 'Chinese', 'done', '{}',
         'en_to_zh', 'legacy brief', 'main_editor'
       )`,
    ).run()

    migrate(db)

    expect(getAppliedVersion(db)).toBeGreaterThanOrEqual(9)
    expect(
      db.prepare("SELECT source_text FROM sessions WHERE id='legacy-session'").get(),
    ).toEqual({ source_text: 'legacy source' })
    expect(
      db.prepare("SELECT * FROM translator_agents WHERE name='User Agent'").get(),
    ).toEqual(
      expect.objectContaining({
        model: 'legacy-model',
        prompt_override: 'user prompt',
        sort_order: 9,
      }),
    )
    const tableNames = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name)
    expect(tableNames).toEqual(
      expect.arrayContaining([
        'translation_projects',
        'project_resources',
        'project_resource_revisions',
        'project_snapshots',
        'project_snapshot_entries',
        'project_memory_suggestions',
        'session_project_contexts',
      ]),
    )
    db.close()
  })
})
