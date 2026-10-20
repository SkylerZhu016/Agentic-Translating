import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHandlers } from '../../app/api/sessions/handlers'
import type {
  DirectionPromptBundle,
  WorkflowPresetContract,
} from '../../src/lib/contracts/vnext'
import { migrate } from '../../src/lib/db/migrate'
import { createRepositories } from '../../src/lib/db/repositories'
import { seed } from '../../src/lib/db/seed'
import { createVNextRepositories } from '../../src/lib/db/vnext-repositories'
import {
  createSessionService,
  PresetPromptBundleNotFoundError,
} from '../../src/lib/services/session-service'

describe('preset prompt version compatibility', () => {
  let db: Database.Database
  let currentBundle: DirectionPromptBundle
  let contract: WorkflowPresetContract

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    seed(db)
    const repos = createRepositories(db)
    const vnext = createVNextRepositories(db)
    const endpointId = Number(repos.endpoints.insert({
      name: 'offline fixture',
      base_url: 'http://127.0.0.1:1',
      api_key: '',
    }).lastInsertRowid)
    repos.coordinatorConfig.upsert({
      endpoint_id: endpointId,
      model: 'fixture-model',
      chat_endpoint_id: endpointId,
      chat_model: 'fixture-model',
    })
    currentBundle = vnext.directionPrompts.getLatest('en_to_zh')!
    expect(currentBundle.version).toBeGreaterThan(1)
    db.prepare(`
      INSERT INTO direction_prompt_bundles (
        direction, version, prompt_language, main_agent_prompt, worker_base_prompt,
        review_prompt, filter_prompt, orchestrate_prompt, assemble_prompt,
        editing_prompt, tool_descriptions, is_builtin
      )
      SELECT direction, 1, prompt_language, 'Frozen legacy main prompt', worker_base_prompt,
        'Frozen legacy review prompt', filter_prompt, orchestrate_prompt,
        assemble_prompt, editing_prompt, tool_descriptions, is_builtin
      FROM direction_prompt_bundles WHERE direction='en_to_zh' AND version=?
    `).run(currentBundle.version)
    const variants = vnext.agents.listVariants('en_to_zh', false).slice(0, 2).map(
      (variant) => ({ ...variant, rolePrompt: `Frozen legacy role ${variant.id}` }),
    )
    const binding = { endpointId, model: 'fixture-model', contextWindow: null }
    contract = {
      sourceLang: 'English',
      targetLang: 'Chinese',
      taskBriefTemplate: '',
      teamPolicy: 'fixed',
      reviewMode: 'main_editor',
      agentVariantIds: variants.map((variant) => variant.id),
      agentVariantSnapshots: variants,
      defaultWorkerBinding: binding,
      agentBindingOverrides: {},
      mainAgentBinding: binding,
      editingAgentBinding: binding,
      promptBundleVersion: 1,
      maxAgentCalls: 5,
      batchConcurrency: 1,
      constraints: {},
    }
    vnext.workflowPresets.create({
      id: 'legacy-preset',
      name: 'Frozen legacy preset',
      description: '',
      direction: 'en_to_zh',
    }, {
      id: 'legacy-preset-r1',
      presetId: 'legacy-preset',
      revisionNo: 1,
      contract,
      createdAt: '',
    })
  })

  afterEach(() => db.close())

  function create(presetRevisionId: string | null = 'legacy-preset-r1', promptBundleRevisionId?: string) {
    return createSessionService(db, createRepositories(db)).createSession({
      sourceText: 'Hello world.',
      sourceLang: 'English',
      targetLang: 'Chinese',
      direction: 'en_to_zh',
      presetRevisionId,
      promptBundleRevisionId,
    })
  }

  it('keeps an old preset on its exact prompt version after a newer bundle is seeded', () => {
    // Simulate an old database before the current seed arrives.
    db.prepare(
      "DELETE FROM direction_prompt_bundles WHERE direction='en_to_zh' AND version>1",
    ).run()
    const existingSession = create()
    const existingSnapshot = existingSession.config_snapshot

    seed(db)
    expect(createVNextRepositories(db).directionPrompts.getLatest('en_to_zh')!.version).toBe(currentBundle.version)
    const newSnapshot = JSON.parse(create().config_snapshot)
    expect(newSnapshot.promptBundleSnapshot).toMatchObject({
      version: 1,
      mainAgentSystemPrompt: 'Frozen legacy main prompt',
      reviewPrompt: 'Frozen legacy review prompt',
    })
    expect(newSnapshot.agentVariantSnapshots).toEqual(contract.agentVariantSnapshots)
    expect(newSnapshot.presetRevisionSnapshot.contract.promptBundleVersion).toBe(1)
    expect(db.prepare('SELECT config_snapshot FROM sessions WHERE id=?').pluck().get(
      existingSession.id,
    )).toBe(existingSnapshot)
  })

  it('uses the latest seeded bundle for a session without a preset', () => {
    const snapshot = JSON.parse(create(null).config_snapshot)
    expect(snapshot.promptBundleSnapshot).toEqual(currentBundle)
    expect(snapshot.presetRevisionSnapshot).toBeNull()
  })

  it('preserves an explicitly selected prompt revision as a deliberate override', () => {
    db.prepare(`
      INSERT INTO prompt_bundle_families (id, name, direction)
      VALUES ('explicit-pack', 'Explicit pack', 'en_to_zh')
    `).run()
    const explicitBundle = { ...currentBundle, reviewPrompt: 'Explicitly chosen review prompt' }
    db.prepare(`
      INSERT INTO prompt_bundle_revisions (id, bundle_id, revision_no, payload_json)
      VALUES ('explicit-pack-r1', 'explicit-pack', 1, ?)
    `).run(JSON.stringify(explicitBundle))
    const snapshot = JSON.parse(create('legacy-preset-r1', 'explicit-pack-r1').config_snapshot)
    expect(snapshot.promptBundleSnapshot).toEqual(explicitBundle)
    expect(snapshot.promptBundleRevisionId).toBe('explicit-pack-r1')
    expect(snapshot.agentVariantSnapshots).toEqual(contract.agentVariantSnapshots)
  })

  it('rejects a missing frozen version with a stable actionable API error and no new session', async () => {
    db.prepare(
      "DELETE FROM direction_prompt_bundles WHERE direction='en_to_zh' AND version=1",
    ).run()
    expect(() => create()).toThrow(PresetPromptBundleNotFoundError)
    const response = await createHandlers(db).POST(new NextRequest(
      'http://localhost/api/sessions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sourceText: 'Hello world.',
          direction: 'en_to_zh',
          presetRevisionId: 'legacy-preset-r1',
        }),
      },
    ))
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      error: 'preset_prompt_bundle_not_found',
      message: expect.stringContaining('Restore that version or explicitly create a new preset revision'),
      params: { direction: 'en_to_zh', version: 1, presetRevisionId: 'legacy-preset-r1' },
    })
    expect(db.prepare('SELECT COUNT(*) FROM sessions').pluck().get()).toBe(0)
    expect(createVNextRepositories(db).workflowPresets.getRevision('legacy-preset-r1')!.contract).toEqual(contract)
  })
})
