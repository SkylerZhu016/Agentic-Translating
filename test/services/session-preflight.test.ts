import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type {
  ConfigSnapshotVNext,
  ModelBinding,
  ReviewMode,
  TeamPolicy,
} from '../../src/lib/contracts/vnext'
import type { ConfigSnapshot } from '../../src/lib/contracts/types'
import {
  assertPhysicalPaidCallPreflight,
  assertSessionPreflight,
  createPreflightedLlmCaller,
  ensureStoredSessionPreflight,
  ensurePaidChatOperationPreflight,
  loadStoredSessionSnapshotForChat,
  resolvePreflightOutputLimit,
  runSessionPreflight,
  sessionPreflightErrorDto,
  SessionPreflightError,
  SessionPreflightSnapshotChangedError,
  SessionPreflightUpgradeRequiredError,
  toSessionPreflightDto,
} from '../../src/lib/services/session-preflight'
import { runFanOut } from '../../src/lib/orchestration/fanout'

function binding(overrides: Partial<ModelBinding> = {}): ModelBinding {
  return {
    endpointId: 1,
    model: 'fixture-model',
    ...overrides,
  }
}

function snapshot(
  teamPolicy: TeamPolicy = 'fixed',
  reviewMode: ReviewMode = 'main_editor',
  contextWindow: number | null = null,
): ConfigSnapshotVNext {
  const commonBinding = binding()
  return {
    version: 3,
    direction: 'en_to_zh',
    promptBundleSnapshot: {
      direction: 'en_to_zh',
      promptLanguage: 'zh',
      mainAgentSystemPrompt: '主编提示',
      workerBasePrompt: '译者提示',
      reviewPrompt: '审查提示',
      filterPrompt: '筛选提示',
      orchestratePrompt: '统筹提示',
      assemblePrompt: '组装提示',
      editingPrompt: '编辑提示',
      toolDescriptions: {},
      version: 1,
    },
    agentVariantSnapshots: [
      {
        id: 'semantic',
        archetypeId: 'semantic-fidelity',
        direction: 'en_to_zh',
        catalogName: '语义',
        catalogDescription: '语义忠实',
        rolePrompt: '忠实翻译',
        promptLanguage: 'zh',
        promptVersion: 1,
        enabled: true,
        endpointOverrideId: null,
        modelOverride: null,
        sortOrder: 1,
      },
      {
        id: 'natural',
        archetypeId: 'target-naturalness',
        direction: 'en_to_zh',
        catalogName: '自然',
        catalogDescription: '自然表达',
        rolePrompt: '自然翻译',
        promptLanguage: 'zh',
        promptVersion: 1,
        enabled: true,
        endpointOverrideId: null,
        modelOverride: null,
        sortOrder: 2,
      },
    ],
    endpointSnapshots: [
      {
        id: 1,
        name: 'fixture',
        baseUrl: 'http://localhost.invalid',
        chatCompletionsPath: '/v1/chat/completions',
        hasApiKey: true,
        contextWindow,
      },
    ],
    modelBindings: {
      defaultWorker: commonBinding,
      mainAgent: commonBinding,
      reviewAgent: commonBinding,
      filterAgent: commonBinding,
      orchestrateAgent: commonBinding,
      assembleAgent: commonBinding,
      editingAgent: commonBinding,
    },
    presetRevisionSnapshot: {
      id: 'revision-1',
      presetId: 'preset-1',
      revisionNo: 1,
      createdAt: '2026-08-20T00:00:00.000Z',
      contract: {
        sourceLang: '英文',
        targetLang: '中文',
        taskBriefTemplate: '',
        teamPolicy,
        reviewMode,
        agentVariantIds: ['semantic', 'natural'],
        agentVariantSnapshots: [],
        defaultWorkerBinding: commonBinding,
        agentBindingOverrides: {},
        mainAgentBinding: commonBinding,
        editingAgentBinding: commonBinding,
        promptBundleVersion: 1,
        maxAgentCalls: 4,
        batchConcurrency: 2,
        constraints: {},
      },
    },
    taskBrief: '',
    constraints: {},
    orchestrationPolicy: {
      teamPolicy,
      reviewMode,
      maxAgentCalls: 4,
      candidateAnnotationMode: 'body_only',
    },
  }
}

describe('session paid-call preflight', () => {
  it('gates the first fanout attempt and every automatic retry', async () => {
    const messages = [{ role: 'user', content: 'Translate this.' }]
    const provider = vi.fn()
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce({ content: 'done' })
    const resolveIdentity = vi.fn(() => ({
      attemptKey: 'worker:fixture',
      stage: 'candidate_generation',
      bindingRole: 'worker:fixture',
      endpointId: 1,
      model: 'fixture-model',
      contextWindow: 32_768,
      maxOutputTokens: 2_048,
    }))
    const caller = createPreflightedLlmCaller(provider, resolveIdentity)

    const result = await runFanOut(
      [{
        agentKey: 'fixture',
        name: 'Fixture',
        endpoint: { baseUrl: 'https://fixture.invalid', apiKey: 'secret' },
        model: 'fixture-model',
        messages,
        maxTokens: 2_048,
      }],
      {},
      caller,
      { retryDelaysMs: [0] },
    )

    expect(result.succeeded).toBe(1)
    expect(resolveIdentity).toHaveBeenCalledTimes(2)
    expect(provider).toHaveBeenCalledTimes(2)
  })

  it('records attempted and prevents provider I/O when a retry gate blocks', async () => {
    const provider = vi.fn().mockResolvedValue({ content: 'done' })
    let physicalCall = 0
    const caller = createPreflightedLlmCaller(provider, () => {
      physicalCall += 1
      return {
        attemptKey: 'worker:fixture',
        stage: 'candidate_generation',
        bindingRole: 'worker:fixture',
        endpointId: 1,
        model: 'fixture-model',
        contextWindow: physicalCall === 1 ? 32_768 : 1_024,
        maxOutputTokens: 2_048,
      }
    })
    const endpoint = { baseUrl: 'https://fixture.invalid', apiKey: 'secret' }
    const request = {
      model: 'fixture-model',
      messages: [{ role: 'user' as const, content: 'Translate this.' }],
      stream: false as const,
      maxTokens: 2_048,
    }

    await expect(caller(endpoint, request)).resolves.toEqual({ content: 'done' })
    await expect(caller(endpoint, request)).rejects.toMatchObject({
      code: 'preflight_context_exceeded',
      params: expect.objectContaining({ attempted: 2 }),
    })
    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('preflights exact physical messages and tools with the frozen output cap', () => {
    const result = assertPhysicalPaidCallPreflight({
      stage: 'chat_edit_round_2',
      bindingRole: 'editingAgent',
      endpointId: 1,
      model: 'fixture-model',
      contextWindow: 32_768,
      maxOutputTokens: 2_048,
      messages: [
        { role: 'system', content: 'Edit carefully.' },
        { role: 'user', content: 'Current transcript.' },
      ],
      tools: [{ type: 'function', function: { name: 'replace_text' } }],
      attempted: 2,
    })

    expect(result.attempted).toBe(2)
    expect(result.outputLimit).toBe(2_048)
    expect(result.estimate.fits).toBe(true)
    expect(result.estimate.estimatedInputTokens).toBeGreaterThan(256)
    expect(result.assumptions).toEqual([])
  })

  it('keeps attempted but excludes messages, tools, and secrets from a physical-call failure', () => {
    const source = 'PRIVATE-CURRENT-MESSAGES'.repeat(300)
    let caught: unknown
    try {
      assertPhysicalPaidCallPreflight({
        stage: 'chat_revision_suggestion_arbiter',
        bindingRole: 'editingAgent',
        endpointId: 1,
        model: 'fixture-model',
        contextWindow: 2_048,
        messages: [{ role: 'user', content: source }],
        tools: [{ description: 'PRIVATE-TOOL-DEFINITION' }],
        attempted: 3,
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(SessionPreflightError)
    const dto = sessionPreflightErrorDto(caught)
    expect(dto?.body.params).toMatchObject({ attempted: 3 })
    const serialized = JSON.stringify(dto)
    expect(serialized).not.toContain('PRIVATE-CURRENT-MESSAGES')
    expect(serialized).not.toContain('PRIVATE-TOOL-DEFINITION')
  })

  it('passes a fixed main-editor branch and records versioned conservative defaults', () => {
    const result = runSessionPreflight({
      sourceText: 'A short source paragraph.',
      snapshot: snapshot(),
    })

    expect(result.status).toBe('pass')
    expect(result.defaultsVersion).toBe('session_preflight_defaults_v2')
    expect(result.branch).toBe('fixed')
    expect(result.stages.some((stage) => stage.stage === 'team_selection')).toBe(false)
    expect(result.stages.some((stage) => stage.stage === 'main_draft')).toBe(true)
    expect(result.assumptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'context_window_defaulted', value: 65_536 }),
        expect.objectContaining({ code: 'max_output_tokens_defaulted', value: 4_096 }),
      ]),
    )
  })

  it('covers dynamic selection plus the three review calls and four-stage deliberation', () => {
    const result = runSessionPreflight({
      sourceText: 'A compact source.',
      snapshot: snapshot('dynamic', 'four_stage', 65_536),
    })

    expect(result.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'team_selection' }),
        expect.objectContaining({ stage: 'review', callsWorstCase: 3 }),
        expect.objectContaining({ stage: 'filter' }),
        expect.objectContaining({ stage: 'orchestrate' }),
        expect.objectContaining({ stage: 'assemble' }),
      ]),
    )
  })

  it('expands a tool-enabled main stage to six growing calls and two child reviews', () => {
    const configured = snapshot('fixed', 'main_editor', 262_144)
    configured.orchestrationPolicy.mainEditorRunMode = 'tool_enabled'
    configured.presetRevisionSnapshot!.contract.mainEditorRunMode = 'tool_enabled'

    const result = runSessionPreflight({
      sourceText: 'A compact source.',
      snapshot: configured,
    })
    const main = result.stages.find((stage) => stage.stage === 'main_draft')
    const child = result.stages.find(
      (stage) => stage.stage === 'main_draft_child_review',
    )

    expect(main).toMatchObject({
      callsWorstCase: 6,
      transcriptGrowthTokensPerRound: expect.any(Number),
    })
    expect(main?.estimatedInputTokensByCall).toHaveLength(6)
    expect(main?.estimatedInputTokensByCall?.[5]).toBeGreaterThan(
      main?.estimatedInputTokensByCall?.[0] ?? 0,
    )
    expect(child).toMatchObject({ callsWorstCase: 2 })
    expect(result.assumptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'bounded_tool_loop_reserved', value: 6 }),
      expect.objectContaining({ code: 'child_review_calls_reserved', value: 2 }),
    ]))
  })

  it('blocks before persistence with a stable code, numeric params, and actions', () => {
    const result = runSessionPreflight({
      sourceText: '原文'.repeat(3_000),
      taskBrief: '完整保留正文',
      snapshot: snapshot('dynamic', 'four_stage', 8_192),
    })

    expect(result.status).toBe('blocked')
    expect(result.failures[0].code).toBe('preflight_context_exceeded')
    expect(result.failures[0].params).toHaveProperty('excessTokens')
    expect(result.failures[0].actions).toContain(
      'choose_model_with_larger_context_window',
    )
    expect(() => assertSessionPreflight(result)).toThrow(SessionPreflightError)
  })

  it('uses explicit binding limits without emitting output/context default assumptions', () => {
    const configured = snapshot()
    configured.modelBindings.defaultWorker = binding({
      contextWindow: 131_072,
      maxOutputTokens: 2_048,
    })
    configured.modelBindings.mainAgent = binding({
      contextWindow: 131_072,
      maxOutputTokens: 2_048,
    })

    const result = runSessionPreflight({
      sourceText: 'Source',
      snapshot: configured,
    })
    expect(result.status).toBe('pass')
    expect(
      result.assumptions.some(
        (item) =>
          item.bindingRole === 'mainAgent' &&
          (item.code === 'context_window_defaulted' ||
            item.code === 'max_output_tokens_defaulted'),
      ),
    ).toBe(false)
  })

  it('resolves output caps by frozen call identity when roles share endpoint and model', () => {
    const configured = snapshot('fixed', 'main_editor', 131_072)
    configured.modelBindings.defaultWorker = binding({
      maxOutputTokens: 2_048,
    })
    configured.modelBindings.mainAgent = binding({
      maxOutputTokens: 8_192,
    })
    const result = runSessionPreflight({ sourceText: 'Source', snapshot: configured })

    expect(resolvePreflightOutputLimit(result, {
      stage: 'candidate_generation',
      bindingRole: 'worker:semantic',
      endpointId: 1,
      model: 'fixture-model',
    })).toBe(2_048)
    expect(resolvePreflightOutputLimit(result, {
      stage: 'main_draft',
      bindingRole: 'mainAgent',
      endpointId: 1,
      model: 'fixture-model',
    })).toBe(8_192)
  })

  it('uses the frozen review binding for chat child-review budgeting', () => {
    const db = new Database(':memory:')
    const configured = snapshot('fixed', 'main_editor', 131_072)
    configured.modelBindings.editingAgent = binding({ maxOutputTokens: 2_048 })
    configured.modelBindings.reviewAgent = binding({ maxOutputTokens: 8_192 })
    configured.preflight = runSessionPreflight({
      sourceText: 'Source',
      snapshot: configured,
    })
    const result = ensurePaidChatOperationPreflight(
      db,
      {
        id: 'v3-chat-review',
        source_text: 'Source',
        task_brief: '',
        config_snapshot: JSON.stringify(configured),
      },
      configured as unknown as ConfigSnapshot,
      {
        endpointId: 1,
        model: 'fixture-model',
        contextWindow: 131_072,
        messages: [{ role: 'user', content: 'Review this.' }],
        tools: [{
          type: 'function',
          function: { name: 'request_review', parameters: {} },
        }],
      },
    )

    expect(result.outputLimit).toBe(2_048)
    expect(result.snapshot.preflight).toBe(configured.preflight)
    expect(result.operationPreflight.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 'chat_edit',
        bindingRole: 'editingAgent',
        reservedOutputTokens: 2_048,
      }),
      expect.objectContaining({
        stage: 'chat_edit_child_review',
        bindingRole: 'reviewAgent',
        reservedOutputTokens: 8_192,
      }),
    ]))
    db.close()
  })

  it('safely backfills a missing v3 preflight before a stored session may run', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source_text TEXT NOT NULL,
        task_brief TEXT,
        config_snapshot TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    const frozen = snapshot()
    ;(frozen.endpointSnapshots[0] as unknown as { apiKey: string }).apiKey =
      'LEGACY-V3-KEY-SENTINEL'
    db.prepare(
      'INSERT INTO sessions (id, source_text, task_brief, config_snapshot) VALUES (?, ?, ?, ?)',
    ).run('session-1', 'Stored source', '', JSON.stringify(frozen))

    const ensured = ensureStoredSessionPreflight(db, {
      id: 'session-1',
      source_text: 'Stored source',
      task_brief: '',
      config_snapshot: JSON.stringify(frozen),
    })

    expect(ensured.preflight?.status).toBe('pass')
    const stored = db.prepare(
      'SELECT config_snapshot FROM sessions WHERE id=?',
    ).get('session-1') as { config_snapshot: string }
    expect(JSON.parse(stored.config_snapshot).preflight.status).toBe('pass')
    expect(stored.config_snapshot).not.toContain('LEGACY-V3-KEY-SENTINEL')
    expect(JSON.parse(stored.config_snapshot).endpointSnapshots[0])
      .not.toHaveProperty('apiKey')
    db.close()
  })

  it('sanitizes a current-preflight v3 snapshot before the fast path returns', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source_text TEXT NOT NULL,
        task_brief TEXT,
        config_snapshot TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    const frozen = snapshot()
    frozen.preflight = runSessionPreflight({
      sourceText: 'Stored source',
      snapshot: frozen,
    })
    const historical = {
      ...frozen,
      endpoint: {
        id: 1,
        name: 'legacy-single',
        base_url: 'https://single.invalid',
        api_key: 'opaque-current-one',
        apiKey: 'opaque-current-two',
      },
      endpoints: [{
        id: 1,
        name: 'legacy-list',
        base_url: 'https://list.invalid',
        api_key: 'opaque-current-three',
        apiKey: 'opaque-current-four',
      }],
    }
    ;(historical.endpointSnapshots[0] as typeof historical.endpointSnapshots[0] & {
      api_key: string
      apiKey: string
    }).api_key = 'opaque-current-five'
    ;(historical.endpointSnapshots[0] as typeof historical.endpointSnapshots[0] & {
      apiKey: string
    }).apiKey = 'opaque-current-six'
    const serialized = JSON.stringify(historical)
    db.prepare(
      'INSERT INTO sessions (id, source_text, task_brief, config_snapshot) VALUES (?, ?, ?, ?)',
    ).run('current-preflight', 'Stored source', '', serialized)
    const storedSession = {
      id: 'current-preflight',
      source_text: 'Stored source',
      task_brief: '',
      config_snapshot: serialized,
    }

    const ensured = ensureStoredSessionPreflight(db, storedSession)
    expect(ensured.preflight).toEqual(frozen.preflight)
    expect(ensured.promptBundleSnapshot).toEqual(frozen.promptBundleSnapshot)
    const once = db.prepare(
      'SELECT config_snapshot FROM sessions WHERE id=?',
    ).pluck().get('current-preflight') as string
    expect(once).not.toMatch(/opaque-current-(?:one|two|three|four|five|six)/)
    expect(JSON.parse(once)).toMatchObject({
      endpoint: {
        id: 1,
        name: 'legacy-single',
        base_url: 'https://single.invalid',
      },
      endpoints: [{
        id: 1,
        name: 'legacy-list',
        base_url: 'https://list.invalid',
      }],
    })

    storedSession.config_snapshot = once
    ensureStoredSessionPreflight(db, storedSession)
    const twice = db.prepare(
      'SELECT config_snapshot FROM sessions WHERE id=?',
    ).pluck().get('current-preflight') as string
    expect(twice).toBe(once)
    db.close()
  })

  it('returns a stable upgrade DTO for pre-v3 sessions', () => {
    const error = new SessionPreflightUpgradeRequiredError(2)
    expect(sessionPreflightErrorDto(error)).toEqual({
      status: 422,
      body: expect.objectContaining({
        error: 'preflight_snapshot_upgrade_required',
        params: { snapshotVersion: 2 },
      }),
    })
  })

  it.each([
    '[]',
    JSON.stringify('private primitive'),
    '42',
    'true',
    'null',
    JSON.stringify({ endpoint: [{ api_key: 'opaque' }] }),
    JSON.stringify({ endpoints: { api_key: 'opaque' } }),
    JSON.stringify({ endpointSnapshots: { apiKey: 'opaque' } }),
  ])(
    'rejects JSON-valid invalid snapshot %s without persisting it',
    (invalidRoot) => {
      const db = new Database(':memory:')
      db.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          source_text TEXT NOT NULL,
          task_brief TEXT,
          config_snapshot TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `)
      db.prepare(
        'INSERT INTO sessions (id, source_text, task_brief, config_snapshot) VALUES (?, ?, ?, ?)',
      ).run('invalid-root', 'Source', '', invalidRoot)
      const storedSession = {
        id: 'invalid-root',
        source_text: 'Source',
        task_brief: '',
        config_snapshot: invalidRoot,
      }

      expect(() => ensureStoredSessionPreflight(db, storedSession))
        .toThrow(SessionPreflightUpgradeRequiredError)
      expect(() => loadStoredSessionSnapshotForChat(db, storedSession))
        .toThrow(SessionPreflightUpgradeRequiredError)
      expect(db.prepare(
        'SELECT config_snapshot FROM sessions WHERE id=?',
      ).pluck().get('invalid-root')).toBe(invalidRoot)
      db.close()
    },
  )

  it('formats localization keys without embedding presentation text', () => {
    const result = runSessionPreflight({
      sourceText: 'Source',
      snapshot: snapshot(),
    })
    const dto = toSessionPreflightDto(result)
    expect(dto.assumptions[0].messageKey).toMatch(/^preflight\.assumption\./)
    expect(dto.summary).not.toHaveProperty('apiKey')
  })

  it('never copies source text or endpoint secrets into preflight or error params', () => {
    const configured = snapshot('dynamic', 'four_stage', 2_048)
    ;(configured.endpointSnapshots[0] as unknown as { apiKey: string }).apiKey =
      'SECRET-KEY-SENTINEL'
    const sourceText = 'PRIVATE-SOURCE-SENTINEL'.repeat(200)
    const result = runSessionPreflight({ sourceText, snapshot: configured })
    const serialized = JSON.stringify(result)

    expect(result.status).toBe('blocked')
    expect(serialized).not.toContain('SECRET-KEY-SENTINEL')
    expect(serialized).not.toContain('PRIVATE-SOURCE-SENTINEL')
    expect(JSON.stringify(sessionPreflightErrorDto(new SessionPreflightError(result))))
      .not.toContain('PRIVATE-SOURCE-SENTINEL')
  })

  it('backfill changes only the preflight member of the frozen snapshot', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source_text TEXT NOT NULL,
        task_brief TEXT,
        config_snapshot TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    const frozen = snapshot('dynamic', 'four_stage', 131_072)
    const serialized = JSON.stringify(frozen)
    db.prepare(
      'INSERT INTO sessions (id, source_text, task_brief, config_snapshot) VALUES (?, ?, ?, ?)',
    ).run('session-invariants', 'Source', 'Brief', serialized)

    const ensured = ensureStoredSessionPreflight(db, {
      id: 'session-invariants',
      source_text: 'Source',
      task_brief: 'Brief',
      config_snapshot: serialized,
    })

    expect(ensured.direction).toBe(frozen.direction)
    expect(ensured.promptBundleSnapshot).toEqual(frozen.promptBundleSnapshot)
    expect(ensured.modelBindings).toEqual(frozen.modelBindings)
    expect(ensured.preflight?.status).toBe('pass')
    db.close()
  })

  it('uses compare-and-swap persistence when a frozen snapshot changes concurrently', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source_text TEXT NOT NULL,
        task_brief TEXT,
        config_snapshot TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    const original = snapshot()
    const staleSerialized = JSON.stringify(original)
    const changed = { ...original, taskBrief: 'Changed concurrently' }
    db.prepare(
      'INSERT INTO sessions (id, source_text, task_brief, config_snapshot) VALUES (?, ?, ?, ?)',
    ).run('session-race', 'Source', '', JSON.stringify(changed))

    expect(() => ensureStoredSessionPreflight(db, {
      id: 'session-race',
      source_text: 'Source',
      task_brief: '',
      config_snapshot: staleSerialized,
    })).toThrow(SessionPreflightSnapshotChangedError)
    db.close()
  })

  it.each(['assembled', 'refining'])('permits a complete v2 %s chat snapshot through a marked compatibility preflight', (state) => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source_text TEXT NOT NULL,
        task_brief TEXT,
        state TEXT NOT NULL,
        config_snapshot TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    const legacy: ConfigSnapshot = {
      version: 2,
      endpoint: {
        id: 1,
        name: 'legacy',
        base_url: 'https://example.invalid',
        chat_completions_path: '/v1/chat/completions',
        api_key: 'legacy-fixture-key',
        context_window: 32_768,
        created_at: '2026-08-20T00:00:00.000Z',
      },
      endpoints: [],
      agents: [{
        id: 1,
        name: 'legacy-worker',
        endpoint_id: 1,
        model: 'legacy-worker-model',
        prompt_override: null,
        sort_order: 1,
        created_at: '2026-08-20T00:00:00.000Z',
      }],
      coordinator: {
        id: 1,
        endpoint_id: 1,
        model: 'legacy-main-model',
        chat_endpoint_id: 1,
        chat_model: 'legacy-edit-model',
        updated_at: '2026-08-20T00:00:00.000Z',
      },
      prompts: { translator: 'Keep the source complete.' },
    }
    const serialized = JSON.stringify(legacy)
    db.prepare(
      'INSERT INTO sessions (id, source_text, task_brief, state, config_snapshot) VALUES (?, ?, ?, ?, ?)',
    ).run('legacy-chat', 'Legacy source', '', state, serialized)
    const session = {
      id: 'legacy-chat',
      source_text: 'Legacy source',
      task_brief: '',
      config_snapshot: serialized,
    }

    const loaded = loadStoredSessionSnapshotForChat(db, session)
    const result = ensurePaidChatOperationPreflight(db, session, loaded, {
      endpointId: 1,
      model: 'legacy-edit-model',
      contextWindow: 32_768,
      messages: [{ role: 'user', content: 'Please revise this sentence.' }],
      tools: [],
    })

    expect(result.outputLimit).toBe(4_096)
    expect(result.snapshot.version).toBe(2)
    expect(result.snapshot.preflight?.compatibility).toEqual({
      kind: 'legacy_v2_chat',
      version: 1,
    })
    expect(result.snapshot.preflight?.stages[0]).toMatchObject({
      callsWorstCase: 1,
    })
    expect(result.snapshot.preflight?.stages[0].estimatedInputTokensByCall)
      .toBeUndefined()
    expect(result.snapshot.coordinator).toEqual(legacy.coordinator)
    expect(result.snapshot.prompts).toEqual(legacy.prompts)
    const persistedLegacy = db.prepare(
      'SELECT config_snapshot FROM sessions WHERE id=?',
    ).get('legacy-chat') as { config_snapshot: string }
    expect(persistedLegacy.config_snapshot).not.toContain('legacy-fixture-key')
    expect(JSON.parse(persistedLegacy.config_snapshot).endpoint)
      .not.toHaveProperty('api_key')

    db.prepare(
      'INSERT INTO sessions (id, source_text, task_brief, state, config_snapshot) VALUES (?, ?, ?, ?, ?)',
    ).run('legacy-chat-tools', 'Legacy source', '', state, serialized)
    const toolSession = {
      id: 'legacy-chat-tools',
      source_text: 'Legacy source',
      task_brief: '',
      config_snapshot: serialized,
    }
    const toolResult = ensurePaidChatOperationPreflight(
      db,
      toolSession,
      loadStoredSessionSnapshotForChat(db, toolSession),
      {
        endpointId: 1,
        model: 'legacy-edit-model',
        contextWindow: 32_768,
        messages: [{ role: 'user', content: 'Please revise this sentence.' }],
        tools: [{
          type: 'function',
          function: { name: 'request_review', parameters: {} },
        }],
      },
    )
    expect(toolResult.snapshot.preflight?.stages[0]).toMatchObject({
      callsWorstCase: 5,
      transcriptGrowthTokensPerRound: expect.any(Number),
    })
    expect(toolResult.snapshot.preflight?.stages[0].estimatedInputTokensByCall)
      .toHaveLength(5)
    expect(toolResult.snapshot.preflight?.stages[1]).toMatchObject({
      stage: 'legacy_v2_chat_child_review',
      callsWorstCase: 2,
    })

    db.prepare(
      'INSERT INTO sessions (id, source_text, task_brief, state, config_snapshot) VALUES (?, ?, ?, ?, ?)',
    ).run('legacy-chat-too-small', 'Legacy source', '', state, serialized)
    const tooSmallSession = {
      id: 'legacy-chat-too-small',
      source_text: 'Legacy source',
      task_brief: '',
      config_snapshot: serialized,
    }
    expect(() => ensurePaidChatOperationPreflight(
      db,
      tooSmallSession,
      loadStoredSessionSnapshotForChat(db, tooSmallSession),
      {
        endpointId: 1,
        model: 'legacy-edit-model',
        contextWindow: 2_048,
        messages: [{ role: 'user', content: 'Private message'.repeat(1_000) }],
        tools: [],
      },
    )).toThrow(SessionPreflightError)
    db.close()
  })

  it('keeps the stable upgrade rejection for an insufficient v2 chat snapshot', () => {
    const db = new Database(':memory:')
    const insufficient: ConfigSnapshot = {
      version: 2,
      endpoint: null,
      endpoints: [],
      agents: [],
      coordinator: null,
      prompts: {},
    }

    expect(() => loadStoredSessionSnapshotForChat(db, {
      id: 'insufficient-v2',
      source_text: 'Source',
      task_brief: '',
      config_snapshot: JSON.stringify(insufficient),
    })).toThrow(SessionPreflightUpgradeRequiredError)
    db.close()
  })
})
