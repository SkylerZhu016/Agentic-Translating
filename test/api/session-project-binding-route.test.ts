import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { migrate } from '@/src/lib/db/migrate'
import { seed } from '@/src/lib/db/seed'
import { createRepositories } from '@/src/lib/db/repositories'
import { createVNextRepositories } from '@/src/lib/db/vnext-repositories'
import { createProjectRepositories } from '@/src/lib/db/project-repositories'
import { createWorkspaceModelProfilesRepo } from '@/src/lib/db/release-config-repositories'
import { createSessionService } from '@/src/lib/services/session-service'
import { createHandlers as createSessionHandlers } from '@/app/api/sessions/handlers'
import { createHandlers as createDetailHandlers } from '@/app/api/sessions/[id]/handlers'

describe('session project binding API', () => {
  let db: Database.Database
  let projects: ReturnType<typeof createProjectRepositories>

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    seed(db)
    const repositories = createRepositories(db)
    repositories.endpoints.insert({
      name: 'fixture-endpoint',
      base_url: 'https://fixture.invalid',
      api_key: 'fixture-secret',
      context_window: 128_000,
    })
    const endpoint = repositories.endpoints.list()[0]
    repositories.coordinatorConfig.upsert({
      endpoint_id: endpoint.id,
      model: 'fixture-model',
      chat_endpoint_id: endpoint.id,
      chat_model: 'fixture-model',
    })
    repositories.translatorAgents.insert({
      name: 'fixture-translator',
      endpoint_id: endpoint.id,
      model: 'fixture-model',
      prompt_override: null,
      sort_order: 0,
    })
    const binding = {
      endpointId: endpoint.id,
      model: 'fixture-model',
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
    }
    createWorkspaceModelProfilesRepo(db).upsert({
      direction: 'en_to_zh',
      defaultWorker: binding,
      mainAgent: binding,
      reviewAgent: binding,
      filterAgent: binding,
      orchestrateAgent: binding,
      assembleAgent: binding,
      editingAgent: binding,
    })
    projects = createProjectRepositories(db)
  })

  afterEach(() => db.close())

  function createProjectWithTwoSnapshots() {
    const genesisProject = projects.projects.create({
      name: 'API project',
      description: '',
      direction: 'en_to_zh',
      sourceLang: 'English',
      targetLang: 'Chinese',
    })
    const genesisSnapshotId = genesisProject.currentSnapshotId!
    const resource = projects.resources.create(genesisProject.id, {
      kind: 'term',
      content: {
        sourceText: 'moon',
        targetText: '月亮',
        instruction: null,
        note: '',
      },
    })
    projects.resources.approve(genesisProject.id, resource.resource.id, {
      revisionId: resource.currentRevision.id,
    })
    return {
      project: projects.projects.get(genesisProject.id)!,
      genesisSnapshotId,
    }
  }

  it('replays after response loss without refreezing or clearing a newer draft', async () => {
    const { project, genesisSnapshotId } = createProjectWithTwoSnapshots()
    const vnext = createVNextRepositories(db)
    const drafts = vnext.workspaceDrafts
    const allowedAgentVariantIds = vnext.agents
      .listVariants('en_to_zh', false)
      .map((variant) => variant.id)
    drafts.upsert({
      direction: 'en_to_zh',
      sourceText: 'The moon rose.',
      taskBrief: '',
      selectedProjectId: project.id,
      selectedPresetRevisionId: null,
      allowedAgentVariantIds,
      reviewMode: 'main_editor',
      promptBundleRevisionId: null,
      constraints: {},
    })
    const clientRequestId = '55555555-5555-4555-8555-555555555555'
    const requestBody = {
      clientRequestId,
      sourceText: 'The moon rose.',
      sourceLang: 'English',
      targetLang: 'Chinese',
      direction: 'en_to_zh',
      projectId: project.id,
      projectSnapshotId: genesisSnapshotId,
      allowedAgentVariantIds,
    }
    const POST = createSessionHandlers(db).POST

    const firstResponse = await POST(
      new NextRequest('http://localhost/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      }),
    )
    expect(firstResponse.status).toBe(200)
    const first = await firstResponse.json()
    const context = projects.sessionProjectContexts.getBySession(first.id)!
    expect(context.projectSnapshotId).toBe(project.currentSnapshotId)
    expect(context.projectSnapshotId).not.toBe(genesisSnapshotId)
    expect(drafts.get('en_to_zh')).toBeNull()

    drafts.upsert({
      direction: 'en_to_zh',
      sourceText: 'newer draft from another tab',
      taskBrief: 'do not clear this',
      selectedProjectId: project.id,
      selectedPresetRevisionId: null,
      allowedAgentVariantIds,
      reviewMode: 'main_editor',
      promptBundleRevisionId: null,
      constraints: {},
    })

    const replayResponse = await POST(
      new NextRequest('http://localhost/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      }),
    )
    expect(replayResponse.status).toBe(200)
    expect((await replayResponse.json()).id).toBe(first.id)
    expect(projects.sessionProjectContexts.listByProject(project.id)).toHaveLength(
      1,
    )
    expect(drafts.get('en_to_zh')).toEqual(
      expect.objectContaining({
        sourceText: 'newer draft from another tab',
        taskBrief: 'do not clear this',
        selectedProjectId: project.id,
      }),
    )
  })

  it('returns 409 for a reused key with another project and never clears that draft', async () => {
    const firstProject = createProjectWithTwoSnapshots().project
    const secondProject = projects.projects.create({
      name: 'Another API project',
      description: '',
      direction: 'en_to_zh',
      sourceLang: 'English',
      targetLang: 'Chinese',
    })
    const vnext = createVNextRepositories(db)
    const allowedAgentVariantIds = vnext.agents
      .listVariants('en_to_zh', false)
      .map((variant) => variant.id)
    const clientRequestId = '77777777-7777-4777-8777-777777777777'
    const POST = createSessionHandlers(db).POST
    const request = (projectId: string, sourceText: string) =>
      new NextRequest('http://localhost/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientRequestId,
          sourceText,
          sourceLang: 'English',
          targetLang: 'Chinese',
          direction: 'en_to_zh',
          projectId,
          allowedAgentVariantIds,
        }),
      })

    expect((await POST(request(firstProject.id, 'The moon rose.'))).status).toBe(
      200,
    )
    vnext.workspaceDrafts.upsert({
      direction: 'en_to_zh',
      sourceText: 'Another request',
      taskBrief: '',
      selectedProjectId: secondProject.id,
      selectedPresetRevisionId: null,
      allowedAgentVariantIds,
      reviewMode: 'main_editor',
      promptBundleRevisionId: null,
      constraints: {},
    })

    const conflict = await POST(
      request(secondProject.id, 'Another request'),
    )
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual(
      expect.objectContaining({ error: 'idempotency_conflict' }),
    )
    expect(vnext.workspaceDrafts.get('en_to_zh')).toEqual(
      expect.objectContaining({
        sourceText: 'Another request',
        selectedProjectId: secondProject.id,
      }),
    )
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM sessions').get(),
    ).toEqual({ count: 1 })
    expect(
      projects.sessionProjectContexts.listByProject(firstProject.id),
    ).toHaveLength(1)
    expect(
      projects.sessionProjectContexts.listByProject(secondProject.id),
    ).toHaveLength(0)
  })

  it('keeps the draft and rolls back the session when project binding fails', async () => {
    const project = projects.projects.create({
      name: 'Wrong direction',
      description: '',
      direction: 'zh_to_en',
      sourceLang: 'Chinese',
      targetLang: 'English',
    })
    const drafts = createVNextRepositories(db).workspaceDrafts
    drafts.upsert({
      direction: 'en_to_zh',
      sourceText: 'unsent source',
      taskBrief: '',
      selectedProjectId: project.id,
      selectedPresetRevisionId: null,
      allowedAgentVariantIds: [],
      reviewMode: 'main_editor',
      promptBundleRevisionId: null,
      constraints: {},
    })
    const response = await createSessionHandlers(db).POST(
      new NextRequest('http://localhost/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceText: 'Source',
          sourceLang: 'English',
          targetLang: 'Chinese',
          direction: 'en_to_zh',
          projectId: project.id,
        }),
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual(
      expect.objectContaining({ error: 'direction_mismatch' }),
    )
    expect(drafts.get('en_to_zh')).toEqual(
      expect.objectContaining({
        sourceText: 'unsent source',
        selectedProjectId: project.id,
      }),
    )
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM sessions').get(),
    ).toEqual({ count: 0 })
  })

  it('reports corrupt server-owned project snapshots as 500 without creating a session', async () => {
    const { project } = createProjectWithTwoSnapshots()
    db.exec('DROP TRIGGER trg_project_snapshots_no_update')
    db.prepare(
      'UPDATE project_snapshots SET content_hash=? WHERE id=?',
    ).run('0'.repeat(64), project.currentSnapshotId)

    const response = await createSessionHandlers(db).POST(
      new NextRequest('http://localhost/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceText: 'The moon rose.',
          sourceLang: 'English',
          targetLang: 'Chinese',
          direction: 'en_to_zh',
          projectId: project.id,
        }),
      }),
    )

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'snapshot_integrity_error' })
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM sessions').get(),
    ).toEqual({ count: 0 })
  })

  it('returns a full safe frozen projectContext and null for legacy sessions', async () => {
    const { project } = createProjectWithTwoSnapshots()
    const service = createSessionService(db, createRepositories(db))
    const bound = service.createSession({
      sourceText: 'The moon rose.',
      sourceLang: 'English',
      targetLang: 'Chinese',
      direction: 'en_to_zh',
      projectId: project.id,
    })
    const legacy = service.createSession({
      sourceText: 'No project',
      sourceLang: 'English',
      targetLang: 'Chinese',
      direction: 'en_to_zh',
    })
    const GET = createDetailHandlers(db).GET

    const boundResponse = await GET(
      new NextRequest(`http://localhost/api/sessions/${bound.id}`),
      { params: Promise.resolve({ id: bound.id }) },
    )
    const boundBody = await boundResponse.json()
    expect(boundBody.projectContext).toEqual(
      projects.sessionProjectContexts.getBySession(bound.id),
    )
    expect(JSON.stringify(boundBody.projectContext)).not.toMatch(
      /api[_-]?key|authorization|endpoint/i,
    )
    expect(JSON.parse(boundBody.session.config_snapshot)).toEqual(
      expect.objectContaining({
        projectId: project.id,
        projectSnapshotId: project.currentSnapshotId,
      }),
    )
    expect(JSON.parse(boundBody.session.config_snapshot)).not.toHaveProperty(
      'resources',
    )

    const legacyResponse = await GET(
      new NextRequest(`http://localhost/api/sessions/${legacy.id}`),
      { params: Promise.resolve({ id: legacy.id }) },
    )
    expect((await legacyResponse.json()).projectContext).toBeNull()
  })
})
