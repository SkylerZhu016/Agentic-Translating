import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from '../../src/lib/db/migrate'
import { chatCompletion, LLMError, type LLMStreamEvent } from '../../src/lib/llm/client'
import {
  startVNextRun,
  waitForVNextRunsToSettle,
} from '../../src/lib/orchestration/vnext-runner'
import {
  INTEGRATED_REVIEW_MARKER,
  reviewCallCount,
  reviewExecutionStrategy,
} from '../../src/lib/prompts/review-strategy'
import { SEMANTIC_JSON_PROTOCOL_MARKER } from '../../src/lib/protocol/semantic-output'
import { readReasoningPreviews } from '../../src/lib/orchestration/live-preview'
import { getBuiltinDirectionBundle } from '../../src/lib/prompts/bidirectional'
import type { DirectionPromptBundle } from '../../src/lib/contracts/vnext'

vi.mock('../../src/lib/llm/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/llm/client')>(),
  chatCompletion: vi.fn(),
}))

vi.mock('../../src/lib/constants', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/constants')>(),
  RETRY_DELAYS_MS: [0, 0],
}))

const sessionId = 'review-strategy-session'
const jsonPrompt = SEMANTIC_JSON_PROTOCOL_MARKER
const integratedPrompt = `${jsonPrompt}\n${INTEGRATED_REVIEW_MARKER}\nReview all applicable dimensions.`
const report = (model: string) => JSON.stringify({
  body: `${model} report`,
  annotation: `${model} note`,
})

function seedCandidates(
  db: Database.Database,
  reviewPrompt: string,
  bundle?: DirectionPromptBundle,
) {
  const direction = bundle?.direction ?? 'en_to_zh'
  const sourceText = direction === 'en_to_zh' ? 'The gate is open.' : '大门开着。'
  const candidateBody = direction === 'en_to_zh' ? '大门开着。' : 'The gate is open.'
  const binding = (model: string) => ({
    endpointId: 1, model, contextWindow: 128_000, maxOutputTokens: 2_048,
  })
  const variants = ['semantic-fidelity', 'target-naturalness'].map((id, index) => ({
    id, archetypeId: id, direction, catalogName: id,
    catalogDescription: '', rolePrompt: '', promptLanguage: 'en',
    promptVersion: 1, enabled: true, endpointOverrideId: null,
    modelOverride: null, sortOrder: index,
  }))
  const snapshot = {
    version: 3,
    direction,
    promptBundleSnapshot: bundle ?? {
      direction: 'en_to_zh', promptLanguage: 'en',
      mainAgentSystemPrompt: '', workerBasePrompt: '', reviewPrompt,
      filterPrompt: jsonPrompt, orchestratePrompt: jsonPrompt,
      assemblePrompt: jsonPrompt, editingPrompt: '', toolDescriptions: {},
      version: 1,
    },
    agentVariantSnapshots: variants,
    endpointSnapshots: [{
      id: 1, name: 'synthetic', baseUrl: 'https://synthetic.invalid',
      chatCompletionsPath: '/v1/chat/completions', hasApiKey: true,
      contextWindow: 128_000,
    }],
    modelBindings: {
      defaultWorker: binding('worker-model'), mainAgent: binding('main-model'),
      reviewAgent: binding('review-model'), filterAgent: binding('filter-model'),
      orchestrateAgent: binding('orchestrate-model'),
      assembleAgent: binding('assemble-model'), editingAgent: binding('edit-model'),
    },
    presetRevisionSnapshot: {
      id: 'revision', presetId: 'preset', revisionNo: 1,
      contract: { agentVariantIds: variants.map((variant) => variant.id) },
      createdAt: '2026-08-11T00:00:00.000Z',
    },
    taskBrief: '', constraints: {},
    orchestrationPolicy: {
      teamPolicy: 'fixed', reviewMode: 'four_stage', maxAgentCalls: 2,
    },
  }
  db.prepare(`
    INSERT INTO endpoints (id, name, base_url, api_key)
    VALUES (1, 'synthetic', 'https://synthetic.invalid', 'synthetic-mock-key')
  `).run()
  db.prepare(`
    INSERT INTO sessions (
      id, source_text, source_lang, target_lang, state, config_snapshot,
      direction, task_brief, review_mode
    ) VALUES (?, ?, ?, ?, 'translated', ?, ?, '', 'four_stage')
  `).run(
    sessionId, sourceText,
    direction === 'en_to_zh' ? 'English' : 'Chinese',
    direction === 'en_to_zh' ? 'Chinese' : 'English',
    JSON.stringify(snapshot), direction,
  )
  db.prepare(`
    INSERT INTO orchestration_runs (id, session_id, status, phase)
    VALUES ('candidate-run', ?, 'complete', 'complete')
  `).run(sessionId)
  for (const variant of variants) {
    db.prepare(`
      INSERT INTO agent_invocations (
        id, session_id, parent_run_id, agent_variant_id, agent_snapshot,
        endpoint_id, model, status, raw_output, body_output
      ) VALUES (?, ?, 'candidate-run', ?, ?, 1, 'worker-model', 'complete', ?, ?)
    `).run(
      `candidate-${variant.id}`, sessionId, variant.id, JSON.stringify(variant),
      candidateBody, candidateBody,
    )
  }
}

describe('frozen review execution strategy', () => {
  it.each([
    ['', 3],
    [`Mention ${INTEGRATED_REVIEW_MARKER} in prose.`, 3],
    [`${INTEGRATED_REVIEW_MARKER}-suffix`, 3],
    [`> ${INTEGRATED_REVIEW_MARKER}`, 3],
    [integratedPrompt, 1],
    [`before\r\n  ${INTEGRATED_REVIEW_MARKER}\t\r\nafter`, 1],
  ] as const)('uses an explicit whole marker line: %s', (prompt, calls) => {
    expect(reviewCallCount(prompt)).toBe(calls)
    expect(reviewExecutionStrategy(prompt)).toBe(
      calls === 1 ? 'integrated' : 'independent_lenses',
    )
  })
})

describe('four-stage integrated review execution', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    vi.mocked(chatCompletion).mockReset()
    vi.mocked(chatCompletion).mockImplementation(async (_endpoint, request) => ({
      content: report(request.model),
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    }))
  })

  afterEach(async () => {
    await waitForVNextRunsToSettle()
    db.close()
  })

  const reviewRequests = () => vi.mocked(chatCompletion).mock.calls
    .filter(([, request]) => request.model === 'review-model')

  function stage(stageName = 'review') {
    return db.prepare(`
      SELECT status, raw_output, error FROM stage_outputs
      WHERE session_id=? AND stage=?
    `).get(sessionId, stageName) as {
      status: string; raw_output: string | null; error: string | null
    } | undefined
  }

  function events(type: string) {
    return (db.prepare(`
      SELECT payload_json FROM run_events WHERE session_id=? AND event_type=?
      ORDER BY seq
    `).all(sessionId, type) as Array<{ payload_json: string }>)
      .map((row) => JSON.parse(row.payload_json))
  }

  it('makes one real integrated review and retains the next three stages, stream and ledger', async () => {
    seedCandidates(db, integratedPrompt)
    vi.mocked(chatCompletion).mockImplementation(async (_endpoint, request) => {
      const raw = report(request.model)
      return (async function* (): AsyncIterable<LLMStreamEvent> {
        request.onReasoning?.({
          source: 'reasoning_content', delta: 'Synthetic reasoning',
          characters: 19, chunks: 1, truncated: false,
        })
        yield { type: 'text', content: raw.slice(0, 15) }
        yield { type: 'text', content: raw.slice(15) }
        yield {
          type: 'done', content: raw,
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        }
      })()
    })
    const { runId } = startVNextRun(db, sessionId)
    await waitForVNextRunsToSettle()

    expect(events('run.interrupted')).toEqual([])
    expect(reviewRequests()).toHaveLength(1)
    expect(chatCompletion).toHaveBeenCalledTimes(4)
    expect(stage()).toEqual({
      status: 'complete', raw_output: report('review-model'), error: null,
    })
    expect(events('stage.completed').map((event) => event.stage))
      .toEqual(['review', 'filter', 'orchestrate', 'assemble'])
    expect(events('stage.audit.started')).toHaveLength(0)
    expect(events('stage.delta').filter((event) => event.stage === 'review')
      .map((event) => event.delta).join('')).toBe('review-model report')
    expect(events('stage.annotation').filter((event) => event.stage === 'review')
      .map((event) => event.delta).join('')).toBe('review-model note')
    expect(readReasoningPreviews(sessionId, 0).find((entry) => entry.payload.stage === 'review'))
      .toMatchObject({
        eventType: 'stage.reasoning',
        payload: { stage: 'review', reasoningPreview: 'Synthetic reasoning' },
      })
    expect(db.prepare(`
      SELECT operation, status, output_tokens FROM llm_call_records
      WHERE run_id=? AND operation='stage_review'
    `).all(runId)).toEqual([{
      operation: 'stage_review', status: 'complete', output_tokens: 10,
    }])
    const filterRequest = vi.mocked(chatCompletion).mock.calls
      .find(([, request]) => request.model === 'filter-model')![1]
    expect(filterRequest.messages[1].content).toContain('review-model report')
    expect(filterRequest.messages[1].content).not.toContain('review-model note')
  })

  it.each([jsonPrompt, 'Review using the frozen legacy protocol.'])(
    'keeps three independent calls for an unmarked frozen prompt: %s',
    async (reviewPrompt) => {
      seedCandidates(db, reviewPrompt)
      startVNextRun(db, sessionId)
      await waitForVNextRunsToSettle()

      expect(reviewRequests()).toHaveLength(3)
      expect(chatCompletion).toHaveBeenCalledTimes(6)
      expect(stage()?.status).toBe('complete')
      expect(events('stage.audit.completed')).toHaveLength(3)
      expect(events('stage.delta').filter((event) => event.stage === 'review'))
        .toHaveLength(0)
      const systems = reviewRequests().map(([, request]) => request.messages[0].content)
      expect(new Set(systems).size).toBe(3)
    },
  )

  it.each(['en_to_zh', 'zh_to_en'] as const)(
    'executes the current %s built-in bundle with a single integrated review',
    async (direction) => {
      const bundle = getBuiltinDirectionBundle(direction)
      seedCandidates(db, bundle.reviewPrompt, bundle)
      startVNextRun(db, sessionId)
      await waitForVNextRunsToSettle()

      expect(events('run.interrupted')).toEqual([])
      expect(reviewRequests()).toHaveLength(1)
      expect(chatCompletion).toHaveBeenCalledTimes(4)
      expect(stage()?.raw_output).toBe(report('review-model'))
      const saved = JSON.parse(db.prepare(
        'SELECT config_snapshot FROM sessions WHERE id=?',
      ).pluck().get(sessionId) as string)
      expect(saved.promptBundleSnapshot).toEqual(bundle)
      expect(saved.preflight.stages.find((item: { stage: string }) => item.stage === 'review'))
        .toMatchObject({ callsWorstCase: 1 })
    },
  )

  it('fails an exhausted invalid integrated response without publishing a successful review', async () => {
    seedCandidates(db, integratedPrompt)
    vi.mocked(chatCompletion).mockResolvedValue({
      content: '{"body":" ","annotation":null}',
    })
    const { runId } = startVNextRun(db, sessionId)
    await waitForVNextRunsToSettle()

    expect(reviewRequests()).toHaveLength(3)
    expect(chatCompletion).toHaveBeenCalledTimes(3)
    expect(stage()?.status).toBe('failed')
    expect(stage('filter')).toBeUndefined()
    expect(events('stage.completed')).toHaveLength(0)
    expect(events('stage.failed')).toHaveLength(1)
    expect(db.prepare(`
      SELECT status, error_code FROM llm_call_records WHERE run_id=?
    `).all(runId)).toEqual(Array.from({ length: 3 }, () => ({
      status: 'failed', error_code: 'llm_call_failed',
    })))
  })

  it.each([1, 2])('preserves the old threshold with %i successful independent lenses', async (successes) => {
    seedCandidates(db, jsonPrompt)
    let reviews = 0
    vi.mocked(chatCompletion).mockImplementation(async (_endpoint, request) => {
      if (request.model !== 'review-model' || reviews++ < successes) {
        return { content: report(request.model) }
      }
      throw new LLMError('auth', 'Synthetic rejection', { retryable: false })
    })
    startVNextRun(db, sessionId)
    await waitForVNextRunsToSettle()

    expect(reviewRequests()).toHaveLength(3)
    expect(stage()?.status).toBe(successes === 2 ? 'complete' : 'failed')
    expect(events('stage.audit.completed')).toHaveLength(successes)
    expect(events('stage.audit.failed')).toHaveLength(3 - successes)
    expect(events('stage.completed')).toHaveLength(successes === 2 ? 4 : 0)
    if (successes === 1) expect(stage('filter')).toBeUndefined()
  })

  it('resumes after a completed integrated review without sending that review again', async () => {
    seedCandidates(db, integratedPrompt)
    vi.mocked(chatCompletion).mockImplementation(async (_endpoint, request) => {
      if (request.model === 'filter-model') {
        throw new LLMError('auth', 'Synthetic filter rejection', { retryable: false })
      }
      return { content: report(request.model) }
    })
    startVNextRun(db, sessionId)
    await waitForVNextRunsToSettle()
    expect(stage()?.status).toBe('complete')
    expect(stage('filter')?.status).toBe('failed')
    expect(reviewRequests()).toHaveLength(1)

    vi.mocked(chatCompletion).mockClear()
    vi.mocked(chatCompletion).mockImplementation(async (_endpoint, request) => ({
      content: report(request.model),
    }))
    startVNextRun(db, sessionId)
    await waitForVNextRunsToSettle()

    expect(reviewRequests()).toHaveLength(0)
    expect(chatCompletion).toHaveBeenCalledTimes(3)
    expect(events('stage.resumed')).toContainEqual({ stage: 'review' })
    expect(stage()).toEqual({
      status: 'complete', raw_output: report('review-model'), error: null,
    })
    expect(stage('assemble')?.status).toBe('complete')
  })
})
