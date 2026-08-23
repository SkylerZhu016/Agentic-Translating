import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from '../../src/lib/db/migrate'
import {
  startVNextDraftRegeneration,
  waitForVNextRunsToSettle,
} from '../../src/lib/orchestration/vnext-runner'

vi.mock('../../src/lib/llm/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm/client')>()
  return {
    ...actual,
    chatCompletion: vi.fn().mockResolvedValue({ content: 'Fixture draft' }),
  }
})

const sessionId = 'checkpoint-order-session'
const sourceRunId = 'checkpoint-order-source-run'
const sharedCreatedAt = '2026-08-11 00:00:00'

const oldInvocationId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const retryInvocationId = '00000000-0000-4000-8000-000000000001'
const secondCandidateId = '88888888-8888-4888-8888-888888888888'

function candidateSnapshot(id: string, catalogName: string, sortOrder: number) {
  return {
    id,
    archetypeId: id,
    direction: 'en_to_zh',
    catalogName,
    catalogDescription: '',
    rolePrompt: '',
    promptLanguage: 'en',
    promptVersion: 1,
    enabled: true,
    endpointOverrideId: null,
    modelOverride: null,
    sortOrder,
  }
}

function frozenConfigSnapshot() {
  const binding = {
    endpointId: 1,
    model: 'fixture-model',
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
  }
  const candidates = [
    candidateSnapshot('candidate-a', 'Candidate A', 0),
    candidateSnapshot('candidate-b', 'Candidate B', 1),
  ]
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
    agentVariantSnapshots: candidates,
    endpointSnapshots: [{
      id: 1,
      name: 'fixture',
      baseUrl: 'https://fixture.invalid',
      chatCompletionsPath: '/v1/chat/completions',
      apiKey: 'fixture-secret',
      hasApiKey: true,
      contextWindow: 128_000,
    }],
    modelBindings: {
      defaultWorker: binding,
      mainAgent: binding,
      reviewAgent: binding,
      filterAgent: binding,
      orchestrateAgent: binding,
      assembleAgent: binding,
      editingAgent: binding,
    },
    presetRevisionSnapshot: {
      id: 'checkpoint-order-preset-revision',
      presetId: 'checkpoint-order-preset',
      revisionNo: 1,
      contract: {
        agentVariantIds: candidates.map((candidate) => candidate.id),
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

function insertInvocation(
  db: Database.Database,
  input: {
    id: string
    variantId: string
    catalogName: string
    body: string
    replacesInvocationId?: string
    sortOrder: number
  },
) {
  db.prepare(`
    INSERT INTO agent_invocations (
      id, session_id, parent_run_id, agent_variant_id, agent_snapshot,
      endpoint_id, model, status, raw_output, body_output,
      replaces_invocation_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, 'fixture-model', 'complete', ?, ?, ?, ?, ?)
  `).run(
    input.id,
    sessionId,
    sourceRunId,
    input.variantId,
    JSON.stringify(
      candidateSnapshot(input.variantId, input.catalogName, input.sortOrder),
    ),
    input.body,
    input.body,
    input.replacesInvocationId ?? null,
    sharedCreatedAt,
    sharedCreatedAt,
  )
}

describe('vNext invocation checkpoint ordering', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    db.prepare(`
      INSERT INTO endpoints (id, name, base_url, api_key)
      VALUES (1, 'current-fixture', 'https://current.invalid', 'fixture-current-key')
    `).run()

    db.prepare(`
      INSERT INTO sessions (
        id, source_text, source_lang, target_lang, state, config_snapshot,
        direction, task_brief, review_mode
      ) VALUES (?, 'Moon Gate', 'English', 'Chinese', 'translated', ?,
                'en_to_zh', '', 'main_editor')
    `).run(sessionId, JSON.stringify(frozenConfigSnapshot()))
    db.prepare(`
      INSERT INTO orchestration_runs (
        id, session_id, kind, status, phase, completed_at, created_at
      ) VALUES (?, ?, 'translation', 'complete', 'complete', ?, ?)
    `).run(sourceRunId, sessionId, sharedCreatedAt, sharedCreatedAt)
  })

  afterEach(async () => {
    await waitForVNextRunsToSettle()
    db.close()
  })

  it('uses the later inserted successful retry when timestamps tie', async () => {
    // The retry UUID sorts before its predecessor. Ordering by UUID would
    // therefore replay the older result last and select the wrong checkpoint.
    insertInvocation(db, {
      id: oldInvocationId,
      variantId: 'candidate-a',
      catalogName: 'Candidate A',
      body: '旧候选译文',
      sortOrder: 0,
    })
    insertInvocation(db, {
      id: retryInvocationId,
      variantId: 'candidate-a',
      catalogName: 'Candidate A',
      body: '重试后的候选译文',
      replacesInvocationId: oldInvocationId,
      sortOrder: 0,
    })
    insertInvocation(db, {
      id: secondCandidateId,
      variantId: 'candidate-b',
      catalogName: 'Candidate B',
      body: '第二条候选译文',
      sortOrder: 1,
    })

    const { runId } = startVNextDraftRegeneration(db, sessionId)
    await waitForVNextRunsToSettle()

    const event = db.prepare(`
      SELECT payload_json
      FROM run_events
      WHERE run_id = ? AND event_type = 'draft.regeneration.started'
    `).get(runId) as { payload_json: string } | undefined
    expect(event).toBeDefined()

    const payload = JSON.parse(event!.payload_json) as {
      candidateInvocationIds: string[]
    }
    expect(payload.candidateInvocationIds).toContain(retryInvocationId)
    expect(payload.candidateInvocationIds).toContain(secondCandidateId)
    expect(payload.candidateInvocationIds).not.toContain(oldInvocationId)
  })
})
