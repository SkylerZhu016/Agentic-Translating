import { z } from 'zod'

export const ONBOARDING_SCHEMA_VERSION = 1 as const

const nullableIsoTimestampSchema = z.string().datetime({ offset: true }).nullable()

export const generatedPresetRevisionIdsSchema = z
  .array(z.string().trim().min(1).max(200))
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: 'generatedPresetRevisionIds must not contain duplicates',
  })

export const onboardingStateSchema = z.object({
  schemaVersion: z.literal(ONBOARDING_SCHEMA_VERSION),
  completedAt: nullableIsoTimestampSchema,
  dismissedAt: nullableIsoTimestampSchema,
  lastDoctorRunAt: nullableIsoTimestampSchema,
  selectedEndpointId: z.number().int().positive().nullable(),
  generatedPresetRevisionIds: generatedPresetRevisionIdsSchema,
})

export type OnboardingState = z.infer<typeof onboardingStateSchema>

export const onboardingUpdateSchema = z
  .object({
    completedAt: nullableIsoTimestampSchema.optional(),
    dismissedAt: nullableIsoTimestampSchema.optional(),
    lastDoctorRunAt: nullableIsoTimestampSchema.optional(),
    selectedEndpointId: z.number().int().positive().nullable().optional(),
    generatedPresetRevisionIds: generatedPresetRevisionIdsSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one onboarding field is required',
  })

export type OnboardingUpdate = z.infer<typeof onboardingUpdateSchema>

export const onboardingRecommendedActionSchema = z.enum([
  'start',
  'check_existing',
  'none',
])

export const onboardingStatusSchema = z.object({
  state: onboardingStateSchema,
  hasRunnableConfig: z.boolean(),
  recommendedAction: onboardingRecommendedActionSchema,
})

export type OnboardingStatus = z.infer<typeof onboardingStatusSchema>

export const capabilityResultSchema = z.object({
  supported: z.boolean(),
  error: z.string().max(1_000).nullable(),
})

export type CapabilityResult = z.infer<typeof capabilityResultSchema>

export const endpointCapabilityProfileSchema = z.object({
  endpointId: z.number().int().positive(),
  checkedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  models: z.object({
    supported: z.boolean(),
    count: z.number().int().nonnegative().nullable(),
    error: z.string().max(1_000).nullable(),
  }),
  chat: capabilityResultSchema,
  streaming: capabilityResultSchema,
  usage: capabilityResultSchema,
  tools: capabilityResultSchema,
  reasoningContent: capabilityResultSchema,
  firstByteMs: z.number().int().nonnegative().nullable(),
  testedModel: z.string().max(500),
  diagnosticId: z.string().uuid(),
})

export type EndpointCapabilityProfile = z.infer<
  typeof endpointCapabilityProfileSchema
>

export const capabilityCheckRequestSchema = z
  .object({
    model: z.string().trim().min(1).max(500).optional(),
  })
  .strict()

export type CapabilityCheckRequest = z.infer<
  typeof capabilityCheckRequestSchema
>
