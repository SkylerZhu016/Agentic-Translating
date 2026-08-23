import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { createRepositories, type Repositories } from '../../src/lib/db/repositories'
import type { ConfigSnapshotVNext, ModelBinding } from '../../src/lib/contracts/vnext'

const MIGRATION_SQL_0001 = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/db/migrations/0001_init.sql'),
  'utf-8',
)
const MIGRATION_SQL_0002 = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/db/migrations/0002_presets_and_drop_parsed_output.sql'),
  'utf-8',
)

vi.mock('../../src/lib/llm/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm/client')>()
  return { ...actual, chatCompletion: vi.fn() }
})

import { chatCompletion } from '../../src/lib/llm/client'
import { createHandlers } from '../../app/api/sessions/[id]/stages/[stage]/run/handlers'

function completeV3Snapshot(): ConfigSnapshotVNext {
  const binding: ModelBinding = {
    endpointId: 1,
    model: 'fixture-model',
    maxOutputTokens: 4_096,
  }
  return {
    version: 3,
    direction: 'en_to_zh',
    promptBundleSnapshot: {
      direction: 'en_to_zh',
      promptLanguage: 'zh',
      mainAgentSystemPrompt: '统筹翻译。',
      workerBasePrompt: '翻译原文。',
      reviewPrompt: '审查译文。',
      filterPrompt: '筛选译文。',
      orchestratePrompt: '统筹译文。',
      assemblePrompt: '组装译文。',
      editingPrompt: '编辑译文。',
      toolDescriptions: {},
      version: 1,
    },
    agentVariantSnapshots: [{
      id: 'fixture-worker',
      archetypeId: 'semantic-fidelity',
      direction: 'en_to_zh',
      catalogName: 'Fixture worker',
      catalogDescription: 'Stage route rejection fixture',
      rolePrompt: 'Translate faithfully.',
      promptLanguage: 'zh',
      promptVersion: 1,
      enabled: true,
      endpointOverrideId: null,
      modelOverride: null,
      sortOrder: 1,
    }],
    endpointSnapshots: [{
      id: 1,
      name: 'fixture',
      baseUrl: 'https://fixture.invalid',
      chatCompletionsPath: '/v1/chat/completions',
      hasApiKey: true,
      contextWindow: 32_768,
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
    presetRevisionSnapshot: null,
    taskBrief: '',
    constraints: {},
    orchestrationPolicy: {
      teamPolicy: 'fixed',
      reviewMode: 'main_editor',
      maxAgentCalls: 2,
      candidateAnnotationMode: 'body_only',
    },
  }
}

describe('POST /api/sessions/[id]/stages/[stage]/run', () => {
  let db: Database.Database
  let repos: Repositories
  let POST: ReturnType<typeof createHandlers>['POST']

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(MIGRATION_SQL_0001)
    db.exec(MIGRATION_SQL_0002)
    repos = createRepositories(db)
    POST = createHandlers(db).POST
    vi.mocked(chatCompletion).mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
  })

  function seed(snapshot: unknown, id: string): string {
    repos.sessions.insert({
      id,
      source_text: 'Hello world',
      source_lang: 'en',
      target_lang: 'zh',
      state: 'translated',
      config_snapshot: JSON.stringify(snapshot),
    })
    return id
  }

  it('keeps invalid stage validation ahead of session execution', async () => {
    const id = seed(completeV3Snapshot(), 'invalid-stage')
    const response = await POST(
      new Request(`http://localhost/api/sessions/${id}/stages/bogus/run`, { method: 'POST' }),
      { params: Promise.resolve({ id, stage: 'bogus' }) },
    )

    expect(response.status).toBe(404)
    expect(vi.mocked(chatCompletion)).not.toHaveBeenCalled()
  })

  it('returns 404 for a missing session', async () => {
    const response = await POST(
      new Request('http://localhost/api/sessions/missing/stages/review/run', { method: 'POST' }),
      { params: Promise.resolve({ id: 'missing', stage: 'review' }) },
    )

    expect(response.status).toBe(404)
    expect(vi.mocked(chatCompletion)).not.toHaveBeenCalled()
  })

  it('rejects a complete v3 snapshot because vNext stages are automatic', async () => {
    const id = seed(completeV3Snapshot(), 'v3-automatic')
    const response = await POST(
      new Request(`http://localhost/api/sessions/${id}/stages/review/run`, { method: 'POST' }),
      { params: Promise.resolve({ id, stage: 'review' }) },
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      error: 'vnext_stage_is_automatic',
    }))
    expect(vi.mocked(chatCompletion)).not.toHaveBeenCalled()
  })

  it('returns stable 422 for a complete legacy v2 snapshot', async () => {
    const id = seed({
      version: 2,
      endpoint: {
        id: 1,
        name: 'legacy',
        base_url: 'https://legacy.invalid',
        api_key: 'legacy-secret',
      },
      endpoints: [],
      agents: [{
        id: 1,
        name: 'legacy-agent',
        endpoint_id: 1,
        model: 'legacy-model',
      }],
      coordinator: {
        endpoint_id: 1,
        model: 'legacy-model',
        chat_endpoint_id: 1,
        chat_model: 'legacy-model',
      },
      prompts: {
        review: 'Review {{context}}',
        filter: 'Filter {{context}}',
        orchestrate: 'Orchestrate {{context}}',
        assemble: 'Assemble {{context}}',
      },
    }, 'legacy-v2')
    const response = await POST(
      new Request(`http://localhost/api/sessions/${id}/stages/review/run`, { method: 'POST' }),
      { params: Promise.resolve({ id, stage: 'review' }) },
    )

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      error: 'preflight_snapshot_upgrade_required',
      params: { snapshotVersion: 2 },
    }))
    expect(vi.mocked(chatCompletion)).not.toHaveBeenCalled()
  })

  it('returns stable 422 for a malformed snapshot', async () => {
    const id = seed({ version: 3 }, 'malformed-v3')
    const response = await POST(
      new Request(`http://localhost/api/sessions/${id}/stages/review/run`, { method: 'POST' }),
      { params: Promise.resolve({ id, stage: 'review' }) },
    )

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      error: 'preflight_snapshot_upgrade_required',
      params: { snapshotVersion: 3 },
    }))
    expect(vi.mocked(chatCompletion)).not.toHaveBeenCalled()
  })
})
