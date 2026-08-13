import { z } from 'zod'

export const llmCallStatusSchema = z.enum([
  'queued',
  'connecting',
  'receiving',
  'complete',
  'failed',
  'cancelled',
])

export const llmUsageSourceSchema = z.enum([
  'provider',
  'estimated',
  'unknown',
])

export const llmCostSourceSchema = z.enum([
  'provider',
  'estimated',
  'unknown',
])

export const llmCallReferenceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)

// Operations are controlled application identifiers, never user text.
export const llmOperationSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/)

// Model identifiers may contain provider namespaces, but query/fragment
// delimiters and control characters are rejected so a full endpoint URL (or
// its credentials) cannot accidentally be stored in the ledger.
export const llmModelIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001F\u007F?&=#]+$/u)
  .refine((value) => !value.includes('://'), 'Model must not be a URL.')

export const llmErrorCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9._:-]*$/)

const tokenCountSchema = z.number().int().nonnegative().nullable()
const millisecondsSchema = z.number().int().nonnegative()
const currencySchema = z.string().regex(/^[A-Z]{3}$/)
const moneyAmountSchema = z.number().finite().nonnegative()

export const modelPriceSnapshotSchema = z
  .object({
    currency: currencySchema,
    inputPerMillionTokens: moneyAmountSchema.nullable(),
    outputPerMillionTokens: moneyAmountSchema.nullable(),
    reasoningPerMillionTokens: moneyAmountSchema.nullable(),
    source: z.enum(['provider', 'user_configured']),
    capturedAt: z.string().refine(
      (value) => Number.isFinite(Date.parse(value)),
      'capturedAt must be an ISO-compatible timestamp',
    ),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.inputPerMillionTokens === null &&
      value.outputPerMillionTokens === null &&
      value.reasoningPerMillionTokens === null
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A price snapshot must contain at least one token rate.',
      })
    }
  })

export const llmCallUsageSchema = z
  .object({
    source: llmUsageSourceSchema,
    inputTokens: tokenCountSchema.default(null),
    outputTokens: tokenCountSchema.default(null),
    reasoningTokens: tokenCountSchema.default(null),
  })
  .strict()
  .superRefine((value, context) => {
    const tokenValues = [
      value.inputTokens,
      value.outputTokens,
      value.reasoningTokens,
    ]
    if (
      value.source === 'unknown' &&
      tokenValues.some((tokenValue) => tokenValue !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Unknown usage cannot carry token counts.',
      })
    }
    if (
      value.source !== 'unknown' &&
      tokenValues.every((tokenValue) => tokenValue === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Known usage must carry at least one token count.',
      })
    }
  })

export const llmCallCostSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('unknown') }).strict(),
  z
    .object({
      source: z.literal('provider'),
      amount: moneyAmountSchema,
      currency: currencySchema,
    })
    .strict(),
  z
    .object({
      source: z.literal('estimated'),
      currency: currencySchema,
      priceSnapshot: modelPriceSnapshotSchema,
    })
    .strict()
    .superRefine((value, context) => {
      if (value.currency !== value.priceSnapshot.currency) {
        context.addIssue({
          code: 'custom',
          path: ['currency'],
          message: 'Estimated cost currency must match its price snapshot.',
        })
      }
    }),
])

export const llmCallBeginSchema = z
  .object({
    sessionId: llmCallReferenceIdSchema.nullable().optional(),
    runId: llmCallReferenceIdSchema.nullable().optional(),
    invocationId: llmCallReferenceIdSchema.nullable().optional(),
    endpointId: z.number().int().positive(),
    operation: llmOperationSchema,
    requestedModel: llmModelIdentifierSchema,
    retryCount: z.number().int().nonnegative().default(0),
    initialStatus: z.enum(['queued', 'connecting']).default('connecting'),
  })
  .strict()

export const llmCallReceivingSchema = z
  .object({
    responseModel: llmModelIdentifierSchema.nullable().optional(),
    firstByteMs: millisecondsSchema.optional(),
  })
  .strict()

export const llmCallCompleteSchema = z
  .object({
    responseModel: llmModelIdentifierSchema.nullable().optional(),
    usage: llmCallUsageSchema.optional(),
    cost: llmCallCostSchema.optional(),
    latencyMs: millisecondsSchema.optional(),
  })
  .strict()

export const llmCallFailSchema = z
  .object({
    outcome: z.enum(['failed', 'cancelled']).default('failed'),
    errorCode: llmErrorCodeSchema,
    responseModel: llmModelIdentifierSchema.nullable().optional(),
    usage: llmCallUsageSchema.optional(),
    cost: llmCallCostSchema.optional(),
    latencyMs: millisecondsSchema.optional(),
  })
  .strict()

export const llmCallRecordSchema = z
  .object({
    id: llmCallReferenceIdSchema,
    sessionId: llmCallReferenceIdSchema.nullable(),
    runId: llmCallReferenceIdSchema.nullable(),
    invocationId: llmCallReferenceIdSchema.nullable(),
    endpointId: z.number().int().positive(),
    operation: llmOperationSchema,
    requestedModel: llmModelIdentifierSchema,
    responseModel: llmModelIdentifierSchema.nullable(),
    status: llmCallStatusSchema,
    inputTokens: tokenCountSchema,
    outputTokens: tokenCountSchema,
    reasoningTokens: tokenCountSchema,
    usageSource: llmUsageSourceSchema,
    firstByteMs: millisecondsSchema.nullable(),
    latencyMs: millisecondsSchema.nullable(),
    retryCount: z.number().int().nonnegative(),
    priceSnapshot: modelPriceSnapshotSchema.nullable(),
    costAmount: moneyAmountSchema.nullable(),
    costCurrency: currencySchema.nullable(),
    costSource: llmCostSourceSchema,
    errorCode: llmErrorCodeSchema.nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const tokenValues = [
      value.inputTokens,
      value.outputTokens,
      value.reasoningTokens,
    ]
    if (
      value.usageSource === 'unknown' &&
      tokenValues.some((tokenValue) => tokenValue !== null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['usageSource'],
        message: 'Unknown usage cannot carry token counts.',
      })
    }
    if (
      value.usageSource !== 'unknown' &&
      tokenValues.every((tokenValue) => tokenValue === null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['usageSource'],
        message: 'Known usage must carry at least one token count.',
      })
    }
    if (
      value.costSource === 'unknown' &&
      (value.costAmount !== null ||
        value.costCurrency !== null ||
        value.priceSnapshot !== null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['costSource'],
        message: 'Unknown cost cannot carry an amount or price snapshot.',
      })
    }
    if (
      value.costSource === 'provider' &&
      (value.costAmount === null ||
        value.costCurrency === null ||
        value.priceSnapshot !== null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['costSource'],
        message: 'Provider cost requires an amount and no local price snapshot.',
      })
    }
    if (
      value.costSource === 'estimated' &&
      (value.costAmount === null ||
        value.costCurrency === null ||
        value.priceSnapshot === null ||
        value.costCurrency !== value.priceSnapshot.currency)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['costSource'],
        message: 'Estimated cost requires a matching frozen price snapshot.',
      })
    }
    const isFailure = value.status === 'failed' || value.status === 'cancelled'
    if (isFailure !== (value.errorCode !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['errorCode'],
        message: 'Only failed or cancelled calls may carry an error code.',
      })
    }
  })

const analyticsStatusCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  connecting: z.number().int().nonnegative(),
  receiving: z.number().int().nonnegative(),
  complete: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
})

const analyticsUsageBucketSchema = z.object({
  source: llmUsageSourceSchema,
  callCount: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
})

const analyticsCostBucketSchema = z.object({
  source: z.enum(['provider', 'estimated']),
  currency: currencySchema,
  amount: moneyAmountSchema,
  callCount: z.number().int().nonnegative(),
})

const analyticsBreakdownMetricsSchema = z.object({
  callCount: z.number().int().nonnegative(),
  completeCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  cancelledCount: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  averageFirstByteMs: z.number().nonnegative().nullable(),
  averageLatencyMs: z.number().nonnegative().nullable(),
})

export const llmAnalyticsOverviewSchema = z
  .object({
    generatedAt: z.string().min(1),
    calls: analyticsStatusCountsSchema,
    usage: z.object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      reasoningTokens: z.number().int().nonnegative(),
      bySource: z.array(analyticsUsageBucketSchema),
    }),
    costs: z.object({
      known: z.array(analyticsCostBucketSchema),
      unknownCallCount: z.number().int().nonnegative(),
    }),
    timing: z.object({
      averageFirstByteMs: z.number().nonnegative().nullable(),
      averageLatencyMs: z.number().nonnegative().nullable(),
    }),
    byOperation: z.array(
      analyticsBreakdownMetricsSchema.extend({ operation: llmOperationSchema }),
    ),
    byModel: z.array(
      analyticsBreakdownMetricsSchema.extend({
        requestedModel: llmModelIdentifierSchema,
      }),
    ),
    byEndpoint: z.array(
      analyticsBreakdownMetricsSchema.extend({
        endpointId: z.number().int().positive(),
      }),
    ),
  })
  .strict()

export type LlmCallStatus = z.infer<typeof llmCallStatusSchema>
export type LlmUsageSource = z.infer<typeof llmUsageSourceSchema>
export type LlmCostSource = z.infer<typeof llmCostSourceSchema>
export type ModelPriceSnapshot = z.infer<typeof modelPriceSnapshotSchema>
export type LlmCallUsage = z.infer<typeof llmCallUsageSchema>
export type LlmCallCost = z.infer<typeof llmCallCostSchema>
export type LlmCallBeginInput = z.input<typeof llmCallBeginSchema>
export type LlmCallReceivingInput = z.input<typeof llmCallReceivingSchema>
export type LlmCallCompleteInput = z.input<typeof llmCallCompleteSchema>
export type LlmCallFailInput = z.input<typeof llmCallFailSchema>
export type LlmCallRecord = z.infer<typeof llmCallRecordSchema>
export type LlmAnalyticsOverview = z.infer<typeof llmAnalyticsOverviewSchema>
