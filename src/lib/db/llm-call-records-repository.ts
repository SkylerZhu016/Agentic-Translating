import type Database from 'better-sqlite3'
import {
  llmAnalyticsOverviewSchema,
  llmCallBeginSchema,
  llmCallRecordSchema,
  llmCallReferenceIdSchema,
  modelPriceSnapshotSchema,
  type LlmAnalyticsOverview,
  type LlmCallRecord,
  type LlmCallStatus,
  type LlmCostSource,
  type LlmUsageSource,
  type ModelPriceSnapshot,
} from '../contracts/llm-call-records'

interface LlmCallRecordRow {
  id: string
  session_id: string | null
  run_id: string | null
  invocation_id: string | null
  endpoint_id: number
  operation: string
  requested_model: string
  response_model: string | null
  status: LlmCallStatus
  input_tokens: number | null
  output_tokens: number | null
  reasoning_tokens: number | null
  usage_source: LlmUsageSource
  first_byte_ms: number | null
  latency_ms: number | null
  retry_count: number
  price_snapshot_json: string | null
  cost_amount: number | null
  cost_currency: string | null
  cost_source: LlmCostSource
  error_code: string | null
  created_at: string
  updated_at: string
}

export interface NewLlmCallRecord {
  id: string
  sessionId: string | null
  runId: string | null
  invocationId: string | null
  endpointId: number
  operation: string
  requestedModel: string
  status: 'queued' | 'connecting'
  retryCount: number
}

export interface TerminalLlmCallUpdate {
  responseModel: string | null
  inputTokens: number | null
  outputTokens: number | null
  reasoningTokens: number | null
  usageSource: LlmUsageSource
  latencyMs: number
  priceSnapshot: ModelPriceSnapshot | null
  costAmount: number | null
  costCurrency: string | null
  costSource: LlmCostSource
}

export class LlmCallRecordDataError extends Error {
  readonly code = 'invalid_llm_call_record_data'

  constructor(recordId: string, cause?: unknown) {
    super(`LLM call record ${recordId} contains invalid persisted data.`)
    this.name = 'LlmCallRecordDataError'
    this.cause = cause
  }
}

function parsePriceSnapshot(
  recordId: string,
  value: string | null,
): ModelPriceSnapshot | null {
  if (value === null) return null
  try {
    return modelPriceSnapshotSchema.parse(JSON.parse(value))
  } catch (error) {
    throw new LlmCallRecordDataError(recordId, error)
  }
}

function encodePriceSnapshot(
  value: ModelPriceSnapshot | null,
): string | null {
  if (value === null) return null
  return JSON.stringify(modelPriceSnapshotSchema.parse(value))
}

function mapRecord(row: LlmCallRecordRow | undefined): LlmCallRecord | null {
  if (!row) return null
  try {
    return llmCallRecordSchema.parse({
      id: row.id,
      sessionId: row.session_id,
      runId: row.run_id,
      invocationId: row.invocation_id,
      endpointId: row.endpoint_id,
      operation: row.operation,
      requestedModel: row.requested_model,
      responseModel: row.response_model,
      status: row.status,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      reasoningTokens: row.reasoning_tokens,
      usageSource: row.usage_source,
      firstByteMs: row.first_byte_ms,
      latencyMs: row.latency_ms,
      retryCount: row.retry_count,
      priceSnapshot: parsePriceSnapshot(row.id, row.price_snapshot_json),
      costAmount: row.cost_amount,
      costCurrency: row.cost_currency,
      costSource: row.cost_source,
      errorCode: row.error_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })
  } catch (error) {
    if (error instanceof LlmCallRecordDataError) throw error
    throw new LlmCallRecordDataError(row.id, error)
  }
}

interface BreakdownRow {
  dimension: string | number
  call_count: number
  complete_count: number
  failed_count: number
  cancelled_count: number
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  average_first_byte_ms: number | null
  average_latency_ms: number | null
}

function mapBreakdownMetrics(row: BreakdownRow) {
  return {
    callCount: row.call_count,
    completeCount: row.complete_count,
    failedCount: row.failed_count,
    cancelledCount: row.cancelled_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    averageFirstByteMs: row.average_first_byte_ms,
    averageLatencyMs: row.average_latency_ms,
  }
}

const BREAKDOWN_METRICS_SQL = `
  COUNT(*) AS call_count,
  COALESCE(SUM(status = 'complete'), 0) AS complete_count,
  COALESCE(SUM(status = 'failed'), 0) AS failed_count,
  COALESCE(SUM(status = 'cancelled'), 0) AS cancelled_count,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
  AVG(first_byte_ms) AS average_first_byte_ms,
  AVG(latency_ms) AS average_latency_ms
`

export function createLlmCallRecordsRepository(db: Database.Database) {
  const insertStatement = db.prepare(`
    INSERT INTO llm_call_records (
      id, session_id, run_id, invocation_id, endpoint_id, operation,
      requested_model, status, retry_count
    ) VALUES (
      @id, @session_id, @run_id, @invocation_id, @endpoint_id, @operation,
      @requested_model, @status, @retry_count
    )
  `)
  const getStatement = db.prepare(
    'SELECT * FROM llm_call_records WHERE id = ?',
  )
  const markReceivingStatement = db.prepare(`
    UPDATE llm_call_records
    SET status = 'receiving',
        response_model = COALESCE(@response_model, response_model),
        first_byte_ms = COALESCE(first_byte_ms, @first_byte_ms),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = @id AND status IN ('queued', 'connecting')
  `)
  const completeStatement = db.prepare(`
    UPDATE llm_call_records
    SET status = 'complete',
        response_model = COALESCE(@response_model, response_model),
        input_tokens = @input_tokens,
        output_tokens = @output_tokens,
        reasoning_tokens = @reasoning_tokens,
        usage_source = @usage_source,
        latency_ms = @latency_ms,
        price_snapshot_json = @price_snapshot_json,
        cost_amount = @cost_amount,
        cost_currency = @cost_currency,
        cost_source = @cost_source,
        error_code = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = @id AND status IN ('queued', 'connecting', 'receiving')
  `)
  const failStatement = db.prepare(`
    UPDATE llm_call_records
    SET status = @status,
        response_model = COALESCE(@response_model, response_model),
        input_tokens = @input_tokens,
        output_tokens = @output_tokens,
        reasoning_tokens = @reasoning_tokens,
        usage_source = @usage_source,
        latency_ms = @latency_ms,
        price_snapshot_json = @price_snapshot_json,
        cost_amount = @cost_amount,
        cost_currency = @cost_currency,
        cost_source = @cost_source,
        error_code = @error_code,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = @id AND status IN ('queued', 'connecting', 'receiving')
  `)

  const statusTotalsStatement = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(status = 'queued'), 0) AS queued,
      COALESCE(SUM(status = 'connecting'), 0) AS connecting,
      COALESCE(SUM(status = 'receiving'), 0) AS receiving,
      COALESCE(SUM(status = 'complete'), 0) AS complete,
      COALESCE(SUM(status = 'failed'), 0) AS failed,
      COALESCE(SUM(status = 'cancelled'), 0) AS cancelled
    FROM llm_call_records
  `)
  const usageTotalsStatement = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens
    FROM llm_call_records
  `)
  const usageBySourceStatement = db.prepare(`
    SELECT usage_source AS source,
      COUNT(*) AS call_count,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens
    FROM llm_call_records
    GROUP BY usage_source
    ORDER BY CASE usage_source
      WHEN 'provider' THEN 1 WHEN 'estimated' THEN 2 ELSE 3 END
  `)
  const costsStatement = db.prepare(`
    SELECT cost_source AS source, cost_currency AS currency,
      SUM(cost_amount) AS amount, COUNT(*) AS call_count
    FROM llm_call_records
    WHERE cost_source IN ('provider', 'estimated')
    GROUP BY cost_source, cost_currency
    ORDER BY CASE cost_source WHEN 'provider' THEN 1 ELSE 2 END, cost_currency
  `)
  const unknownCostsStatement = db.prepare(`
    SELECT COUNT(*) AS count
    FROM llm_call_records
    WHERE cost_source = 'unknown'
  `)
  const timingStatement = db.prepare(`
    SELECT AVG(first_byte_ms) AS average_first_byte_ms,
      AVG(latency_ms) AS average_latency_ms
    FROM llm_call_records
  `)
  const operationBreakdownStatement = db.prepare(`
    SELECT operation AS dimension, ${BREAKDOWN_METRICS_SQL}
    FROM llm_call_records
    GROUP BY operation
    ORDER BY call_count DESC, operation
  `)
  const modelBreakdownStatement = db.prepare(`
    SELECT requested_model AS dimension, ${BREAKDOWN_METRICS_SQL}
    FROM llm_call_records
    GROUP BY requested_model
    ORDER BY call_count DESC, requested_model
  `)
  const endpointBreakdownStatement = db.prepare(`
    SELECT endpoint_id AS dimension, ${BREAKDOWN_METRICS_SQL}
    FROM llm_call_records
    GROUP BY endpoint_id
    ORDER BY call_count DESC, endpoint_id
  `)

  const getById = (id: string) =>
    mapRecord(getStatement.get(id) as LlmCallRecordRow | undefined)

  return {
    insert(input: NewLlmCallRecord): LlmCallRecord {
      const id = llmCallReferenceIdSchema.parse(input.id)
      const parsed = llmCallBeginSchema.parse({
        sessionId: input.sessionId,
        runId: input.runId,
        invocationId: input.invocationId,
        endpointId: input.endpointId,
        operation: input.operation,
        requestedModel: input.requestedModel,
        retryCount: input.retryCount,
        initialStatus: input.status,
      })
      insertStatement.run({
        id,
        session_id: parsed.sessionId ?? null,
        run_id: parsed.runId ?? null,
        invocation_id: parsed.invocationId ?? null,
        endpoint_id: parsed.endpointId,
        operation: parsed.operation,
        requested_model: parsed.requestedModel,
        status: parsed.initialStatus,
        retry_count: parsed.retryCount,
      })
      return getById(id)!
    },

    getById,

    markReceiving(input: {
      id: string
      responseModel: string | null
      firstByteMs: number
    }): LlmCallRecord {
      markReceivingStatement.run({
        id: input.id,
        response_model: input.responseModel,
        first_byte_ms: input.firstByteMs,
      })
      return getById(input.id)!
    },

    complete(id: string, input: TerminalLlmCallUpdate): LlmCallRecord {
      completeStatement.run({
        id,
        response_model: input.responseModel,
        input_tokens: input.inputTokens,
        output_tokens: input.outputTokens,
        reasoning_tokens: input.reasoningTokens,
        usage_source: input.usageSource,
        latency_ms: input.latencyMs,
        price_snapshot_json: encodePriceSnapshot(input.priceSnapshot),
        cost_amount: input.costAmount,
        cost_currency: input.costCurrency,
        cost_source: input.costSource,
      })
      return getById(id)!
    },

    fail(
      id: string,
      status: 'failed' | 'cancelled',
      errorCode: string,
      input: TerminalLlmCallUpdate,
    ): LlmCallRecord {
      failStatement.run({
        id,
        status,
        error_code: errorCode,
        response_model: input.responseModel,
        input_tokens: input.inputTokens,
        output_tokens: input.outputTokens,
        reasoning_tokens: input.reasoningTokens,
        usage_source: input.usageSource,
        latency_ms: input.latencyMs,
        price_snapshot_json: encodePriceSnapshot(input.priceSnapshot),
        cost_amount: input.costAmount,
        cost_currency: input.costCurrency,
        cost_source: input.costSource,
      })
      return getById(id)!
    },

    overview(): LlmAnalyticsOverview {
      return db.transaction(() => {
        const calls = statusTotalsStatement.get() as LlmAnalyticsOverview['calls']
        const usageTotals = usageTotalsStatement.get() as {
          input_tokens: number
          output_tokens: number
          reasoning_tokens: number
        }
        const usageBySource = usageBySourceStatement.all() as Array<{
          source: LlmUsageSource
          call_count: number
          input_tokens: number
          output_tokens: number
          reasoning_tokens: number
        }>
        const knownCosts = costsStatement.all() as Array<{
          source: 'provider' | 'estimated'
          currency: string
          amount: number
          call_count: number
        }>
        const unknownCosts = unknownCostsStatement.get() as { count: number }
        const timing = timingStatement.get() as {
          average_first_byte_ms: number | null
          average_latency_ms: number | null
        }
        const operations = operationBreakdownStatement.all() as BreakdownRow[]
        const models = modelBreakdownStatement.all() as BreakdownRow[]
        const endpoints = endpointBreakdownStatement.all() as BreakdownRow[]

        return llmAnalyticsOverviewSchema.parse({
          generatedAt: new Date().toISOString(),
          calls,
          usage: {
            inputTokens: usageTotals.input_tokens,
            outputTokens: usageTotals.output_tokens,
            reasoningTokens: usageTotals.reasoning_tokens,
            bySource: usageBySource.map((row) => ({
              source: row.source,
              callCount: row.call_count,
              inputTokens: row.input_tokens,
              outputTokens: row.output_tokens,
              reasoningTokens: row.reasoning_tokens,
            })),
          },
          costs: {
            known: knownCosts.map((row) => ({
              source: row.source,
              currency: row.currency,
              amount: row.amount,
              callCount: row.call_count,
            })),
            unknownCallCount: unknownCosts.count,
          },
          timing: {
            averageFirstByteMs: timing.average_first_byte_ms,
            averageLatencyMs: timing.average_latency_ms,
          },
          byOperation: operations.map((row) => ({
            operation: String(row.dimension),
            ...mapBreakdownMetrics(row),
          })),
          byModel: models.map((row) => ({
            requestedModel: String(row.dimension),
            ...mapBreakdownMetrics(row),
          })),
          byEndpoint: endpoints.map((row) => ({
            endpointId: Number(row.dimension),
            ...mapBreakdownMetrics(row),
          })),
        })
      })()
    },
  }
}
