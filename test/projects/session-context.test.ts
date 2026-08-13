import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type { SessionProjectContext } from '../../src/lib/contracts/projects'
import { migrate } from '../../src/lib/db/migrate'
import {
  createProjectRepositories,
  estimateProjectContextTokens,
} from '../../src/lib/db/project-repositories'
import {
  cloneSessionProjectContext,
  formatSessionProjectContext,
} from '../../src/lib/projects/session-context'

function context(): SessionProjectContext {
  return {
    id: 'context-id',
    sessionId: 'session-id',
    projectId: 'project-id',
    projectSnapshotId: 'snapshot-id',
    direction: 'en_to_zh',
    sourceLang: 'English',
    targetLang: 'Chinese',
    resourceRevisionIds: ['revision-id'],
    resources: [
      {
        resourceId: 'resource-id',
        revision: {
          id: 'revision-id',
          resourceId: 'resource-id',
          revisionNo: 2,
          kind: 'proper_noun',
          content: {
            sourceText: 'Moon Gate',
            targetText: '月门',
            instruction: null,
            note: '沿用项目既有译名。',
          },
          status: 'approved',
          source: {
            type: 'user',
            sessionId: null,
            referenceId: null,
            note: '',
          },
          scope: {
            direction: 'en_to_zh',
            level: 'project',
            selector: null,
            pinned: true,
          },
          createdAt: '2026-08-09T00:00:00.000Z',
        },
      },
    ],
    tokenEstimate: 42,
    createdAt: '2026-08-09T00:00:00.000Z',
  }
}

describe('formatSessionProjectContext', () => {
  it('renders approved resources as Chinese user context', () => {
    const text = formatSessionProjectContext(context(), 'zh')
    expect(text).toContain('用户已批准的项目翻译档案')
    expect(text).toContain('Moon Gate → 月门')
    expect(text).toContain('项目级，固定优先')
    expect(text).not.toContain('apiKey')
  })

  it('renders the same frozen resource in English', () => {
    const text = formatSessionProjectContext(context(), 'en')
    expect(text).toContain('User-approved project translation archive')
    expect(text).toContain('Approved correspondence: Moon Gate -> 月门')
    expect(text).toContain('project-wide, pinned')
  })

  it('omits an empty snapshot instead of padding every prompt', () => {
    expect(
      formatSessionProjectContext({ ...context(), resources: [] }, 'zh'),
    ).toBe('')
    expect(formatSessionProjectContext(null, 'en')).toBe('')
  })

  it('clones the exact frozen snapshot for a restarted session', () => {
    const db = new Database(':memory:')
    try {
      db.pragma('foreign_keys = ON')
      migrate(db)
      const repositories = createProjectRepositories(db)
      const project = repositories.projects.create({
        name: 'Restart archive',
        description: '',
        direction: 'en_to_zh',
        sourceLang: 'English',
        targetLang: 'Chinese',
      })
      const created = repositories.resources.create(project.id, {
        kind: 'proper_noun',
        content: {
          sourceText: 'Moon Gate',
          targetText: '月门',
          instruction: null,
          note: '',
        },
      })
      const approved = repositories.resources.approve(
        project.id,
        created.resource.id,
        { revisionId: created.currentRevision.id },
      )
      for (const id of ['source-session', 'target-session']) {
        db.prepare(`
          INSERT INTO sessions (
            id, source_text, source_lang, target_lang, direction,
            config_snapshot
          ) VALUES (?, 'Moon Gate', 'English', 'Chinese', 'en_to_zh', '{}')
        `).run(id)
      }
      const resources = repositories.snapshots.getResources(
        project.id,
        approved.snapshot.id,
      )
      const source = repositories.sessionProjectContexts.freezeForSession({
        sessionId: 'source-session',
        projectId: project.id,
        projectSnapshotId: approved.snapshot.id,
        direction: 'en_to_zh',
        resourceRevisionIds: [approved.revision.id],
        tokenEstimate: estimateProjectContextTokens(resources),
      })

      const cloned = cloneSessionProjectContext(
        db,
        'source-session',
        'target-session',
      )

      expect(cloned).toMatchObject({
        sessionId: 'target-session',
        projectId: source.projectId,
        projectSnapshotId: source.projectSnapshotId,
        resourceRevisionIds: source.resourceRevisionIds,
        resources: source.resources,
        tokenEstimate: source.tokenEstimate,
      })
      expect(cloneSessionProjectContext(
        db,
        'missing-source',
        'target-session',
      )).toBeNull()
    } finally {
      db.close()
    }
  })
})
