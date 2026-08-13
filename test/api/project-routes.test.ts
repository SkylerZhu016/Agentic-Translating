import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../src/lib/db/migrate'
import {
  GET as listProjects,
  POST as createProject,
} from '../../app/api/projects/route'
import {
  GET as getProject,
  PATCH as updateProject,
} from '../../app/api/projects/[id]/route'
import { POST as archiveProject } from '../../app/api/projects/[id]/archive/route'
import {
  GET as listResources,
  POST as createResource,
} from '../../app/api/projects/[id]/resources/route'
import { POST as createRevision } from '../../app/api/projects/[id]/resources/[resourceId]/revisions/route'
import { POST as approveResource } from '../../app/api/projects/[id]/resources/[resourceId]/approve/route'
import { POST as rejectResource } from '../../app/api/projects/[id]/resources/[resourceId]/reject/route'
import { GET as listSnapshots } from '../../app/api/projects/[id]/snapshots/route'
import {
  GET as listSuggestions,
  POST as createSuggestion,
} from '../../app/api/projects/[id]/suggestions/route'

function jsonRequest(path: string, method: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function getRequest(path: string): Request {
  return new Request(`http://localhost${path}`)
}

function projectContext(id: string) {
  return { params: Promise.resolve({ id }) }
}

function resourceContext(id: string, resourceId: string) {
  return { params: Promise.resolve({ id, resourceId }) }
}

function termContent(sourceText = 'Hello', targetText = '你好') {
  return {
    sourceText,
    targetText,
    instruction: null,
    note: '',
  }
}

describe('project API routes', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    globalThis.__db = db
  })

  afterEach(() => {
    delete globalThis.__db
    db.close()
  })

  async function createDefaultProject(
    overrides: Record<string, unknown> = {},
  ) {
    const response = await createProject(
      jsonRequest('/api/projects', 'POST', {
        name: 'Novel translation',
        description: 'Project memory for a novel.',
        direction: 'en_to_zh',
        sourceLang: 'en',
        targetLang: 'zh',
        ...overrides,
      }),
    )
    expect(response.status).toBe(201)
    return (await response.json()).project
  }

  async function createDefaultResource(projectId: string) {
    const response = await createResource(
      jsonRequest(`/api/projects/${projectId}/resources`, 'POST', {
        kind: 'term',
        content: termContent(),
      }),
      projectContext(projectId),
    )
    expect(response.status).toBe(201)
    return response.json()
  }

  it('supports project create, list, detail, update, and archive contracts', async () => {
    const created = await createDefaultProject()
    expect(created).toMatchObject({
      name: 'Novel translation',
      description: 'Project memory for a novel.',
      direction: 'en_to_zh',
      sourceLang: 'en',
      targetLang: 'zh',
      status: 'active',
      currentSnapshotRevisionNo: 1,
    })

    const listed = await listProjects(
      getRequest('/api/projects?status=active&direction=en_to_zh'),
    )
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual({ projects: [created] })

    const detail = await getProject(
      getRequest(`/api/projects/${created.id}`),
      projectContext(created.id),
    )
    expect(detail.status).toBe(200)
    expect(await detail.json()).toEqual({
      project: created,
      resourceCount: 0,
      tokenEstimate: 0,
      suggestionCount: 0,
    })

    const updatedResponse = await updateProject(
      jsonRequest(`/api/projects/${created.id}`, 'PATCH', {
        description: 'Updated description.',
        expectedUpdatedAt: created.updatedAt,
      }),
      projectContext(created.id),
    )
    expect(updatedResponse.status).toBe(200)
    const updated = (await updatedResponse.json()).project
    expect(updated.description).toBe('Updated description.')
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(
      Date.parse(created.updatedAt),
    )

    const archivedResponse = await archiveProject(
      jsonRequest(`/api/projects/${created.id}/archive`, 'POST', {
        expectedUpdatedAt: updated.updatedAt,
      }),
      projectContext(created.id),
    )
    expect(archivedResponse.status).toBe(200)
    const archived = (await archivedResponse.json()).project
    expect(archived.status).toBe('archived')

    const archivedList = await listProjects(
      getRequest('/api/projects?status=archived'),
    )
    expect(await archivedList.json()).toEqual({ projects: [archived] })
  })

  it('rejects malformed, extra, and secret-bearing project input', async () => {
    const extraFieldResponse = await createProject(
      jsonRequest('/api/projects', 'POST', {
        name: 'Unsafe input',
        direction: 'en_to_zh',
        sourceLang: 'en',
        targetLang: 'zh',
        apiKey: 'must-not-cross-the-route',
      }),
    )
    expect(extraFieldResponse.status).toBe(400)
    const extraFieldBody = await extraFieldResponse.json()
    expect(extraFieldBody.error).toBe('validation_failed')
    expect(extraFieldBody.details).toEqual(
      expect.objectContaining({ formErrors: expect.any(Array) }),
    )
    expect(JSON.stringify(extraFieldBody)).not.toContain(
      'must-not-cross-the-route',
    )

    const secretResponse = await createProject(
      jsonRequest('/api/projects', 'POST', {
        name: 'Secret-bearing input',
        description: 'Do not persist sk-projectsecret12345 here.',
        direction: 'en_to_zh',
        sourceLang: 'en',
        targetLang: 'zh',
      }),
    )
    expect(secretResponse.status).toBe(400)
    expect(await secretResponse.json()).toEqual({
      error: 'secret_content_rejected',
    })
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM translation_projects').get(),
    ).toEqual({ count: 0 })
  })

  it('rejects incompatible project languages and resource scope directions', async () => {
    const incompatibleProject = await createProject(
      jsonRequest('/api/projects', 'POST', {
        name: 'Wrong direction',
        direction: 'en_to_zh',
        sourceLang: 'zh',
        targetLang: 'en',
      }),
    )
    expect(incompatibleProject.status).toBe(400)
    const projectError = await incompatibleProject.json()
    expect(projectError.error).toBe('validation_failed')
    expect(projectError.details.fieldErrors.direction).toEqual(
      expect.arrayContaining([
        'Project languages are incompatible with its direction.',
      ]),
    )

    const project = await createDefaultProject()
    const incompatibleResource = await createResource(
      jsonRequest(`/api/projects/${project.id}/resources`, 'POST', {
        kind: 'term',
        content: termContent(),
        scope: {
          direction: 'zh_to_en',
          level: 'project',
          selector: null,
          pinned: false,
        },
      }),
      projectContext(project.id),
    )
    expect(incompatibleResource.status).toBe(400)
    expect(await incompatibleResource.json()).toEqual({
      error: 'scope_direction_mismatch',
    })
  })

  it('materializes a suggestion, approves it, and exposes the new snapshot', async () => {
    const project = await createDefaultProject()
    const content = termContent('Moon Gate', '月门')

    const suggestionResponse = await createSuggestion(
      jsonRequest(`/api/projects/${project.id}/suggestions`, 'POST', {
        kind: 'term',
        content,
      }),
      projectContext(project.id),
    )
    expect(suggestionResponse.status).toBe(201)
    const suggestion = (await suggestionResponse.json()).suggestion
    expect(suggestion).toMatchObject({ status: 'pending', content })

    const materializedResponse = await createResource(
      jsonRequest(`/api/projects/${project.id}/resources`, 'POST', {
        kind: suggestion.kind,
        content,
        suggestionId: suggestion.id,
      }),
      projectContext(project.id),
    )
    expect(materializedResponse.status).toBe(201)
    const materialized = await materializedResponse.json()
    expect(Object.keys(materialized).sort()).toEqual(['resource', 'revision'])
    expect(materialized.revision).toMatchObject({
      revisionNo: 1,
      status: 'suggested',
      content,
    })

    const approvedResponse = await approveResource(
      jsonRequest(
        `/api/projects/${project.id}/resources/${materialized.resource.id}/approve`,
        'POST',
        { revisionId: materialized.revision.id },
      ),
      resourceContext(project.id, materialized.resource.id),
    )
    expect(approvedResponse.status).toBe(201)
    const approved = await approvedResponse.json()
    expect(Object.keys(approved).sort()).toEqual([
      'resource',
      'revision',
      'snapshot',
    ])
    expect(approved.revision).toMatchObject({
      revisionNo: 2,
      status: 'approved',
    })
    expect(approved.snapshot).toMatchObject({
      projectId: project.id,
      revisionNo: 2,
      approvedResourceRevisionIds: [approved.revision.id],
    })

    const snapshotsResponse = await listSnapshots(
      getRequest(`/api/projects/${project.id}/snapshots`),
      projectContext(project.id),
    )
    expect(snapshotsResponse.status).toBe(200)
    const snapshots = (await snapshotsResponse.json()).snapshots
    expect(snapshots).toHaveLength(2)
    expect(snapshots[0]).toEqual(approved.snapshot)
    expect(snapshots[1].approvedResourceRevisionIds).toEqual([])

    const approvedSuggestions = await listSuggestions(
      getRequest(`/api/projects/${project.id}/suggestions?status=approved`),
      projectContext(project.id),
    )
    const suggestions = (await approvedSuggestions.json()).suggestions
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]).toMatchObject({
      id: suggestion.id,
      status: 'approved',
      materializedResourceId: materialized.resource.id,
      resolvedRevisionId: approved.revision.id,
    })

    const approvedResources = await listResources(
      getRequest(`/api/projects/${project.id}/resources?status=approved`),
      projectContext(project.id),
    )
    expect((await approvedResources.json()).resources).toEqual([
      {
        resource: materialized.resource,
        currentRevision: approved.revision,
      },
    ])

    const detail = await getProject(
      getRequest(`/api/projects/${project.id}`),
      projectContext(project.id),
    )
    expect(await detail.json()).toMatchObject({
      resourceCount: 1,
      suggestionCount: 0,
    })
  })

  it('summarizes the exact current snapshot when a newer resource revision is pending', async () => {
    const project = await createDefaultProject()
    const created = await createDefaultResource(project.id)
    const approvedResponse = await approveResource(
      jsonRequest(
        `/api/projects/${project.id}/resources/${created.resource.id}/approve`,
        'POST',
        { revisionId: created.revision.id },
      ),
      resourceContext(project.id, created.resource.id),
    )
    expect(approvedResponse.status).toBe(201)
    const approved = await approvedResponse.json()

    const pendingResponse = await createRevision(
      jsonRequest(
        `/api/projects/${project.id}/resources/${created.resource.id}/revisions`,
        'POST',
        {
          baseRevisionId: approved.revision.id,
          content: termContent('Hello', 'Pending replacement'),
        },
      ),
      resourceContext(project.id, created.resource.id),
    )
    expect(pendingResponse.status).toBe(201)
    expect((await pendingResponse.json()).revision.status).toBe('suggested')

    const latestApproved = await listResources(
      getRequest(`/api/projects/${project.id}/resources?status=approved`),
      projectContext(project.id),
    )
    expect((await latestApproved.json()).resources).toEqual([])

    const detailResponse = await getProject(
      getRequest(`/api/projects/${project.id}`),
      projectContext(project.id),
    )
    const detail = await detailResponse.json()
    expect(detail.project.currentSnapshotSummary).toEqual({
      snapshotId: approved.snapshot.id,
      revisionNo: approved.snapshot.revisionNo,
      resourceCount: 1,
      tokenEstimate: expect.any(Number),
    })
    expect(detail.project.currentSnapshotSummary.tokenEstimate).toBeGreaterThan(0)
    expect({
      resourceCount: detail.resourceCount,
      tokenEstimate: detail.tokenEstimate,
    }).toEqual({
      resourceCount: detail.project.currentSnapshotSummary.resourceCount,
      tokenEstimate: detail.project.currentSnapshotSummary.tokenEstimate,
    })

    const listResponse = await listProjects(
      getRequest('/api/projects?status=active&direction=en_to_zh'),
    )
    const listed = (await listResponse.json()).projects
    expect(listed[0].currentSnapshotSummary).toEqual(
      detail.project.currentSnapshotSummary,
    )
  })

  it('reject appends a decision revision without rewriting history', async () => {
    const project = await createDefaultProject()
    const created = await createDefaultResource(project.id)

    const rejectedResponse = await rejectResource(
      jsonRequest(
        `/api/projects/${project.id}/resources/${created.resource.id}/reject`,
        'POST',
        { revisionId: created.revision.id },
      ),
      resourceContext(project.id, created.resource.id),
    )
    expect(rejectedResponse.status).toBe(201)
    const rejected = await rejectedResponse.json()
    expect(rejected.resource).toEqual(created.resource)
    expect(rejected.revision).toMatchObject({
      resourceId: created.resource.id,
      revisionNo: 2,
      status: 'rejected',
    })
    expect(rejected.revision.id).not.toBe(created.revision.id)

    const revisions = db
      .prepare(
        `SELECT id, revision_no, status
         FROM project_resource_revisions
         WHERE resource_id = ? ORDER BY revision_no`,
      )
      .all(created.resource.id)
    expect(revisions).toEqual([
      { id: created.revision.id, revision_no: 1, status: 'suggested' },
      { id: rejected.revision.id, revision_no: 2, status: 'rejected' },
    ])
  })

  it('maps stale revision bases, stale project writes, and idempotency conflicts to 409', async () => {
    const project = await createDefaultProject({
      idempotencyKey: 'project-create-key',
    })
    const idempotencyConflict = await createProject(
      jsonRequest('/api/projects', 'POST', {
        name: 'Different request',
        direction: 'en_to_zh',
        sourceLang: 'en',
        targetLang: 'zh',
        idempotencyKey: 'project-create-key',
      }),
    )
    expect(idempotencyConflict.status).toBe(409)
    expect(await idempotencyConflict.json()).toEqual({
      error: 'idempotency_conflict',
    })

    const created = await createDefaultResource(project.id)
    const firstRevisionResponse = await createRevision(
      jsonRequest(
        `/api/projects/${project.id}/resources/${created.resource.id}/revisions`,
        'POST',
        {
          baseRevisionId: created.revision.id,
          content: termContent('Hello', '您好'),
        },
      ),
      resourceContext(project.id, created.resource.id),
    )
    expect(firstRevisionResponse.status).toBe(201)
    const firstRevision = (await firstRevisionResponse.json()).revision

    const staleRevision = await createRevision(
      jsonRequest(
        `/api/projects/${project.id}/resources/${created.resource.id}/revisions`,
        'POST',
        {
          baseRevisionId: created.revision.id,
          content: termContent('Hello', '哈啰'),
        },
      ),
      resourceContext(project.id, created.resource.id),
    )
    expect(staleRevision.status).toBe(409)
    expect(await staleRevision.json()).toEqual({
      error: 'stale_resource_revision',
    })

    const staleProject = await updateProject(
      jsonRequest(`/api/projects/${project.id}`, 'PATCH', {
        name: 'Stale update',
        expectedUpdatedAt: project.updatedAt,
      }),
      projectContext(project.id),
    )
    expect(staleProject.status).toBe(409)
    expect(await staleProject.json()).toEqual({
      error: 'stale_project_version',
    })

    expect(firstRevision).toMatchObject({ revisionNo: 2, status: 'suggested' })
  })

  it('validates UUID params and maps missing projects and resources to 404', async () => {
    const invalidId = await getProject(
      getRequest('/api/projects/not-a-uuid'),
      projectContext('not-a-uuid'),
    )
    expect(invalidId.status).toBe(400)
    expect((await invalidId.json()).error).toBe('validation_failed')

    const missingId = randomUUID()
    const missingProject = await getProject(
      getRequest(`/api/projects/${missingId}`),
      projectContext(missingId),
    )
    expect(missingProject.status).toBe(404)
    expect(await missingProject.json()).toEqual({ error: 'project_not_found' })

    const project = await createDefaultProject()
    const missingResourceId = randomUUID()
    const missingResource = await createRevision(
      jsonRequest(
        `/api/projects/${project.id}/resources/${missingResourceId}/revisions`,
        'POST',
        {
          baseRevisionId: randomUUID(),
          content: termContent(),
        },
      ),
      resourceContext(project.id, missingResourceId),
    )
    expect(missingResource.status).toBe(404)
    expect(await missingResource.json()).toEqual({
      error: 'resource_not_found',
    })
  })

  it('blocks writes to archived projects and stabilizes stored JSON failures', async () => {
    const project = await createDefaultProject()
    const archivedResponse = await archiveProject(
      jsonRequest(`/api/projects/${project.id}/archive`, 'POST', {
        expectedUpdatedAt: project.updatedAt,
      }),
      projectContext(project.id),
    )
    expect(archivedResponse.status).toBe(200)
    const archived = (await archivedResponse.json()).project

    const archivedPatch = await updateProject(
      jsonRequest(`/api/projects/${project.id}`, 'PATCH', {
        name: 'Archived projects are immutable',
        expectedUpdatedAt: archived.updatedAt,
      }),
      projectContext(project.id),
    )
    expect(archivedPatch.status).toBe(409)
    expect(await archivedPatch.json()).toEqual({ error: 'project_archived' })

    const archivedWrite = await createSuggestion(
      jsonRequest(`/api/projects/${project.id}/suggestions`, 'POST', {
        kind: 'term',
        content: termContent(),
      }),
      projectContext(project.id),
    )
    expect(archivedWrite.status).toBe(409)
    expect(await archivedWrite.json()).toEqual({ error: 'project_archived' })

    db.prepare(
      `INSERT INTO project_snapshots (
         id, project_id, revision_no,
         approved_resource_revision_ids_json, content_hash,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      project.id,
      99,
      'not-json',
      'not-a-valid-hash',
      new Date().toISOString(),
    )

    const corruptSnapshots = await listSnapshots(
      getRequest(`/api/projects/${project.id}/snapshots`),
      projectContext(project.id),
    )
    expect(corruptSnapshots.status).toBe(500)
    expect(await corruptSnapshots.json()).toEqual({
      error: 'invalid_stored_json',
    })
  })
})
