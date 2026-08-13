import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import {
  llmCallBeginSchema,
  llmCallCompleteSchema,
  llmCallFailSchema,
  llmCallReceivingSchema,
  llmCallReferenceIdSchema,
  type LlmAnalyticsOverview,
  type LlmCallBeginInput,
  type LlmCallCompleteInput,
  type LlmCallCost,
  type LlmCallFailInput,
  type LlmCallReceivingInput,
  type LlmCallRecord,
  type LlmCallUsage,
} from '../contracts/llm-call-records'
import {
  createLlmCallRecordsRepository,
  type TerminalLlmCallUpdate,
} from '../db/llm-call-records-repository'

export class LlmCallRecordNotFoundError extends Error {
  readonly code = 'llm_call_record_not_found'

  constructor(id: string) {
    super(`LLM call record not found: ${id}`)
    this.name = 'LlmCallRecordNotFoundError'
  }
}

export class InvalidLlmCallTransitionError extends Error {
  readonly code = 'invalid_llm_call_transition'

  constructor(
    readonly id: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`LLM call record ${id} cannot transition from ${from} to ${to}.`)
    this.name = 'InvalidLlmCallTransitionError'
  }
}

export class InvalidLlmCallReferenceError extends Error {
  readonly code = 'invalid_llm_call_reference'

  constructor(message: string) {
    super(message)
    this.name = 'InvalidLlmCallReferenceError'
  }
}

export class InvalidLlmCostEstimateError extends Error {
  readonly code = 'invalid_llm_cost_estimate'

  constructor(message: string) {
    super(message)
    this.name = 'InvalidLlmCostEstimateError'
  }
}

function assertSameReference(
  label: string,
  provided: string | null,
  expected: string,
): string {
  if (provided !== null && provided !== expected) {
    throw new InvalidLlmCallReferenceError(
      `${label} does not match the referenced orchestration record.`,
    )
  }
  return expected
}

function elapsedMs(record: LlmCallRecord, now: () => number): number {
  const createdAt = Date.parse(record.createdAt)
  if (!Number.isFinite(createdAt)) return 0
  return Math.max(0, Math.round(now() - createdAt))
}

function normalizeUsage(usage: LlmCallUsage | undefined) {
  return usage ?? {
    source: 'unknown' as const,
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
  }
}

function estimateCost(
  usage: LlmCallUsage,
  cost: Extract<LlmCallCost, { source: 'estimated' }>,
): number {
  if (usage.source === 'unknown') {
    throw new InvalidLlmCostEstimateError(
      'Estimated cost requires provider or locally estimated token usage.',
    )
  }
  const components = [
    {
      label: 'input',
      tokens: usage.inputTokens,
      rate: cost.priceSnapshot.inputPerMillionTokens,
    },
    {
      label: 'output',
      tokens: usage.outputTokens,
      rate: cost.priceSnapshot.outputPerMillionTokens,
    },
    {
      label: 'reasoning',
      tokens: usage.reasoningTokens,
      rate: cost.priceSnapshot.reasoningPerMillionTokens,
    },
  ]
  let amount = 0
  for (const component of components) {
    if (component.tokens === null || component.tokens === 0) continue
    if (component.rate === null) {
      throw new InvalidLlmCostEstimateError(
        `Estimated cost is missing the ${component.label} token rate.`,
      )
    }
    amount += (component.tokens * component.rate) / 1_000_000
  }
  return amount
}

function normalizeCost(
  cost: LlmCallCost | undefined,
  usage: LlmCallUsage,
) {
  if (!cost || cost.source === 'unknown') {
    return {
      costSource: 'unknown' as const,
      costAmount: null,
      costCurrency: null,
      priceSnapshot: null,
    }
  }
  if (cost.source === 'provider') {
    return {
      costSource: 'provider' as const,
      costAmount: cost.amount,
      costCurrency: cost.currency,
      priceSnapshot: null,
    }
  }
  return {
    costSource: 'estimated' as const,
    costAmount: estimateCost(usage, cost),
    costCurrency: cost.currency,
    priceSnapshot: cost.priceSnapshot,
  }
}

function terminalUpdate(
  record: LlmCallRecord,
  input: {
    responseModel?: string | null
    usage?: LlmCallUsage
    cost?: LlmCallCost
    latencyMs?: number
  },
  now: () => number,
): TerminalLlmCallUpdate {
  const usage = normalizeUsage(input.usage)
  const cost = normalizeCost(input.cost, usage)
  return {
    responseModel: input.responseModel ?? null,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    usageSource: usage.source,
    latencyMs: input.latencyMs ?? elapsedMs(record, now),
    ...cost,
  }
}

export function createLlmCallRecordsService(
  db: Database.Database,
  options: {
    now?: () => number
    createId?: () => string
  } = {},
) {
  const repository = createLlmCallRecordsRepository(db)
  const now = options.now ?? Date.now
  const createId = options.createId ?? randomUUID

  const requireRecord = (id: string): LlmCallRecord => {
    const safeId = llmCallReferenceIdSchema.parse(id)
    const record = repository.getById(safeId)
    if (!record) throw new LlmCallRecordNotFoundError(safeId)
    return record
  }

  const resolveReferences = (input: {
    sessionId?: string | null
    runId?: string | null
    invocationId?: string | null
    endpointId: number
  }) => {
    let sessionId = input.sessionId ?? null
    let runId = input.runId ?? null
    const invocationId = input.invocationId ?? null

    if (invocationId !== null) {
      const invocation = db.prepare(`
        SELECT session_id, parent_run_id, endpoint_id
        FROM agent_invocations
        WHERE id = ?
      `).get(invocationId) as
        | { session_id: string; parent_run_id: string; endpoint_id: number }
        | undefined
      if (!invocation) {
        throw new InvalidLlmCallReferenceError(
          `Invocation ${invocationId} does not exist.`,
        )
      }
      if (invocation.endpoint_id !== input.endpointId) {
        throw new InvalidLlmCallReferenceError(
          'endpointId does not match the referenced invocation.',
        )
      }
      sessionId = assertSameReference(
        'sessionId',
        sessionId,
        invocation.session_id,
      )
      runId = assertSameReference('runId', runId, invocation.parent_run_id)
    }

    if (runId !== null) {
      const run = db.prepare(
        'SELECT session_id FROM orchestration_runs WHERE id = ?',
      ).get(runId) as { session_id: string } | undefined
      if (!run) {
        throw new InvalidLlmCallReferenceError(`Run ${runId} does not exist.`)
      }
      sessionId = assertSameReference('sessionId', sessionId, run.session_id)
    }

    if (sessionId !== null) {
      const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(
        sessionId,
      ) as { id: string } | undefined
      if (!session) {
        throw new InvalidLlmCallReferenceError(
          `Session ${sessionId} does not exist.`,
        )
      }
    }

    return { sessionId, runId, invocationId }
  }

  return {
    begin(input: LlmCallBeginInput): LlmCallRecord {
      const parsed = llmCallBeginSchema.parse(input)
      const references = resolveReferences(parsed)
      return repository.insert({
        id: createId(),
        ...references,
        endpointId: parsed.endpointId,
        operation: parsed.operation,
        requestedModel: parsed.requestedModel,
        retryCount: parsed.retryCount,
        status: parsed.initialStatus,
      })
    },

    markReceiving(
      id: string,
      input: LlmCallReceivingInput = {},
    ): LlmCallRecord {
      const parsed = llmCallReceivingSchema.parse(input)
      const record = requireRecord(id)
      if (record.status === 'receiving') return record
      if (record.status !== 'queued' && record.status !== 'connecting') {
        throw new InvalidLlmCallTransitionError(
          id,
          record.status,
          'receiving',
        )
      }
      const updated = repository.markReceiving({
        id,
        responseModel: parsed.responseModel ?? null,
        firstByteMs: parsed.firstByteMs ?? elapsedMs(record, now),
      })
      if (updated.status !== 'receiving') {
        throw new InvalidLlmCallTransitionError(
          id,
          updated.status,
          'receiving',
        )
      }
      return updated
    },

    complete(id: string, input: LlmCallCompleteInput = {}): LlmCallRecord {
      const parsed = llmCallCompleteSchema.parse(input)
      const record = requireRecord(id)
      if (record.status === 'complete') return record
      if (record.status === 'failed' || record.status === 'cancelled') {
        throw new InvalidLlmCallTransitionError(id, record.status, 'complete')
      }
      const updated = repository.complete(
        id,
        terminalUpdate(record, parsed, now),
      )
      if (updated.status !== 'complete') {
        throw new InvalidLlmCallTransitionError(
          id,
          updated.status,
          'complete',
        )
      }
      return updated
    },

    fail(id: string, input: LlmCallFailInput): LlmCallRecord {
      const parsed = llmCallFailSchema.parse(input)
      const record = requireRecord(id)
      if (record.status === parsed.outcome) return record
      if (
        record.status === 'complete' ||
        record.status === 'failed' ||
        record.status === 'cancelled'
      ) {
        throw new InvalidLlmCallTransitionError(
          id,
          record.status,
          parsed.outcome,
        )
      }
      const updated = repository.fail(
        id,
        parsed.outcome,
        parsed.errorCode,
        terminalUpdate(record, parsed, now),
      )
      if (updated.status !== parsed.outcome) {
        throw new InvalidLlmCallTransitionError(
          id,
          updated.status,
          parsed.outcome,
        )
      }
      return updated
    },

    getById(id: string): LlmCallRecord | null {
      return repository.getById(llmCallReferenceIdSchema.parse(id))
    },

    overview(): LlmAnalyticsOverview {
      return repository.overview()
    },
  }
}
