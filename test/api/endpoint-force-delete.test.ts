import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { migrate } from '../../src/lib/db/migrate'
import { createRepositories } from '../../src/lib/db/repositories'
import { DELETE } from '../../app/api/endpoints/[id]/route'

interface Fixture {
  endpointId: number
  presetId: number
  sessionId: string
  variantId: string
  workflowRevisionId: string
  batchId: string
  invocationId: string
}

function seedReferencedEndpoint(db: Database.Database): Fixture {
  const endpointId = Number(
    createRepositories(db).endpoints.insert({
      name: 'endpoint to remove',
      base_url: 'https://provider.invalid',
      chat_completions_path: '/v1/chat/completions',
      api_key: 'private-key',
    }).lastInsertRowid,
  )
  const sessionId = 'session-with-frozen-endpoint'
  db.prepare(`
    INSERT INTO sessions (id, source_text, config_snapshot)
    VALUES (?, 'source', ?)
  `).run(sessionId, JSON.stringify({
    endpoint: { id: endpointId, apiKey: 'snapshot-private-key' },
    taskBrief: 'private source material',
  }))
  db.prepare(`
    INSERT INTO translator_agents (
      name, endpoint_id, model, prompt_override, sort_order
    ) VALUES ('legacy worker', ?, 'worker-model', 'legacy user prompt', 19)
  `).run(endpointId)
  db.prepare(`
    INSERT INTO coordinator_config (
      id, endpoint_id, model, chat_endpoint_id, chat_model
    ) VALUES (1, ?, 'main-model', ?, 'chat-model')
    ON CONFLICT(id) DO UPDATE SET
      endpoint_id=excluded.endpoint_id,
      model=excluded.model,
      chat_endpoint_id=excluded.chat_endpoint_id,
      chat_model=excluded.chat_model
  `).run(endpointId, endpointId)

  const presetId = Number(db.prepare(`
    INSERT INTO config_presets (name, description)
    VALUES ('legacy preset with endpoint', 'kept after endpoint deletion')
  `).run().lastInsertRowid)
  db.prepare(`
    INSERT INTO config_preset_agents (
      preset_id, name, endpoint_id, model, prompt_override, sort_order
    ) VALUES (?, 'preset worker', ?, 'worker-model', 'preset user prompt', 23)
  `).run(presetId, endpointId)
  db.prepare(`
    INSERT INTO config_preset_coordinator (
      preset_id, endpoint_id, model, chat_endpoint_id, chat_model
    ) VALUES (?, ?, 'main-model', ?, 'chat-model')
  `).run(presetId, endpointId, endpointId)

  const archetypeId = 'custom-force-delete-archetype'
  const variantId = 'custom-force-delete-variant'
  db.prepare(`
    INSERT INTO agent_archetypes (
      id, slug, display_name_zh, category, tags_json, is_builtin
    ) VALUES (?, ?, 'user agent', 'expression', '[]', 0)
  `).run(archetypeId, archetypeId)
  db.prepare(`
    INSERT INTO agent_direction_variants (
      id, archetype_id, direction, catalog_name, catalog_description,
      role_prompt, prompt_language, endpoint_override_id, model_override
    ) VALUES (?, ?, 'en_to_zh', 'user agent', 'description',
              'user-owned prompt', 'zh', ?, 'override-model')
  `).run(variantId, archetypeId, endpointId)

  const binding = JSON.stringify({
    endpointId,
    model: 'bound-model',
    contextWindow: 64_000,
  })
  db.prepare(`
    UPDATE workspace_model_profiles
    SET default_worker_json=?, review_agent_json=?
    WHERE direction='en_to_zh'
  `).run(binding, binding)
  db.prepare(`
    UPDATE onboarding_state
    SET selected_endpoint_id=?
    WHERE id=1
  `).run(endpointId)
  db.prepare(`
    INSERT INTO endpoint_capability_profiles (
      endpoint_id, profile_json, checked_at, expires_at,
      tested_model, diagnostic_id
    ) VALUES (?, '{}', '2026-08-11T00:00:00.000Z',
              '2026-08-12T00:00:00.000Z', 'model', ?)
  `).run(endpointId, '96aa0588-1fcf-4375-b272-83a782360d0f')

  const workflowPresetId = 'workflow-preset-with-endpoint'
  const workflowRevisionId = 'workflow-revision-with-endpoint'
  db.prepare(`
    INSERT INTO workflow_presets (
      id, name, description, direction, current_revision_no
    ) VALUES (?, 'workflow preset', 'history is preserved', 'en_to_zh', 1)
  `).run(workflowPresetId)
  db.prepare(`
    INSERT INTO workflow_preset_revisions (
      id, preset_id, revision_no, contract_json
    ) VALUES (?, ?, 1, ?)
  `).run(workflowRevisionId, workflowPresetId, JSON.stringify({
    defaultWorkerBinding: {
      endpointId,
      model: 'historical-model',
      apiKey: 'workflow-private-key',
    },
    taskBriefTemplate: 'private preset instructions',
  }))

  const batchId = 'batch-with-endpoint'
  db.prepare(`
    INSERT INTO batch_jobs (
      id, name, direction, preset_revision_id, preset_snapshot, status
    ) VALUES (?, 'historical batch', 'en_to_zh', ?, ?, 'completed')
  `).run(batchId, workflowRevisionId, JSON.stringify({
    endpointSnapshots: [{ id: endpointId, baseUrl: 'https://private.invalid' }],
    taskBrief: 'private batch instructions',
  }))

  const runId = 'run-with-endpoint'
  const invocationId = 'invocation-with-endpoint'
  db.prepare(`
    INSERT INTO orchestration_runs (id, session_id, status, phase)
    VALUES (?, ?, 'complete', 'done')
  `).run(runId, sessionId)
  db.prepare(`
    INSERT INTO agent_invocations (
      id, session_id, parent_run_id, agent_variant_id, agent_snapshot,
      endpoint_id, model, status
    ) VALUES (?, ?, ?, 'historical-variant', ?, ?, 'historical-model', 'complete')
  `).run(
    invocationId,
    sessionId,
    runId,
    JSON.stringify({ rolePrompt: 'private historical prompt' }),
    endpointId,
  )
  db.prepare(`
    INSERT INTO llm_call_records (
      id, endpoint_id, operation, requested_model, status, retry_count
    ) VALUES ('historical-call', ?, 'agent.test', 'bound-model', 'complete', 0)
  `).run(endpointId)

  return {
    endpointId,
    presetId,
    sessionId,
    variantId,
    workflowRevisionId,
    batchId,
    invocationId,
  }
}

describe('forced endpoint deletion', () => {
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

  it('deletes an unreferenced endpoint without a force round trip', async () => {
    const endpointId = Number(
      createRepositories(db).endpoints.insert({
        name: 'unreferenced endpoint',
        base_url: 'https://unused.invalid',
        chat_completions_path: '/v1/chat/completions',
        api_key: 'private-key',
      }).lastInsertRowid,
    )

    const response = await DELETE(
      new NextRequest(`http://localhost/api/endpoints/${endpointId}`, {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: String(endpointId) }) },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })
    expect(db.prepare('SELECT id FROM endpoints WHERE id=?').get(endpointId))
      .toBeUndefined()
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('returns a complete numeric-only reference summary before deletion', async () => {
    const fixture = seedReferencedEndpoint(db)

    const response = await DELETE(
      new NextRequest(`http://localhost/api/endpoints/${fixture.endpointId}`, {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: String(fixture.endpointId) }) },
    )

    expect(response.status).toBe(409)
    const payload = await response.json()
    expect(payload).toEqual({
      error: 'endpoint_references_exist',
      references: {
        active: {
          legacyAgents: 1,
          vnextAgentOverrides: 1,
          coordinatorBindings: 2,
          legacyPresetAgents: 1,
          legacyPresetCoordinatorBindings: 2,
          modelProfileBindings: 2,
          onboardingSelection: 1,
          capabilityProfiles: 1,
        },
        historical: {
          sessions: 1,
          workflowPresetRevisions: 1,
          batchJobs: 1,
          agentInvocations: 1,
          llmCalls: 1,
        },
        totalActive: 11,
        totalHistorical: 5,
      },
      usedBySessions: [fixture.sessionId],
    })
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain('private-key')
    expect(serialized).not.toContain('private source material')
    expect(serialized).not.toContain('private preset instructions')
    expect(serialized).not.toContain('private batch instructions')
    expect(serialized).not.toContain('private historical prompt')
    expect(serialized).not.toContain('https://private.invalid')
    expect(db.prepare('SELECT id FROM endpoints WHERE id=?')
      .get(fixture.endpointId)).toBeDefined()
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('atomically unbinds live configuration while foreign keys stay enabled', async () => {
    const fixture = seedReferencedEndpoint(db)

    const response = await DELETE(
      new NextRequest(
        `http://localhost/api/endpoints/${fixture.endpointId}?force=1`,
        { method: 'DELETE' },
      ),
      { params: Promise.resolve({ id: String(fixture.endpointId) }) },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare('SELECT id FROM endpoints WHERE id=?')
      .get(fixture.endpointId)).toBeUndefined()
    expect(db.prepare('SELECT id FROM sessions WHERE id=?')
      .get(fixture.sessionId)).toBeDefined()
    expect(db.prepare(`
      SELECT name, endpoint_id, model, prompt_override, sort_order
      FROM translator_agents WHERE name='legacy worker'
    `).get()).toEqual({
      name: 'legacy worker',
      endpoint_id: null,
      model: 'worker-model',
      prompt_override: 'legacy user prompt',
      sort_order: 19,
    })
    expect(db.prepare(`
      SELECT endpoint_id, model, chat_endpoint_id, chat_model
      FROM coordinator_config WHERE id=1
    `).get()).toEqual({
      endpoint_id: null,
      model: 'main-model',
      chat_endpoint_id: null,
      chat_model: 'chat-model',
    })
    expect(db.prepare('SELECT id FROM config_presets WHERE id=?')
      .get(fixture.presetId)).toBeDefined()
    expect(db.prepare(`
      SELECT name, endpoint_id, model, prompt_override, sort_order
      FROM config_preset_agents WHERE preset_id=?
    `).get(fixture.presetId)).toEqual({
      name: 'preset worker',
      endpoint_id: null,
      model: 'worker-model',
      prompt_override: 'preset user prompt',
      sort_order: 23,
    })
    expect(db.prepare(`
      SELECT endpoint_id, model, chat_endpoint_id, chat_model
      FROM config_preset_coordinator WHERE preset_id=?
    `).get(fixture.presetId)).toEqual({
      endpoint_id: null,
      model: 'main-model',
      chat_endpoint_id: null,
      chat_model: 'chat-model',
    })
    expect(db.prepare(`
      SELECT endpoint_override_id, model_override, role_prompt
      FROM agent_direction_variants WHERE id=?
    `).get(fixture.variantId)).toEqual({
      endpoint_override_id: null,
      model_override: 'override-model',
      role_prompt: 'user-owned prompt',
    })
    expect(db.prepare(`
      SELECT selected_endpoint_id FROM onboarding_state WHERE id=1
    `).get()).toEqual({ selected_endpoint_id: null })
    expect(db.prepare(`
      SELECT COUNT(*) FROM endpoint_capability_profiles WHERE endpoint_id=?
    `).pluck().get(fixture.endpointId)).toBe(0)
    expect(db.prepare(`
      SELECT endpoint_id, status FROM llm_call_records WHERE id='historical-call'
    `).get()).toEqual({ endpoint_id: fixture.endpointId, status: 'complete' })
    expect(db.prepare(`
      SELECT id, contract_json FROM workflow_preset_revisions WHERE id=?
    `).get(fixture.workflowRevisionId)).toBeDefined()
    expect(db.prepare(`
      SELECT id, preset_snapshot FROM batch_jobs WHERE id=?
    `).get(fixture.batchId)).toBeDefined()
    expect(db.prepare(`
      SELECT id, endpoint_id, model, agent_snapshot
      FROM agent_invocations WHERE id=?
    `).get(fixture.invocationId)).toEqual({
      id: fixture.invocationId,
      endpoint_id: fixture.endpointId,
      model: 'historical-model',
      agent_snapshot: JSON.stringify({ rolePrompt: 'private historical prompt' }),
    })

    const profile = db.prepare(`
      SELECT default_worker_json, review_agent_json
      FROM workspace_model_profiles WHERE direction='en_to_zh'
    `).get() as { default_worker_json: string; review_agent_json: string }
    expect(JSON.parse(profile.default_worker_json)).toMatchObject({
      endpointId: null,
      model: 'bound-model',
      contextWindow: 64_000,
    })
    expect(JSON.parse(profile.review_agent_json)).toMatchObject({
      endpointId: null,
      model: 'bound-model',
      contextWindow: 64_000,
    })
  })

  it('rolls back every unbind when endpoint deletion fails', async () => {
    const fixture = seedReferencedEndpoint(db)
    db.exec(`
      CREATE TRIGGER block_test_endpoint_delete
      BEFORE DELETE ON endpoints
      WHEN OLD.id = ${fixture.endpointId}
      BEGIN
        SELECT RAISE(ABORT, 'blocked for rollback test');
      END;
    `)

    const response = await DELETE(
      new NextRequest(
        `http://localhost/api/endpoints/${fixture.endpointId}?force=1`,
        { method: 'DELETE' },
      ),
      { params: Promise.resolve({ id: String(fixture.endpointId) }) },
    )

    expect(response.status).toBe(500)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(db.prepare('SELECT id FROM endpoints WHERE id=?')
      .get(fixture.endpointId)).toBeDefined()
    expect(db.prepare('SELECT COUNT(*) FROM translator_agents WHERE endpoint_id=?')
      .pluck().get(fixture.endpointId)).toBe(1)
    expect(db.prepare(`
      SELECT endpoint_override_id FROM agent_direction_variants WHERE id=?
    `).get(fixture.variantId)).toEqual({
      endpoint_override_id: fixture.endpointId,
    })
    expect(db.prepare(`
      SELECT selected_endpoint_id FROM onboarding_state WHERE id=1
    `).get()).toEqual({ selected_endpoint_id: fixture.endpointId })
    expect(db.prepare(`
      SELECT COUNT(*) FROM endpoint_capability_profiles WHERE endpoint_id=?
    `).pluck().get(fixture.endpointId)).toBe(1)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
})
