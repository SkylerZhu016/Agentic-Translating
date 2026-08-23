import type Database from 'better-sqlite3'
import type { ConfigSnapshot } from '../contracts/types'
import type { ChatCompletionRequest } from '../llm/client'
import type { LLMCaller } from '../orchestration/fanout'
import type {
  AgentDirectionVariant,
  ConfigSnapshotVNext,
  ModelBinding,
  SessionPreflightAssumption,
  SessionPreflightFailure,
  SessionPreflightSnapshot,
  SessionPreflightStageEstimate,
} from '../contracts/vnext'
import { estimateTokens } from '../guards/tokens'
import {
  isOrdinarySnapshotObject,
  withoutSnapshotCredentials,
} from './runtime-endpoint-credentials'

export const SESSION_PREFLIGHT_DEFAULTS = Object.freeze({
  version: 'session_preflight_defaults_v2' as const,
  contextWindowTokens: 65_536,
  maxOutputTokens: 4_096,
  minimumOutputTokens: 1_024,
  minimumSafetyMarginTokens: 1_024,
  proportionalSafetyMargin: 0.03,
  promptEnvelopeTokens: 256,
  candidateEvidenceTokens: 384,
  chatLoopMaxRounds: 5,
  toolEnabledMainMaxRounds: 6,
  childReviewMaxCallsPerStage: 2,
  toolResultEnvelopeTokens: 512,
})

export interface RunSessionPreflightInput {
  sourceText: string
  taskBrief?: string
  projectContextTokens?: number
  snapshot: ConfigSnapshotVNext
}

export interface StoredPreflightSession {
  id: string
  source_text: string
  task_brief?: string
  config_snapshot: string
}

export interface SessionPreflightDto {
  status: SessionPreflightSnapshot['status']
  summary: {
    branch: SessionPreflightSnapshot['branch']
    reviewMode: SessionPreflightSnapshot['reviewMode']
    sourceTokens: number
    taskBriefTokens: number
    projectContextTokens: number
    candidateCountWorstCase: number
    estimatedTotalCallTokens: number
  }
  assumptions: Array<SessionPreflightAssumption & { messageKey: string }>
  stages: SessionPreflightStageEstimate[]
  failures: Array<SessionPreflightFailure & { messageKey: string }>
}

export interface PaidChatPreflightInput {
  endpointId: number
  model: string
  contextWindow: number | null
  messages: Array<{ role: string; content: string }>
  tools?: unknown
}

export interface PhysicalPaidCallPreflightInput {
  stage: string
  bindingRole: string
  endpointId: number | null
  model: string
  contextWindow: number | null
  /** Frozen binding/snapshot output cap. A conservative default is used when absent. */
  maxOutputTokens?: number | null
  messages: Array<{ role: string; content: string }>
  tools?: unknown
  /** One-based physical-call attempt number within the logical operation. */
  attempted?: number
  /** Optional already-accounted transcript reserve supplied by a caller/model. */
  transcriptGrowthTokens?: number
}

export interface PhysicalPaidCallPreflightResult {
  attempted: number
  outputLimit: number
  estimate: SessionPreflightStageEstimate
  assumptions: SessionPreflightAssumption[]
}

export interface PhysicalPaidCallIdentity
  extends Omit<
    PhysicalPaidCallPreflightInput,
    'messages' | 'tools' | 'attempted'
  > {
  /** Stable logical identity used to count physical retries independently. */
  attemptKey: string
}

export type PhysicalPaidCallIdentityResolver = (
  endpoint: Parameters<LLMCaller>[0],
  request: ChatCompletionRequest,
) => PhysicalPaidCallIdentity

const ACTIONS = [
  'configure_context_window_and_output_limit',
  'choose_model_with_larger_context_window',
  'reduce_optional_project_context_or_candidate_count',
] as const

function uniqueAssumptions(items: SessionPreflightAssumption[]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.code}:${item.bindingRole}:${item.endpointId}:${item.value}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function likelyPoetry(input: RunSessionPreflightInput): boolean {
  if (input.snapshot.constraints?.poetryMode === 'off') return false
  if (input.snapshot.constraints?.poetryMode === 'on') return true
  const combined = `${input.taskBrief ?? ''}\n${input.sourceText}`
  if (/诗|词|曲|韵|格律|poem|poetry|verse|rhyme|meter/i.test(combined)) {
    return true
  }
  return input.sourceText.split(/\r?\n/).filter((line) => line.trim()).length >= 4
}

function endpointFor(snapshot: ConfigSnapshotVNext, endpointId: number | null) {
  return snapshot.endpointSnapshots.find((endpoint) => endpoint.id === endpointId)
}

function resolveLimits(
  snapshot: ConfigSnapshotVNext,
  binding: ModelBinding,
  bindingRole: string,
  assumptions: SessionPreflightAssumption[],
) {
  const endpoint = endpointFor(snapshot, binding.endpointId)
  const explicitContext = binding.contextWindow ?? endpoint?.contextWindow ?? null
  const contextWindowTokens =
    explicitContext ?? SESSION_PREFLIGHT_DEFAULTS.contextWindowTokens
  if (explicitContext == null) {
    assumptions.push({
      code: 'context_window_defaulted',
      bindingRole,
      endpointId: binding.endpointId,
      value: contextWindowTokens,
    })
  }
  const explicitOutput = binding.maxOutputTokens ?? null
  const reservedOutputTokens = explicitOutput == null
    ? SESSION_PREFLIGHT_DEFAULTS.maxOutputTokens
    : Math.max(1, Math.floor(explicitOutput))
  if (explicitOutput == null) {
    assumptions.push({
      code: 'max_output_tokens_defaulted',
      bindingRole,
      endpointId: binding.endpointId,
      value: reservedOutputTokens,
    })
  }
  return {
    endpointExists: Boolean(endpoint),
    contextWindowTokens,
    reservedOutputTokens,
    safetyMarginTokens: Math.max(
      SESSION_PREFLIGHT_DEFAULTS.minimumSafetyMarginTokens,
      Math.ceil(
        contextWindowTokens *
          SESSION_PREFLIGHT_DEFAULTS.proportionalSafetyMargin,
      ),
    ),
  }
}

function variantBinding(
  snapshot: ConfigSnapshotVNext,
  variant: AgentDirectionVariant,
): ModelBinding {
  const override =
    snapshot.presetRevisionSnapshot?.contract.agentBindingOverrides?.[variant.id]
  const fallback = snapshot.modelBindings.defaultWorker
  return {
    endpointId:
      override?.endpointId ?? variant.endpointOverrideId ?? fallback.endpointId,
    model: override?.model || variant.modelOverride || fallback.model,
    contextWindow: override?.contextWindow ?? fallback.contextWindow ?? null,
    maxOutputTokens:
      override?.maxOutputTokens ?? fallback.maxOutputTokens ?? null,
  }
}

function addEstimate(
  stages: SessionPreflightStageEstimate[],
  failures: SessionPreflightFailure[],
  assumptions: SessionPreflightAssumption[],
  snapshot: ConfigSnapshotVNext,
  params: {
    stage: string
    bindingRole: string
    binding: ModelBinding | undefined
    callsWorstCase: number
    estimatedInputTokens: number
    estimatedInputTokensByCall?: number[]
    transcriptGrowthTokensPerRound?: number
  },
) {
  const binding = params.binding
  if (!binding?.model || binding.endpointId == null) {
    failures.push({
      code: 'preflight_binding_missing',
      stage: params.stage,
      bindingRole: params.bindingRole,
      endpointId: binding?.endpointId ?? null,
      model: binding?.model ?? '',
      params: { callsWorstCase: params.callsWorstCase },
      actions: ['configure_required_stage_model_binding'],
    })
    return
  }
  const limits = resolveLimits(snapshot, binding, params.bindingRole, assumptions)
  if (!limits.endpointExists) {
    failures.push({
      code: 'preflight_binding_missing',
      stage: params.stage,
      bindingRole: params.bindingRole,
      endpointId: binding.endpointId,
      model: binding.model,
      params: { callsWorstCase: params.callsWorstCase },
      actions: ['repair_missing_endpoint_binding'],
    })
    return
  }
  const totalReservedTokens =
    params.estimatedInputTokens +
    limits.reservedOutputTokens +
    limits.safetyMarginTokens
  const estimate: SessionPreflightStageEstimate = {
    stage: params.stage,
    bindingRole: params.bindingRole,
    endpointId: binding.endpointId,
    model: binding.model,
    callsWorstCase: params.callsWorstCase,
    ...(params.estimatedInputTokensByCall
      ? { estimatedInputTokensByCall: params.estimatedInputTokensByCall }
      : {}),
    ...(params.transcriptGrowthTokensPerRound != null
      ? { transcriptGrowthTokensPerRound: params.transcriptGrowthTokensPerRound }
      : {}),
    estimatedInputTokens: params.estimatedInputTokens,
    reservedOutputTokens: limits.reservedOutputTokens,
    safetyMarginTokens: limits.safetyMarginTokens,
    contextWindowTokens: limits.contextWindowTokens,
    totalReservedTokens,
    fits: totalReservedTokens <= limits.contextWindowTokens,
  }
  stages.push(estimate)
  if (!estimate.fits) {
    failures.push({
      code: 'preflight_context_exceeded',
      stage: params.stage,
      bindingRole: params.bindingRole,
      endpointId: binding.endpointId,
      model: binding.model,
      params: {
        estimatedInputTokens: estimate.estimatedInputTokens,
        reservedOutputTokens: estimate.reservedOutputTokens,
        safetyMarginTokens: estimate.safetyMarginTokens,
        contextWindowTokens: estimate.contextWindowTokens,
        excessTokens: totalReservedTokens - estimate.contextWindowTokens,
      },
      actions: [...ACTIONS],
    })
  }
}

function outputFor(
  _snapshot: ConfigSnapshotVNext,
  binding: ModelBinding | undefined,
): number {
  if (!binding) return SESSION_PREFLIGHT_DEFAULTS.maxOutputTokens
  return binding.maxOutputTokens == null
    ? SESSION_PREFLIGHT_DEFAULTS.maxOutputTokens
    : Math.max(1, Math.floor(binding.maxOutputTokens))
}

function toolDefinitionTokens(tools: unknown): number {
  if (tools == null) return 0
  try {
    return estimateTokens(JSON.stringify(tools))
  } catch {
    // Unknown/cyclic tool definitions cannot be silently treated as empty.
    return SESSION_PREFLIGHT_DEFAULTS.contextWindowTokens
  }
}

function hasToolDefinitions(tools: unknown): boolean {
  return Array.isArray(tools) && tools.length > 0
}

function exposesTool(tools: unknown, name: string): boolean {
  if (!Array.isArray(tools)) return false
  return tools.some((tool) => {
    if (!tool || typeof tool !== 'object') return false
    const candidate = tool as { function?: { name?: unknown } }
    return candidate.function?.name === name
  })
}

function boundedLoopInputEstimates(
  initialInputTokens: number,
  transcriptGrowthTokensPerRound: number,
  rounds: number,
): number[] {
  return Array.from(
    { length: rounds },
    (_, index) => initialInputTokens + index * transcriptGrowthTokensPerRound,
  )
}

/**
 * Privacy-safe paid-call gate for the exact messages and tools about to be sent.
 * It is deliberately independent of persistence so every retry/loop iteration
 * can assert its current, transcript-grown request immediately before I/O.
 */
export function assertPhysicalPaidCallPreflight(
  input: PhysicalPaidCallPreflightInput,
): PhysicalPaidCallPreflightResult {
  const attempted = Math.max(1, Math.floor(input.attempted ?? 1))
  const assumptions: SessionPreflightAssumption[] = []
  const contextWindowTokens = input.contextWindow == null
    ? SESSION_PREFLIGHT_DEFAULTS.contextWindowTokens
    : Math.max(1, Math.floor(input.contextWindow))
  const outputLimit = input.maxOutputTokens == null
    ? SESSION_PREFLIGHT_DEFAULTS.maxOutputTokens
    : Math.max(1, Math.floor(input.maxOutputTokens))
  if (input.contextWindow == null) {
    assumptions.push({
      code: 'context_window_defaulted',
      bindingRole: input.bindingRole,
      endpointId: input.endpointId,
      value: contextWindowTokens,
    })
  }
  if (input.maxOutputTokens == null) {
    assumptions.push({
      code: 'max_output_tokens_defaulted',
      bindingRole: input.bindingRole,
      endpointId: input.endpointId,
      value: outputLimit,
    })
  }
  const estimatedInputTokens =
    estimateTokens(input.messages.map((message) => message.content).join('\n')) +
    toolDefinitionTokens(input.tools) +
    Math.max(0, Math.floor(input.transcriptGrowthTokens ?? 0)) +
    SESSION_PREFLIGHT_DEFAULTS.promptEnvelopeTokens
  const safetyMarginTokens = Math.max(
    SESSION_PREFLIGHT_DEFAULTS.minimumSafetyMarginTokens,
    Math.ceil(
      contextWindowTokens * SESSION_PREFLIGHT_DEFAULTS.proportionalSafetyMargin,
    ),
  )
  const totalReservedTokens =
    estimatedInputTokens + outputLimit + safetyMarginTokens
  const estimate: SessionPreflightStageEstimate = {
    stage: input.stage,
    bindingRole: input.bindingRole,
    endpointId: input.endpointId,
    model: input.model,
    callsWorstCase: 1,
    estimatedInputTokens,
    reservedOutputTokens: outputLimit,
    safetyMarginTokens,
    contextWindowTokens,
    totalReservedTokens,
    fits: totalReservedTokens <= contextWindowTokens,
  }
  if (!estimate.fits) {
    const failure: SessionPreflightFailure = {
      code: 'preflight_context_exceeded',
      stage: input.stage,
      bindingRole: input.bindingRole,
      endpointId: input.endpointId,
      model: input.model,
      params: {
        attempted,
        estimatedInputTokens,
        reservedOutputTokens: outputLimit,
        safetyMarginTokens,
        contextWindowTokens,
        excessTokens: totalReservedTokens - contextWindowTokens,
      },
      actions: [...ACTIONS],
    }
    throw new SessionPreflightError({
      version: 1,
      estimator: 'cjk_1_other_chars_div_4_v1',
      defaultsVersion: SESSION_PREFLIGHT_DEFAULTS.version,
      status: 'blocked',
      branch: 'fixed',
      reviewMode: 'main_editor',
      sourceTokens: 0,
      taskBriefTokens: 0,
      projectContextTokens: 0,
      candidateCountWorstCase: 0,
      stages: [estimate],
      assumptions,
      failures: [failure],
      estimatedTotalCallTokens: totalReservedTokens,
    })
  }
  return { attempted, outputLimit, estimate, assumptions }
}

/**
 * Wrap an LLM caller so every physical attempt, including automatic retries,
 * is gated against the exact request immediately before provider I/O.
 */
export function createPreflightedLlmCaller(
  provider: LLMCaller,
  resolveIdentity: PhysicalPaidCallIdentityResolver,
): LLMCaller {
  const attemptedByKey = new Map<string, number>()
  return async (endpoint, request) => {
    const identity = resolveIdentity(endpoint, request)
    const attempted = (attemptedByKey.get(identity.attemptKey) ?? 0) + 1
    attemptedByKey.set(identity.attemptKey, attempted)
    const { attemptKey: _attemptKey, ...preflight } = identity
    assertPhysicalPaidCallPreflight({
      ...preflight,
      maxOutputTokens: request.maxTokens ?? preflight.maxOutputTokens,
      messages: request.messages,
      tools: request.tools,
      attempted,
    })
    return provider(endpoint, request)
  }
}

/**
 * Pure, deterministic worst-case budget calculation for a vNext session.
 * It never mutates or truncates source text and never reads endpoint secrets.
 */
export function runSessionPreflight(
  input: RunSessionPreflightInput,
): SessionPreflightSnapshot {
  const snapshot = input.snapshot
  const assumptions: SessionPreflightAssumption[] = []
  const failures: SessionPreflightFailure[] = []
  const stages: SessionPreflightStageEstimate[] = []
  const sourceTokens = estimateTokens(input.sourceText)
  const taskBriefTokens = estimateTokens(input.taskBrief ?? '')
  const projectContextTokens = Math.max(0, input.projectContextTokens ?? 0)
  const envelope = SESSION_PREFLIGHT_DEFAULTS.promptEnvelopeTokens
  const commonInput = sourceTokens + taskBriefTokens + projectContextTokens + envelope
  const branch = snapshot.orchestrationPolicy.teamPolicy
  const reviewMode = snapshot.orchestrationPolicy.reviewMode
  const mainEditorRunMode =
    snapshot.orchestrationPolicy.mainEditorRunMode ?? 'fixed_pipeline'
  const eligible = snapshot.agentVariantSnapshots.filter(
    (variant) => variant.enabled && variant.archetypeId !== 'cultural-context',
  )
  const fixedIds =
    snapshot.presetRevisionSnapshot?.contract.agentVariantIds ?? []
  const fixedVariants = fixedIds
    .map((id) => eligible.find((variant) => variant.id === id))
    .filter((variant): variant is AgentDirectionVariant => Boolean(variant))
    .slice(0, 4)
  const usesDynamicSelection = branch === 'dynamic' || fixedVariants.length < 2
  const possibleWorkers =
    usesDynamicSelection ? eligible : fixedVariants
  const candidateCountWorstCase = Math.max(
    2,
    Math.min(4, snapshot.orchestrationPolicy.maxAgentCalls, possibleWorkers.length),
  )
  assumptions.push({
    code: 'candidate_output_reserved',
    bindingRole: 'worker',
    endpointId: null,
    value: candidateCountWorstCase,
  })
  if (possibleWorkers.length < 2) {
    failures.push({
      code: 'preflight_binding_missing',
      stage: 'candidate_generation',
      bindingRole: 'worker',
      endpointId: null,
      model: '',
      params: {
        configuredCandidateVariants: possibleWorkers.length,
        requiredCandidateVariants: 2,
      },
      actions: ['configure_at_least_two_candidate_agent_variants'],
    })
  }
  if (usesDynamicSelection) {
    assumptions.push({
      code: 'dynamic_team_all_variants_checked',
      bindingRole: 'worker',
      endpointId: null,
      value: possibleWorkers.length,
    })
  }

  const culturalVariant = snapshot.agentVariantSnapshots.find(
    (variant) => variant.enabled && variant.archetypeId === 'cultural-context',
  )
  const configuredContextBindings =
    snapshot.presetRevisionSnapshot?.contract.contextAnalysisBindings?.slice(0, 2)
  const fallbackContextBindings = [
    snapshot.modelBindings.defaultWorker,
    snapshot.modelBindings.reviewAgent,
    snapshot.modelBindings.mainAgent,
    snapshot.modelBindings.editingAgent,
  ].filter((binding, index, all): binding is ModelBinding =>
    Boolean(binding?.model && binding.endpointId != null) &&
    all.findIndex((item) => item?.model === binding?.model) === index,
  ).slice(0, 2)
  const contextBindings = culturalVariant
    ? configuredContextBindings?.length
      ? configuredContextBindings
      : fallbackContextBindings
    : []
  const culturalPromptTokens = estimateTokens(culturalVariant?.rolePrompt ?? '')
  contextBindings.forEach((binding, index) => {
    addEstimate(stages, failures, assumptions, snapshot, {
      stage: `context_analysis_${index + 1}`,
      bindingRole: `contextAnalysis.${index + 1}`,
      binding,
      callsWorstCase: 1,
      estimatedInputTokens: commonInput + culturalPromptTokens + envelope,
    })
  })
  const contextOutputTokens = contextBindings.reduce(
    (sum, binding) => sum + outputFor(snapshot, binding),
    0,
  )

  const bundle = snapshot.promptBundleSnapshot
  const toolDescriptionTokens = estimateTokens(
    JSON.stringify(bundle.toolDescriptions ?? {}),
  )
  const directoryTokens = estimateTokens(
    snapshot.agentVariantSnapshots
      .map((variant) => `${variant.id}:${variant.catalogName}:${variant.catalogDescription}`)
      .join('\n'),
  )
  if (usesDynamicSelection) {
    addEstimate(stages, failures, assumptions, snapshot, {
      stage: 'team_selection',
      bindingRole: 'mainAgent',
      binding: snapshot.modelBindings.mainAgent,
      callsWorstCase: 1,
      estimatedInputTokens:
        commonInput +
        contextOutputTokens +
        estimateTokens(bundle.mainAgentSystemPrompt) +
        directoryTokens +
        toolDescriptionTokens +
        envelope,
    })
  }

  const poetryEnabled =
    likelyPoetry(input) &&
    possibleWorkers.some((variant) => variant.archetypeId === 'poetry-form')
  const poetryOutputTokens = poetryEnabled
    ? outputFor(snapshot, snapshot.modelBindings.mainAgent)
    : 0
  if (poetryEnabled) {
    addEstimate(stages, failures, assumptions, snapshot, {
      stage: 'poetry_planning',
      bindingRole: 'mainAgent',
      binding: snapshot.modelBindings.mainAgent,
      callsWorstCase: 1,
      estimatedInputTokens: commonInput + sourceTokens + 2 * envelope,
    })
  }

  const maxWorkerPromptTokens = possibleWorkers.reduce(
    (max, variant) => Math.max(max, estimateTokens(variant.rolePrompt)),
    0,
  )
  const workerInputTokens =
    commonInput +
    contextOutputTokens +
    poetryOutputTokens +
    estimateTokens(bundle.workerBasePrompt) +
    maxWorkerPromptTokens +
    envelope
  const checkedWorkerKeys = new Set<string>()
  for (const variant of possibleWorkers) {
    const binding = variantBinding(snapshot, variant)
    const key = `${binding.endpointId}:${binding.model}:${binding.contextWindow ?? ''}:${binding.maxOutputTokens ?? ''}`
    if (checkedWorkerKeys.has(key)) continue
    checkedWorkerKeys.add(key)
    addEstimate(stages, failures, assumptions, snapshot, {
      stage: 'candidate_generation',
      bindingRole: `worker:${variant.id}`,
      binding,
      callsWorstCase: candidateCountWorstCase,
      estimatedInputTokens: workerInputTokens,
    })
  }

  const workerOutputTokens = possibleWorkers.reduce<number>(
    (max, variant) => Math.max(max, outputFor(snapshot, variantBinding(snapshot, variant))),
    SESSION_PREFLIGHT_DEFAULTS.maxOutputTokens,
  )
  const candidateContextTokens = candidateCountWorstCase *
    (
      workerOutputTokens +
      Math.max(
        SESSION_PREFLIGHT_DEFAULTS.candidateEvidenceTokens,
        workerOutputTokens,
      )
    )
  const deliberationBase =
    commonInput + contextOutputTokens + poetryOutputTokens + candidateContextTokens

  if (reviewMode === 'main_editor') {
    const mainInputTokens =
      deliberationBase +
      estimateTokens(bundle.mainAgentSystemPrompt) +
      toolDescriptionTokens +
      2 * envelope
    const mainOutputTokens = outputFor(snapshot, snapshot.modelBindings.mainAgent)
    const mainToolTranscriptGrowth =
      mainOutputTokens +
      Math.max(workerOutputTokens, sourceTokens) +
      SESSION_PREFLIGHT_DEFAULTS.toolResultEnvelopeTokens
    const mainCallInputs = mainEditorRunMode === 'tool_enabled'
      ? boundedLoopInputEstimates(
          mainInputTokens,
          mainToolTranscriptGrowth,
          SESSION_PREFLIGHT_DEFAULTS.toolEnabledMainMaxRounds,
        )
      : [mainInputTokens]
    if (mainEditorRunMode === 'tool_enabled') {
      assumptions.push(
        {
          code: 'bounded_tool_loop_reserved',
          bindingRole: 'mainAgent',
          endpointId: snapshot.modelBindings.mainAgent.endpointId,
          value: SESSION_PREFLIGHT_DEFAULTS.toolEnabledMainMaxRounds,
        },
        {
          code: 'tool_transcript_growth_reserved',
          bindingRole: 'mainAgent',
          endpointId: snapshot.modelBindings.mainAgent.endpointId,
          value: mainToolTranscriptGrowth,
        },
        {
          code: 'child_review_calls_reserved',
          bindingRole: 'reviewAgent',
          endpointId:
            (snapshot.modelBindings.reviewAgent ?? snapshot.modelBindings.mainAgent)
              .endpointId,
          value: SESSION_PREFLIGHT_DEFAULTS.childReviewMaxCallsPerStage,
        },
      )
    }
    addEstimate(stages, failures, assumptions, snapshot, {
      stage: 'main_draft',
      bindingRole: 'mainAgent',
      binding: snapshot.modelBindings.mainAgent,
      callsWorstCase: mainCallInputs.length,
      estimatedInputTokens: Math.max(...mainCallInputs),
      ...(mainCallInputs.length > 1
        ? {
            estimatedInputTokensByCall: mainCallInputs,
            transcriptGrowthTokensPerRound: mainToolTranscriptGrowth,
          }
        : {}),
    })
    if (mainEditorRunMode === 'tool_enabled') {
      const childBinding =
        snapshot.modelBindings.reviewAgent ?? snapshot.modelBindings.mainAgent
      addEstimate(stages, failures, assumptions, snapshot, {
        stage: 'main_draft_child_review',
        bindingRole: snapshot.modelBindings.reviewAgent
          ? 'reviewAgent'
          : 'mainAgent',
        binding: childBinding,
        callsWorstCase:
          SESSION_PREFLIGHT_DEFAULTS.childReviewMaxCallsPerStage,
        estimatedInputTokens:
          commonInput +
          candidateContextTokens +
          mainOutputTokens +
          outputFor(snapshot, childBinding) +
          2 * envelope,
      })
    }
  } else {
    const reviewOutput = outputFor(snapshot, snapshot.modelBindings.reviewAgent)
    const filterOutput = outputFor(snapshot, snapshot.modelBindings.filterAgent)
    const orchestrateOutput = outputFor(
      snapshot,
      snapshot.modelBindings.orchestrateAgent,
    )
    const stagesInOrder = [
      {
        stage: 'review',
        role: 'reviewAgent',
        binding: snapshot.modelBindings.reviewAgent,
        prompt: bundle.reviewPrompt,
        calls: 3,
        prior: 0,
      },
      {
        stage: 'filter',
        role: 'filterAgent',
        binding: snapshot.modelBindings.filterAgent,
        prompt: bundle.filterPrompt,
        calls: 1,
        prior: reviewOutput * 3,
      },
      {
        stage: 'orchestrate',
        role: 'orchestrateAgent',
        binding: snapshot.modelBindings.orchestrateAgent,
        prompt: bundle.orchestratePrompt,
        calls: 1,
        prior: reviewOutput * 3 + filterOutput,
      },
      {
        stage: 'assemble',
        role: 'assembleAgent',
        binding: snapshot.modelBindings.assembleAgent,
        prompt: bundle.assemblePrompt,
        calls: 1,
        prior: reviewOutput * 3 + filterOutput + orchestrateOutput,
      },
    ] as const
    for (const stage of stagesInOrder) {
      addEstimate(stages, failures, assumptions, snapshot, {
        stage: stage.stage,
        bindingRole: stage.role,
        binding: stage.binding,
        callsWorstCase: stage.calls,
        estimatedInputTokens:
          deliberationBase + stage.prior + estimateTokens(stage.prompt) + envelope,
      })
    }
  }

  const nonCandidateCallTokens = stages
    .filter((stage) => stage.stage !== 'candidate_generation')
    .reduce((sum, stage) => {
      if (!stage.estimatedInputTokensByCall?.length) {
        return sum + stage.callsWorstCase * stage.totalReservedTokens
      }
      const perCallFixed =
        stage.reservedOutputTokens + stage.safetyMarginTokens
      return sum + stage.estimatedInputTokensByCall.reduce(
        (stageSum, inputTokens) => stageSum + inputTokens + perCallFixed,
        0,
      )
    }, 0)
  const candidateCallTokens = candidateCountWorstCase * stages
    .filter((stage) => stage.stage === 'candidate_generation')
    .reduce(
      (maximum, stage) => Math.max(maximum, stage.totalReservedTokens),
      0,
    )

  return {
    version: 1,
    estimator: 'cjk_1_other_chars_div_4_v1',
    defaultsVersion: SESSION_PREFLIGHT_DEFAULTS.version,
    status: failures.length === 0 ? 'pass' : 'blocked',
    branch,
    reviewMode,
    mainEditorRunMode,
    sourceTokens,
    taskBriefTokens,
    projectContextTokens,
    candidateCountWorstCase,
    stages,
    assumptions: uniqueAssumptions(assumptions),
    failures,
    estimatedTotalCallTokens: nonCandidateCallTokens + candidateCallTokens,
  }
}

export class SessionPreflightError extends Error {
  readonly code: SessionPreflightFailure['code']
  readonly preflight: SessionPreflightSnapshot
  readonly params: SessionPreflightFailure['params']
  readonly actions: string[]

  constructor(preflight: SessionPreflightSnapshot) {
    const failure = preflight.failures[0]
    super(
      failure?.code === 'preflight_context_exceeded'
        ? `Session preflight blocked ${failure.stage}: reserved token budget exceeds the configured context window.`
        : `Session preflight blocked ${failure?.stage ?? 'unknown'}: a required model binding is unavailable.`,
    )
    this.name = 'SessionPreflightError'
    this.code = failure?.code ?? 'preflight_binding_missing'
    this.preflight = preflight
    this.params = failure?.params ?? {}
    this.actions = failure?.actions ?? ['inspect_preflight_failures']
  }
}

export function assertSessionPreflight(
  preflight: SessionPreflightSnapshot,
): void {
  if (preflight.status === 'blocked') throw new SessionPreflightError(preflight)
}

export class SessionPreflightUpgradeRequiredError extends Error {
  readonly code = 'preflight_snapshot_upgrade_required' as const
  readonly params: Record<string, number | string | null>
  readonly actions = ['create_new_session_with_current_configuration']

  constructor(snapshotVersion: number | null) {
    super('This session predates paid-call preflight and cannot be upgraded safely in place.')
    this.name = 'SessionPreflightUpgradeRequiredError'
    this.params = { snapshotVersion }
  }
}

export class SessionPreflightSnapshotChangedError extends Error {
  readonly code = 'preflight_snapshot_changed' as const
  readonly params: Record<string, never> = {}
  readonly actions = ['retry_session_preflight']

  constructor() {
    super('The frozen session snapshot changed while preflight was being recorded.')
    this.name = 'SessionPreflightSnapshotChangedError'
  }
}

function hasTable(db: Database.Database, table: string): boolean {
  return Boolean(
    db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
    ).get(table),
  )
}

function frozenProjectTokens(
  db: Database.Database,
  sessionId: string,
): number {
  if (!hasTable(db, 'session_project_contexts')) return 0
  const row = db.prepare(
    'SELECT token_estimate FROM session_project_contexts WHERE session_id=?',
  ).get(sessionId) as { token_estimate: number } | undefined
  return Math.max(0, row?.token_estimate ?? 0)
}

function sanitizeStoredSnapshotCredentials(
  db: Database.Database,
  session: StoredPreflightSession,
  parsed: unknown,
): unknown {
  if (!isOrdinarySnapshotObject(parsed)) {
    throw new SessionPreflightUpgradeRequiredError(null)
  }
  let sanitized: unknown
  try {
    sanitized = withoutSnapshotCredentials(parsed)
  } catch {
    throw new SessionPreflightUpgradeRequiredError(null)
  }
  if (JSON.stringify(sanitized) === JSON.stringify(parsed)) return sanitized
  const serialized = JSON.stringify(sanitized)
  const persist = db.transaction(() => db.prepare(
    `UPDATE sessions
     SET config_snapshot=?, updated_at=datetime('now')
     WHERE id=? AND config_snapshot=?`,
  ).run(serialized, session.id, session.config_snapshot))
  if (persist().changes !== 1) {
    throw new SessionPreflightSnapshotChangedError()
  }
  // The same request may subsequently append a v2 compatibility preflight.
  // Keep its compare-and-swap baseline aligned with this logical cleanup.
  session.config_snapshot = serialized
  return sanitized
}

function parseStoredSnapshot(
  db: Database.Database,
  session: StoredPreflightSession,
): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(session.config_snapshot)
  } catch {
    throw new SessionPreflightUpgradeRequiredError(null)
  }
  return sanitizeStoredSnapshotCredentials(db, session, parsed)
}

function legacyChatBindingIsUsable(snapshot: ConfigSnapshot): boolean {
  if (!snapshot.coordinator || !Array.isArray(snapshot.agents)) return false
  if (!snapshot.agents.some((agent) => agent.endpoint_id != null)) return false
  const model = snapshot.coordinator.chat_model || snapshot.coordinator.model
  if (!model) return false
  const endpointId =
    snapshot.coordinator.chat_endpoint_id ?? snapshot.coordinator.endpoint_id
  const endpoints = snapshot.endpoints ?? (snapshot.endpoint ? [snapshot.endpoint] : [])
  const endpoint =
    endpoints.find((candidate) => candidate.id === endpointId) ?? snapshot.endpoint
  return Boolean(endpoint?.id != null && endpoint.base_url)
}

/** Load a chat snapshot without treating a valid legacy v2 snapshot as v3. */
export function loadStoredSessionSnapshotForChat(
  db: Database.Database,
  session: StoredPreflightSession,
): ConfigSnapshot {
  const parsed = parseStoredSnapshot(db, session) as ConfigSnapshot
  if (parsed.version === 3) {
    return ensureStoredSessionPreflight(
      db,
      session,
    ) as unknown as ConfigSnapshot
  }
  if (parsed.version === 2 && legacyChatBindingIsUsable(parsed)) {
    return parsed
  }
  throw new SessionPreflightUpgradeRequiredError(
    typeof parsed.version === 'number' ? parsed.version : null,
  )
}

/**
 * Operation-specific chat gate. Legacy v2 sessions receive a clearly marked
 * compatibility record; v3 retains its full-session preflight unchanged.
 */
export function ensurePaidChatOperationPreflight(
  db: Database.Database,
  session: StoredPreflightSession,
  snapshot: ConfigSnapshot,
  input: PaidChatPreflightInput,
): {
  snapshot: ConfigSnapshot
  outputLimit: number
  operationPreflight: SessionPreflightSnapshot
} {
  const explicitEditingOutput = snapshot.version === 3
    ? snapshot.modelBindings?.editingAgent?.maxOutputTokens ?? null
    : null
  const outputLimit = explicitEditingOutput == null
    ? SESSION_PREFLIGHT_DEFAULTS.maxOutputTokens
    : Math.max(1, Math.floor(explicitEditingOutput))
  const explicitEditingContext = snapshot.version === 3
    ? snapshot.modelBindings?.editingAgent?.contextWindow ?? null
    : null
  const contextWindow =
    explicitEditingContext ?? input.contextWindow ??
    SESSION_PREFLIGHT_DEFAULTS.contextWindowTokens
  const safetyMarginTokens = Math.max(
    SESSION_PREFLIGHT_DEFAULTS.minimumSafetyMarginTokens,
    Math.ceil(
      contextWindow * SESSION_PREFLIGHT_DEFAULTS.proportionalSafetyMargin,
    ),
  )
  const estimatedInputTokens =
    estimateTokens(input.messages.map((message) => message.content).join('\n')) +
    toolDefinitionTokens(input.tools) +
    SESSION_PREFLIGHT_DEFAULTS.promptEnvelopeTokens
  const hasTools = hasToolDefinitions(input.tools)
  const hasChildReview = exposesTool(input.tools, 'request_review')
  const loopRounds = hasTools
    ? SESSION_PREFLIGHT_DEFAULTS.chatLoopMaxRounds
    : 1
  // Output is reserved for the current request already. Subsequent-input
  // growth reserves the bounded tool-result envelope only; the exact current
  // transcript is rechecked before every physical request.
  const transcriptGrowthTokensPerRound = hasTools
    ? SESSION_PREFLIGHT_DEFAULTS.toolResultEnvelopeTokens
    : 0
  const estimatedInputTokensByCall = boundedLoopInputEstimates(
    estimatedInputTokens,
    transcriptGrowthTokensPerRound,
    loopRounds,
  )
  const maximumInputTokens = Math.max(...estimatedInputTokensByCall)
  const totalReservedTokens =
    maximumInputTokens + outputLimit + safetyMarginTokens
  const stage: SessionPreflightStageEstimate = {
    stage: snapshot.version === 2 ? 'legacy_v2_chat' : 'chat_edit',
    bindingRole: 'editingAgent',
    endpointId: input.endpointId,
    model: input.model,
    callsWorstCase: loopRounds,
    ...(hasTools
      ? { estimatedInputTokensByCall, transcriptGrowthTokensPerRound }
      : {}),
    estimatedInputTokens: maximumInputTokens,
    reservedOutputTokens: outputLimit,
    safetyMarginTokens,
    contextWindowTokens: contextWindow,
    totalReservedTokens,
    fits: totalReservedTokens <= contextWindow,
  }
  const childBinding = snapshot.version === 3
    ? snapshot.modelBindings?.reviewAgent ?? snapshot.modelBindings?.editingAgent
    : undefined
  const childBindingRole = snapshot.version === 3 &&
    snapshot.modelBindings?.reviewAgent
    ? 'reviewAgent'
    : 'editingAgent'
  const childEndpoint = snapshot.version === 3
    ? snapshot.endpointSnapshots?.find(
        (endpoint) => endpoint.id === childBinding?.endpointId,
      )
    : undefined
  const childContextWindow =
    childBinding?.contextWindow ?? childEndpoint?.contextWindow ?? contextWindow
  const childOutputLimit = childBinding?.maxOutputTokens == null
    ? outputLimit
    : Math.max(1, Math.floor(childBinding.maxOutputTokens))
  const childSafetyMargin = Math.max(
    SESSION_PREFLIGHT_DEFAULTS.minimumSafetyMarginTokens,
    Math.ceil(
      childContextWindow * SESSION_PREFLIGHT_DEFAULTS.proportionalSafetyMargin,
    ),
  )
  const childInputTokens =
    estimatedInputTokens +
    estimateTokens(session.source_text) +
    outputLimit +
    SESSION_PREFLIGHT_DEFAULTS.toolResultEnvelopeTokens
  const childTotalReservedTokens =
    childInputTokens + childOutputLimit + childSafetyMargin
  const childStage: SessionPreflightStageEstimate = {
    stage: snapshot.version === 2
      ? 'legacy_v2_chat_child_review'
      : 'chat_edit_child_review',
    bindingRole: childBindingRole,
    endpointId: childBinding?.endpointId ?? input.endpointId,
    model: childBinding?.model ?? input.model,
    callsWorstCase: SESSION_PREFLIGHT_DEFAULTS.childReviewMaxCallsPerStage,
    estimatedInputTokens: childInputTokens,
    reservedOutputTokens: childOutputLimit,
    safetyMarginTokens: childSafetyMargin,
    contextWindowTokens: childContextWindow,
    totalReservedTokens: childTotalReservedTokens,
    fits: childTotalReservedTokens <= childContextWindow,
  }
  const failure: SessionPreflightFailure[] = []
  if (!stage.fits) {
    failure.push({
        code: 'preflight_context_exceeded',
        stage: stage.stage,
        bindingRole: stage.bindingRole,
        endpointId: stage.endpointId,
        model: stage.model,
        params: {
          attempted: 0,
          estimatedInputTokens: maximumInputTokens,
          reservedOutputTokens: outputLimit,
          safetyMarginTokens,
          contextWindowTokens: contextWindow,
          excessTokens: totalReservedTokens - contextWindow,
        },
        actions: [...ACTIONS],
      })
  }
  const childBindingUsable = snapshot.version === 2 || Boolean(
    childBinding?.model && childBinding.endpointId != null && childEndpoint,
  )
  if (hasChildReview && !childBindingUsable) {
    failure.push({
      code: 'preflight_binding_missing',
      stage: childStage.stage,
      bindingRole: childStage.bindingRole,
      endpointId: childBinding?.endpointId ?? null,
      model: childBinding?.model ?? '',
      params: {
        attempted: 0,
        callsWorstCase:
          SESSION_PREFLIGHT_DEFAULTS.childReviewMaxCallsPerStage,
      },
      actions: ['configure_required_stage_model_binding'],
    })
  } else if (hasChildReview && !childStage.fits) {
    failure.push({
      code: 'preflight_context_exceeded',
      stage: childStage.stage,
      bindingRole: childStage.bindingRole,
      endpointId: childStage.endpointId,
      model: childStage.model,
      params: {
        attempted: 0,
        estimatedInputTokens: childInputTokens,
        reservedOutputTokens: childOutputLimit,
        safetyMarginTokens: childSafetyMargin,
        contextWindowTokens: childContextWindow,
        excessTokens: childTotalReservedTokens - childContextWindow,
      },
      actions: [...ACTIONS],
    })
  }
  const operationPreflight: SessionPreflightSnapshot = {
    version: 1,
    estimator: 'cjk_1_other_chars_div_4_v1',
    defaultsVersion: SESSION_PREFLIGHT_DEFAULTS.version,
    status: failure.length === 0 ? 'pass' : 'blocked',
    branch: 'fixed',
    reviewMode: 'main_editor',
    sourceTokens: estimateTokens(session.source_text),
    taskBriefTokens: estimateTokens(session.task_brief ?? ''),
    projectContextTokens: 0,
    candidateCountWorstCase: 0,
    stages: [stage, ...(hasChildReview ? [childStage] : [])],
    assumptions: [
      ...(snapshot.version === 2
        ? [{
            code: 'legacy_v2_chat_compatibility' as const,
            bindingRole: 'editingAgent',
            endpointId: input.endpointId,
            value: 1,
          }]
        : []),
      ...(explicitEditingContext == null && input.contextWindow == null
        ? [{
            code: 'context_window_defaulted' as const,
            bindingRole: 'editingAgent',
            endpointId: input.endpointId,
            value: contextWindow,
          }]
        : []),
      ...(explicitEditingOutput == null
        ? [{
            code: 'max_output_tokens_defaulted' as const,
            bindingRole: 'editingAgent',
            endpointId: input.endpointId,
            value: outputLimit,
          }]
        : []),
      ...(hasTools
        ? [{
            code: 'bounded_tool_loop_reserved' as const,
            bindingRole: 'editingAgent',
            endpointId: input.endpointId,
            value: loopRounds,
          }, {
            code: 'tool_transcript_growth_reserved' as const,
            bindingRole: 'editingAgent',
            endpointId: input.endpointId,
            value: transcriptGrowthTokensPerRound,
          }]
        : []),
      ...(hasChildReview
        ? [{
            code: 'child_review_calls_reserved' as const,
            bindingRole: childStage.bindingRole,
            endpointId: childStage.endpointId,
            value: SESSION_PREFLIGHT_DEFAULTS.childReviewMaxCallsPerStage,
          }]
        : []),
    ],
    failures: failure,
    estimatedTotalCallTokens:
      estimatedInputTokensByCall.reduce(
        (sum, callInput) =>
          sum + callInput + outputLimit + safetyMarginTokens,
        0,
      ) +
      (hasChildReview
        ? SESSION_PREFLIGHT_DEFAULTS.childReviewMaxCallsPerStage *
          childTotalReservedTokens
        : 0),
    ...(snapshot.version === 2
      ? { compatibility: { kind: 'legacy_v2_chat' as const, version: 1 as const } }
      : {}),
  }

  if (snapshot.version === 2) {
    const withPreflight = withoutSnapshotCredentials({
      ...snapshot,
      preflight: operationPreflight,
    }) as ConfigSnapshot
    const persist = db.transaction(() =>
      db.prepare(
        `UPDATE sessions
         SET config_snapshot=?, updated_at=datetime('now')
         WHERE id=? AND config_snapshot=?`,
      ).run(
        JSON.stringify(withPreflight),
        session.id,
        session.config_snapshot,
      ),
    )
    if (persist().changes !== 1) {
      throw new SessionPreflightSnapshotChangedError()
    }
    assertSessionPreflight(operationPreflight)
    return { snapshot: withPreflight, outputLimit, operationPreflight }
  }

  assertSessionPreflight(operationPreflight)
  return { snapshot, outputLimit, operationPreflight }
}

/**
 * Paid-call gate for an already persisted session. Missing preflight on a v3
 * snapshot is safely recomputed from frozen configuration and project context.
 * Older snapshots return a stable upgrade error instead of making a call.
 */
export function ensureStoredSessionPreflight(
  db: Database.Database,
  session: StoredPreflightSession,
  snapshotOverride?: ConfigSnapshotVNext,
): ConfigSnapshotVNext {
  let parsed: unknown
  try {
    parsed = snapshotOverride ?? JSON.parse(session.config_snapshot)
  } catch {
    throw new SessionPreflightUpgradeRequiredError(null)
  }
  if (!snapshotOverride) {
    parsed = sanitizeStoredSnapshotCredentials(db, session, parsed)
  } else {
    parsed = withoutSnapshotCredentials(parsed)
  }
  const snapshot = parsed as Partial<ConfigSnapshotVNext>
  if (
    snapshot.version !== 3 ||
    !snapshot.promptBundleSnapshot ||
    !snapshot.modelBindings ||
    !snapshot.endpointSnapshots ||
    !snapshot.agentVariantSnapshots ||
    !snapshot.orchestrationPolicy
  ) {
    throw new SessionPreflightUpgradeRequiredError(
      typeof snapshot.version === 'number' ? snapshot.version : null,
    )
  }
  const vnext = snapshot as ConfigSnapshotVNext
  if (!snapshotOverride && vnext.preflight?.defaultsVersion === SESSION_PREFLIGHT_DEFAULTS.version) {
    assertSessionPreflight(vnext.preflight)
    return vnext
  }
  const preflight = runSessionPreflight({
    sourceText: session.source_text,
    taskBrief: session.task_brief ?? vnext.taskBrief,
    projectContextTokens: frozenProjectTokens(db, session.id),
    snapshot: vnext,
  })
  const withPreflight = withoutSnapshotCredentials({
    ...vnext,
    preflight,
  }) as unknown as ConfigSnapshotVNext
  if (!snapshotOverride) {
    const persist = db.transaction(() =>
      db.prepare(
        `UPDATE sessions
         SET config_snapshot=?, updated_at=datetime('now')
         WHERE id=? AND config_snapshot=?`,
      ).run(
        JSON.stringify(withPreflight),
        session.id,
        session.config_snapshot,
      ),
    )
    if (persist().changes !== 1) {
      throw new SessionPreflightSnapshotChangedError()
    }
  }
  assertSessionPreflight(preflight)
  return withPreflight
}

export function toSessionPreflightDto(
  preflight: SessionPreflightSnapshot,
): SessionPreflightDto {
  return {
    status: preflight.status,
    summary: {
      branch: preflight.branch,
      reviewMode: preflight.reviewMode,
      sourceTokens: preflight.sourceTokens,
      taskBriefTokens: preflight.taskBriefTokens,
      projectContextTokens: preflight.projectContextTokens,
      candidateCountWorstCase: preflight.candidateCountWorstCase,
      estimatedTotalCallTokens: preflight.estimatedTotalCallTokens,
    },
    assumptions: preflight.assumptions.map((assumption) => ({
      ...assumption,
      messageKey: `preflight.assumption.${assumption.code}`,
    })),
    stages: preflight.stages,
    failures: preflight.failures.map((failure) => ({
      ...failure,
      messageKey: `preflight.failure.${failure.code}`,
    })),
  }
}

export interface PreflightOutputIdentity {
  stage?: string
  bindingRole: string
  endpointId: number | null
  model: string
  fallbackOutputTokens?: number | null
}

export function resolvePreflightOutputLimit(
  preflight: SessionPreflightSnapshot,
  identity: PreflightOutputIdentity,
): number {
  const matching = preflight.stages.filter(
    (stage) =>
      stage.bindingRole === identity.bindingRole &&
      (!identity.stage || stage.stage === identity.stage) &&
      stage.endpointId === identity.endpointId &&
      stage.model === identity.model,
  )
  const caps = [...new Set(
    matching.map((stage) => stage.reservedOutputTokens),
  )]
  if (caps.length === 1) return caps[0]
  return identity.fallbackOutputTokens == null
    ? SESSION_PREFLIGHT_DEFAULTS.maxOutputTokens
    : Math.max(1, Math.floor(identity.fallbackOutputTokens))
}

export function sessionPreflightErrorDto(error: unknown): {
  status: 422
  body: Record<string, unknown>
} | null {
  if (error instanceof SessionPreflightError) {
    return {
      status: 422,
      body: {
        error: error.code,
        message: error.message,
        params: error.params,
        actions: error.actions,
        preflight: toSessionPreflightDto(error.preflight),
      },
    }
  }
  if (error instanceof SessionPreflightUpgradeRequiredError) {
    return {
      status: 422,
      body: {
        error: error.code,
        message: error.message,
        params: error.params,
        actions: error.actions,
      },
    }
  }
  if (error instanceof SessionPreflightSnapshotChangedError) {
    return {
      status: 422,
      body: {
        error: error.code,
        message: error.message,
        params: error.params,
        actions: error.actions,
      },
    }
  }
  return null
}
