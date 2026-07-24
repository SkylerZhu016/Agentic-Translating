import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { sessionCreateSchema } from '../../src/lib/contracts/schemas'
import { migrate } from '../../src/lib/db/migrate'
import { createRepositories } from '../../src/lib/db/repositories'
import { seed } from '../../src/lib/db/seed'
import { createVNextRepositories } from '../../src/lib/db/vnext-repositories'
import {
  createSessionService,
  InvalidCustomDirectionError,
} from '../../src/lib/services/session-service'

const customBundle = {
  promptLanguage: 'en' as const,
  mainAgentSystemPrompt: 'Coordinate this custom translation direction.',
  workerBasePrompt: 'Produce a complete translation.',
  reviewPrompt: 'Review all candidates.',
  filterPrompt: 'Select the useful candidates.',
  orchestratePrompt: 'Plan the synthesis.',
  assemblePrompt: 'Assemble the final translation.',
  editingPrompt: 'Edit with traceable text tools.',
  toolDescriptions: {
    call_agents: 'Call compatible translation agents.',
    write_draft: 'Create the first evidence-backed draft.',
    replace_text: 'Replace an exact unique text span.',
    submit_final: 'Mark one version as final.',
  },
}

describe('custom translation direction', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    seed(db)
  })

  afterEach(() => db.close())

  it('versions a user-supplied custom prompt bundle', () => {
    const prompts = createVNextRepositories(db).directionPrompts
    expect(prompts.createCustom(customBundle).version).toBe(1)
    expect(
      prompts.createCustom({
        ...customBundle,
        assemblePrompt: 'Assemble a revised final translation.',
      }).version,
    ).toBe(2)
    expect(prompts.getLatest('custom')).toMatchObject({
      direction: 'custom',
      version: 2,
      promptLanguage: 'en',
      assemblePrompt: 'Assemble a revised final translation.',
    })
  })

  it('requires explicit language names at the public session boundary', () => {
    expect(
      sessionCreateSchema.safeParse({
        sourceText: 'Bonjour',
        direction: 'custom',
      }).success,
    ).toBe(false)
    expect(
      sessionCreateSchema.safeParse({
        sourceText: 'Bonjour',
        direction: 'custom',
        sourceLang: 'French',
        targetLang: 'German',
      }).success,
    ).toBe(true)
  })

  it('freezes a custom bundle and at least two custom agents into the session', () => {
    const repos = createRepositories(db)
    const vnext = createVNextRepositories(db)
    const endpointId = Number(
      repos.endpoints.insert({
        name: 'custom-endpoint',
        base_url: 'https://example.invalid/v1',
        api_key: 'temporary-test-key',
      }).lastInsertRowid,
    )
    repos.coordinatorConfig.upsert({
      endpoint_id: endpointId,
      model: 'coordinator-model',
      chat_endpoint_id: endpointId,
      chat_model: 'editing-model',
    })
    vnext.directionPrompts.createCustom(customBundle)
    const variants = [
      {
        id: 'custom-agent-a.custom.1',
        archetypeId: 'custom-agent-a',
        direction: 'custom' as const,
        catalogName: 'Custom A',
        catalogDescription: 'First custom perspective',
        rolePrompt: 'Translate from the first perspective.',
        promptLanguage: 'en' as const,
        promptVersion: 1,
        enabled: true,
        endpointOverrideId: endpointId,
        modelOverride: 'worker-a',
        sortOrder: 1000,
      },
      {
        id: 'custom-agent-b.custom.1',
        archetypeId: 'custom-agent-b',
        direction: 'custom' as const,
        catalogName: 'Custom B',
        catalogDescription: 'Second custom perspective',
        rolePrompt: 'Translate from the second perspective.',
        promptLanguage: 'en' as const,
        promptVersion: 1,
        enabled: true,
        endpointOverrideId: endpointId,
        modelOverride: 'worker-b',
        sortOrder: 1001,
      },
    ]
    variants.forEach((variant) =>
      vnext.agents.createCustom(
        {
          id: variant.archetypeId,
          slug: variant.archetypeId,
          displayNameZh: variant.catalogName,
          category: 'domain',
          tags: ['custom'],
          isBuiltin: false,
        },
        [variant],
      ),
    )

    const service = createSessionService(db, repos)
    expect(() =>
      service.createSession({
        sourceText: 'Bonjour le monde',
        sourceLang: 'French',
        targetLang: 'German',
        direction: 'custom',
        allowedAgentVariantIds: [variants[0].id],
      }),
    ).toThrow(InvalidCustomDirectionError)

    const session = service.createSession({
      sourceText: 'Bonjour le monde',
      sourceLang: 'French',
      targetLang: 'German',
      direction: 'custom',
      allowedAgentVariantIds: variants.map((variant) => variant.id),
    })
    const snapshot = JSON.parse(session.config_snapshot)
    expect(snapshot.direction).toBe('custom')
    expect(snapshot.promptBundleSnapshot.version).toBe(1)
    expect(snapshot.agentVariantSnapshots).toHaveLength(2)
    expect(snapshot.endpointSnapshots[0]).toMatchObject({
      id: endpointId,
      hasApiKey: true,
    })
  })

  it('rejects a preset revision from another direction', () => {
    const repos = createRepositories(db)
    const vnext = createVNextRepositories(db)
    const endpointId = Number(
      repos.endpoints.insert({
        name: 'preset-endpoint',
        base_url: 'https://example.invalid/v1',
        api_key: 'temporary-test-key',
      }).lastInsertRowid,
    )
    repos.coordinatorConfig.upsert({
      endpoint_id: endpointId,
      model: 'coordinator-model',
      chat_endpoint_id: endpointId,
      chat_model: 'editing-model',
    })
    const variants = vnext.agents.listVariants('en_to_zh', false)
    vnext.workflowPresets.create(
      {
        id: 'opposite-preset',
        name: '反向预设',
        description: '',
        direction: 'en_to_zh',
      },
      {
        id: 'opposite-preset-r1',
        presetId: 'opposite-preset',
        revisionNo: 1,
        contract: {
          sourceLang: 'English',
          targetLang: 'Chinese',
          taskBriefTemplate: '',
          teamPolicy: 'dynamic',
          reviewMode: 'main_editor',
          agentVariantIds: variants.map((variant) => variant.id),
          agentVariantSnapshots: variants,
          defaultWorkerBinding: {
            endpointId,
            model: 'worker-model',
            contextWindow: null,
          },
          agentBindingOverrides: {},
          mainAgentBinding: {
            endpointId,
            model: 'coordinator-model',
            contextWindow: null,
          },
          editingAgentBinding: {
            endpointId,
            model: 'editing-model',
            contextWindow: null,
          },
          promptBundleVersion: 1,
          maxAgentCalls: 5,
          batchConcurrency: 2,
          constraints: {},
        },
        createdAt: new Date().toISOString(),
      },
    )

    const service = createSessionService(db, repos)
    expect(() =>
      service.createSession({
        direction: 'zh_to_en',
        sourceText: '测试',
        sourceLang: 'Chinese',
        targetLang: 'English',
        presetRevisionId: 'opposite-preset-r1',
      }),
    ).toThrow(InvalidCustomDirectionError)
  })
})
