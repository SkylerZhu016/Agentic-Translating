import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../src/lib/db/migrate'
import {
  createProjectRepositories,
  estimateProjectContextTokens,
} from '../../src/lib/db/project-repositories'
import { createWorkspaceModelProfilesRepo } from '../../src/lib/db/release-config-repositories'
import {
  restartVNextSession,
  startVNextRun,
  waitForVNextRunsToSettle,
} from '../../src/lib/orchestration/vnext-runner'

function frozenConfigSnapshot() {
  const binding = {
    endpointId: null,
    model: '',
    contextWindow: null,
  }
  return {
    version: 3,
    direction: 'en_to_zh',
    promptBundleSnapshot: {
      direction: 'en_to_zh',
      promptLanguage: 'en',
      mainAgentSystemPrompt: '',
      workerBasePrompt: '',
      reviewPrompt: '',
      filterPrompt: '',
      orchestratePrompt: '',
      assemblePrompt: '',
      editingPrompt: '',
      toolDescriptions: {},
      version: 1,
    },
    agentVariantSnapshots: [],
    endpointSnapshots: [],
    modelBindings: {
      defaultWorker: binding,
      mainAgent: binding,
      editingAgent: binding,
    },
    presetRevisionSnapshot: {
      id: 'preset-revision',
      presetId: 'preset',
      revisionNo: 1,
      contract: {
        agentVariantIds: ['missing-agent-a', 'missing-agent-b'],
      },
      createdAt: '2026-08-11T00:00:00.000Z',
    },
    taskBrief: '',
    constraints: {},
    orchestrationPolicy: {
      teamPolicy: 'fixed',
      reviewMode: 'main_editor',
      maxAgentCalls: 2,
    },
  }
}

function insertSession(
  db: Database.Database,
  id: string,
  state: 'assembled' | 'translated',
) {
  db.prepare(`
    INSERT INTO sessions (
      id, source_text, source_lang, target_lang, state, config_snapshot,
      direction, task_brief, review_mode
    ) VALUES (?, 'Moon Gate', 'English', 'Chinese', ?, ?,
              'en_to_zh', '', 'main_editor')
  `).run(id, state, JSON.stringify(frozenConfigSnapshot()))
}

function freezeProjectContext(db: Database.Database, sessionId: string) {
  const repositories = createProjectRepositories(db)
  const project = repositories.projects.create({
    name: 'Runner archive',
    description: '',
    direction: 'en_to_zh',
    sourceLang: 'English',
    targetLang: 'Chinese',
  })
  const created = repositories.resources.create(project.id, {
    kind: 'proper_noun',
    content: {
      sourceText: 'Moon Gate',
      targetText: 'Yue Men',
      instruction: 'Keep this approved rendering.',
      note: 'Frozen runner regression fixture.',
    },
  })
  const approved = repositories.resources.approve(
    project.id,
    created.resource.id,
    { revisionId: created.currentRevision.id },
  )
  const resources = repositories.snapshots.getResources(
    project.id,
    approved.snapshot.id,
  )
  return repositories.sessionProjectContexts.freezeForSession({
    sessionId,
    projectId: project.id,
    projectSnapshotId: approved.snapshot.id,
    direction: 'en_to_zh',
    resourceRevisionIds: resources.map((resource) => resource.revision.id),
    tokenEstimate: estimateProjectContextTokens(resources),
  })
}

describe('vNext runner frozen project context', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
  })

  afterEach(async () => {
    await waitForVNextRunsToSettle()
    db.close()
  })

  it('restartVNextSession clones the source session frozen context exactly', async () => {
    insertSession(db, 'source-session', 'assembled')
    const sourceContext = freezeProjectContext(db, 'source-session')

    const restarted = restartVNextSession(db, 'source-session')
    await waitForVNextRunsToSettle()

    const restartedContext = createProjectRepositories(db)
      .sessionProjectContexts.getBySession(restarted.sessionId)
    expect(restartedContext).not.toBeNull()
    expect(restartedContext).toEqual({
      ...sourceContext,
      id: expect.any(String),
      sessionId: restarted.sessionId,
      createdAt: expect.any(String),
    })
    expect(restartedContext?.id).not.toBe(sourceContext.id)
    expect(
      db.prepare(`
        SELECT session_id FROM orchestration_runs WHERE id = ?
      `).get(restarted.runId),
    ).toEqual({ session_id: restarted.sessionId })
  })

  it("startVNextRun with configMode='current' leaves frozen context unchanged", async () => {
    insertSession(db, 'current-session', 'translated')
    const before = freezeProjectContext(db, 'current-session')
    const endpointId = Number(
      db.prepare(`
        INSERT INTO endpoints (
          name, base_url, api_key, chat_completions_path, context_window
        ) VALUES ('current', 'https://example.invalid', '',
                  '/v1/chat/completions', 128000)
      `).run().lastInsertRowid,
    )
    const currentBinding = {
      endpointId,
      model: 'current-model',
      contextWindow: 128_000,
    }
    createWorkspaceModelProfilesRepo(db).upsert({
      direction: 'en_to_zh',
      defaultWorker: currentBinding,
      mainAgent: currentBinding,
      reviewAgent: currentBinding,
      filterAgent: currentBinding,
      orchestrateAgent: currentBinding,
      assembleAgent: currentBinding,
      editingAgent: currentBinding,
    })

    const run = startVNextRun(db, 'current-session', 'current')
    await waitForVNextRunsToSettle()

    const after = createProjectRepositories(db)
      .sessionProjectContexts.getBySession('current-session')
    expect(after).toEqual(before)
    expect(
      db.prepare(`
        SELECT payload_json
        FROM run_events
        WHERE run_id = ? AND event_type = 'main.started'
      `).get(run.runId),
    ).toEqual({ payload_json: JSON.stringify({ bindingSource: 'current' }) })
  })
})
