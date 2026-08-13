import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '@/src/lib/db/migrate'
import { seed } from '@/src/lib/db/seed'
import { createRepositories } from '@/src/lib/db/repositories'
import {
  createProjectRepositories,
  estimateProjectContextTokens,
} from '@/src/lib/db/project-repositories'
import { createSessionService } from '@/src/lib/services/session-service'
import type {
  ProjectResourceContent,
  ProjectResourceKind,
  ProjectResourceScope,
} from '@/src/lib/contracts/projects'

describe('session project binding', () => {
  let db: Database.Database
  let projects: ReturnType<typeof createProjectRepositories>
  let service: ReturnType<typeof createSessionService>

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    seed(db)
    projects = createProjectRepositories(db)
    service = createSessionService(db, createRepositories(db))
  })

  afterEach(() => db.close())

  function createProjectWithApprovedTerm() {
    const project = projects.projects.create({
      name: 'Frozen terminology',
      description: '',
      direction: 'en_to_zh',
      sourceLang: 'English',
      targetLang: 'Chinese',
    })
    const resource = projects.resources.create(project.id, {
      kind: 'term',
      content: {
        sourceText: 'moon',
        targetText: '月亮',
        instruction: null,
        note: '',
      },
    })
    const approval = projects.resources.approve(
      project.id,
      resource.resource.id,
      { revisionId: resource.currentRevision.id },
    )
    return { project: projects.projects.get(project.id)!, resource, approval }
  }

  it('freezes the server-selected current snapshot and keeps resources out of config_snapshot', () => {
    const { project, resource, approval } = createProjectWithApprovedTerm()
    const session = service.createSession({
      clientRequestId: '11111111-1111-4111-8111-111111111111',
      sourceText: 'The moon rose.',
      sourceLang: 'English',
      targetLang: 'Chinese',
      direction: 'en_to_zh',
      projectId: project.id,
    })

    const context = projects.sessionProjectContexts.getBySession(session.id)!
    const frozenResources = projects.snapshots.getResources(
      project.id,
      approval.snapshot.id,
    )
    expect(context.projectSnapshotId).toBe(approval.snapshot.id)
    expect(context.resources).toEqual(frozenResources)
    expect(context.tokenEstimate).toBe(
      estimateProjectContextTokens(frozenResources),
    )

    const configSnapshot = JSON.parse(session.config_snapshot) as Record<
      string,
      unknown
    >
    expect(configSnapshot.projectId).toBe(project.id)
    expect(configSnapshot.projectSnapshotId).toBe(approval.snapshot.id)
    expect(configSnapshot).not.toHaveProperty('projectResources')
    expect(configSnapshot).not.toHaveProperty('resources')

    const suggestion = projects.resources.addRevision(
      project.id,
      resource.resource.id,
      {
        baseRevisionId: approval.revision.id,
        content: {
          sourceText: 'moon',
          targetText: '明月',
          instruction: null,
          note: '',
        },
      },
    )
    projects.resources.approve(project.id, resource.resource.id, {
      revisionId: suggestion.id,
    })
    expect(projects.sessionProjectContexts.getBySession(session.id)).toEqual(
      context,
    )
  })

  it('freezes an empty genesis snapshot instead of omitting the context', () => {
    const project = projects.projects.create({
      name: 'Empty project',
      description: '',
      direction: 'en_to_zh',
      sourceLang: 'English',
      targetLang: 'Chinese',
    })
    const session = service.createSession({
      sourceText: 'Source',
      sourceLang: 'English',
      targetLang: 'Chinese',
      direction: 'en_to_zh',
      projectId: project.id,
    })

    expect(projects.sessionProjectContexts.getBySession(session.id)).toEqual(
      expect.objectContaining({
        projectId: project.id,
        projectSnapshotId: project.currentSnapshotId,
        resourceRevisionIds: [],
        resources: [],
        tokenEstimate: 0,
      }),
    )
  })

  it('freezes only deterministically relevant resources from the current snapshot', () => {
    const project = projects.projects.create({
      name: 'Relevance project',
      description: '',
      direction: 'en_to_zh',
      sourceLang: 'English',
      targetLang: 'Chinese',
    })
    const approvedIds = new Map<string, string>()
    const approve = (
      label: string,
      kind: ProjectResourceKind,
      content: ProjectResourceContent,
      scope: ProjectResourceScope = {
        direction: 'en_to_zh',
        level: 'project',
        selector: null,
        pinned: false,
      },
    ) => {
      const created = projects.resources.create(project.id, {
        kind,
        content,
        scope,
      })
      const result = projects.resources.approve(project.id, created.resource.id, {
        revisionId: created.currentRevision.id,
      })
      approvedIds.set(label, result.revision.id)
    }
    approve('pinned', 'term', {
      sourceText: 'never mentioned',
      targetText: '从未提及',
      instruction: null,
      note: '',
    }, {
      direction: 'en_to_zh',
      level: 'project',
      selector: null,
      pinned: true,
    })
    approve('style', 'style_rule', {
      sourceText: null,
      targetText: null,
      instruction: 'Use restrained prose.',
      note: '',
    })
    approve('context', 'context_note', {
      sourceText: null,
      targetText: null,
      instruction: 'This story is set at night.',
      note: '',
    })
    approve('term-hit', 'term', {
      sourceText: 'moon',
      targetText: '月亮',
      instruction: null,
      note: '',
    })
    approve('turkish-i-hit', 'proper_noun', {
      sourceText: 'ISTANBUL',
      targetText: '伊斯坦布尔',
      instruction: null,
      note: '',
    })
    approve('proper-brief-hit', 'proper_noun', {
      sourceText: 'Selene',
      targetText: '塞勒涅',
      instruction: null,
      note: '',
    })
    approve('decision-miss', 'approved_decision', {
      sourceText: 'sun',
      targetText: '太阳',
      instruction: 'Translate sun as 太阳.',
      note: '',
    })
    approve('partial-miss', 'term', {
      sourceText: 'rise',
      targetText: '升起',
      instruction: null,
      note: '',
    })
    approve('generic-note-miss', 'term', {
      sourceText: 'comet',
      targetText: '彗星',
      instruction: null,
      note: 'moon',
    })
    approve('character-hit', 'character_voice', {
      sourceText: 'Luna',
      targetText: null,
      instruction: 'Use clipped sentences.',
      note: '',
    }, {
      direction: 'en_to_zh',
      level: 'character',
      selector: 'Luna',
      pinned: false,
    })
    approve('document-miss', 'context_note', {
      sourceText: null,
      targetText: null,
      instruction: 'Only for chapter two.',
      note: '',
    }, {
      direction: 'en_to_zh',
      level: 'document',
      selector: 'chapter-2',
      pinned: false,
    })
    approve('scoped-pinned-miss', 'term', {
      sourceText: 'always',
      targetText: '总是',
      instruction: null,
      note: '',
    }, {
      direction: 'en_to_zh',
      level: 'document',
      selector: 'appendix',
      pinned: true,
    })

    const session = service.createSession({
      sourceText: 'Luna watched the moon rising in istanbul.',
      taskBrief: 'Keep the name Selene unchanged in commentary.',
      sourceLang: 'English',
      targetLang: 'Chinese',
      direction: 'en_to_zh',
      projectId: project.id,
    })
    const context = projects.sessionProjectContexts.getBySession(session.id)!
    expect(context.resourceRevisionIds).toEqual(
      [
        approvedIds.get('pinned'),
        approvedIds.get('style'),
        approvedIds.get('context'),
        approvedIds.get('term-hit'),
        approvedIds.get('turkish-i-hit'),
        approvedIds.get('proper-brief-hit'),
        approvedIds.get('character-hit'),
      ].sort(),
    )
    expect(context.resourceRevisionIds).not.toContain(
      approvedIds.get('decision-miss'),
    )
    expect(context.resourceRevisionIds).not.toContain(
      approvedIds.get('partial-miss'),
    )
    expect(context.resourceRevisionIds).not.toContain(
      approvedIds.get('generic-note-miss'),
    )
    expect(context.resourceRevisionIds).not.toContain(
      approvedIds.get('document-miss'),
    )
    expect(context.resourceRevisionIds).not.toContain(
      approvedIds.get('scoped-pinned-miss'),
    )
    expect(context.tokenEstimate).toBe(
      estimateProjectContextTokens(context.resources),
    )
  })

  it('rolls the session and child rows back when freezing fails', () => {
    const project = projects.projects.create({
      name: 'Rollback project',
      description: '',
      direction: 'en_to_zh',
      sourceLang: 'English',
      targetLang: 'Chinese',
    })
    db.exec(`
      CREATE TRIGGER fail_session_project_context_insert
      BEFORE INSERT ON session_project_contexts
      BEGIN
        SELECT RAISE(ABORT, 'forced freeze failure');
      END;
    `)

    expect(() =>
      service.createSession({
        sourceText: 'Source',
        sourceLang: 'English',
        targetLang: 'Chinese',
        direction: 'en_to_zh',
        projectId: project.id,
      }),
    ).toThrow(/forced freeze failure/)
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM sessions').get(),
    ).toEqual({ count: 0 })
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM translation_results').get(),
    ).toEqual({ count: 0 })
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM session_project_contexts').get(),
    ).toEqual({ count: 0 })
  })

  it('rejects incompatible languages atomically', () => {
    const project = projects.projects.create({
      name: 'Direction project',
      description: '',
      direction: 'en_to_zh',
      sourceLang: 'English',
      targetLang: 'Chinese',
    })

    expect(() =>
      service.createSession({
        sourceText: 'Source',
        sourceLang: 'Chinese',
        targetLang: 'English',
        direction: 'en_to_zh',
        projectId: project.id,
      }),
    ).toThrowError(expect.objectContaining({ code: 'direction_mismatch' }))
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM sessions').get(),
    ).toEqual({ count: 0 })
  })

  it('replays a clientRequestId without creating or freezing twice', () => {
    const project = projects.projects.create({
      name: 'Idempotent project',
      description: '',
      direction: 'en_to_zh',
      sourceLang: 'English',
      targetLang: 'Chinese',
    })
    const input = {
      clientRequestId: '22222222-2222-4222-8222-222222222222',
      sourceText: 'Source',
      sourceLang: 'English',
      targetLang: 'Chinese',
      direction: 'en_to_zh' as const,
      projectId: project.id,
    }

    const first = service.createSession(input)
    const replay = service.createSession(input)
    expect(replay.id).toBe(first.id)
    expect(projects.sessionProjectContexts.listByProject(project.id)).toHaveLength(
      1,
    )
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM sessions').get(),
    ).toEqual({ count: 1 })
  })
})
