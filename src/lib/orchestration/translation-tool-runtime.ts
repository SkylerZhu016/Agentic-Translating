import { randomUUID } from 'crypto'
import { z } from 'zod'
import {
  evidenceMaterialSchema,
  projectMemorySearchResultSchema,
  proposePatchResultSchema,
  recordIssueResultSchema,
  replaceTextResultSchema,
  requestReviewResultSchema,
  translationToolCallSchema,
  translationToolExecutionContextSchema,
  translationToolNameSchema,
  translationToolReferenceIdSchema,
  writeDraftResultSchema,
  type AgentToolCallRecord,
  type EvidenceMaterial,
  type ProjectMemorySearchResult,
  type TranslationToolExecutionContext,
  type TranslationToolName,
} from '../contracts/translation-tools'
import type { TranslationToolRepository } from '../db/translation-tool-repository'
import { applyExactReplacement } from '../editing/replace'
import {
  getTranslationToolEvidenceIds,
  projectEvidenceForInheritance,
  TranslationToolPolicyError,
  validateTranslationToolInvocation,
} from './translation-tools'

type ParsedCall = ReturnType<typeof validateTranslationToolInvocation>['call']
type CallArgs<Name extends TranslationToolName> = Extract<
  ParsedCall,
  { name: Name }
>['args']

export interface TranslationToolRuntimeHandlers {
  inspectEvidence: (
    args: CallArgs<'inspect_evidence'>,
    context: TranslationToolExecutionContext,
  ) => Promise<EvidenceMaterial[]> | EvidenceMaterial[]
  searchProjectMemory: (
    args: CallArgs<'search_project_memory'>,
    context: TranslationToolExecutionContext,
  ) => Promise<ProjectMemorySearchResult> | ProjectMemorySearchResult
  requestReview: (
    args: CallArgs<'request_review'>,
    childContext: TranslationToolExecutionContext,
  ) =>
    | Promise<{ reviewInvocationId: string; evidence: EvidenceMaterial }>
    | { reviewInvocationId: string; evidence: EvidenceMaterial }
  proposePatch?: (
    args: CallArgs<'propose_patch'>,
    context: TranslationToolExecutionContext,
  ) =>
    | Promise<{ proposalId: string; status: 'proposed' }>
    | { proposalId: string; status: 'proposed' }
  writeDraft?: (
    args: CallArgs<'write_draft'>,
    context: TranslationToolExecutionContext,
  ) =>
    | Promise<{ versionId: number; versionNo: number }>
    | { versionId: number; versionNo: number }
  replaceText?: (
    args: CallArgs<'replace_text'>,
    context: TranslationToolExecutionContext,
  ) =>
    | Promise<{ newText: string; diffSummary: string }>
    | { newText: string; diffSummary: string }
}

export interface ExecuteTranslationToolInput {
  id?: string
  providerToolCallId?: string | null
  logicalCallKey?: string | null
  name: string
  args: unknown
  context: unknown
}

export interface ExecuteTranslationToolResult {
  callId: string
  result: unknown
  trace: AgentToolCallRecord
}

export interface ExecuteReplaceTextBatchCall {
  id?: string
  providerToolCallId?: string | null
  logicalCallKey?: string | null
  args: unknown
}

export type ExecuteReplaceTextBatchResult =
  | {
      ok: true
      newText: string
      diffSummary: string
      calls: ExecuteTranslationToolResult[]
    }
  | {
      ok: false
      failedIndex: number
      code: string
      reason: string
      suggestions?: string[]
      traces: AgentToolCallRecord[]
    }

export class TranslationToolRuntimeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly toolCallId: string | null,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'TranslationToolRuntimeError'
  }
}

function runtimeError(error: unknown, callId: string): TranslationToolRuntimeError {
  if (error instanceof TranslationToolRuntimeError) {
    return error.toolCallId === null
      ? new TranslationToolRuntimeError(
          error.code,
          error.message,
          callId,
          error.cause ?? error,
        )
      : error
  }
  if (error instanceof TranslationToolPolicyError) {
    return new TranslationToolRuntimeError(
      error.code,
      error.message,
      callId,
      error,
    )
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new TranslationToolRuntimeError(
      'tool_cancelled',
      'Translation tool execution was cancelled.',
      callId,
      error,
    )
  }
  return new TranslationToolRuntimeError(
    'tool_execution_failed',
    error instanceof Error ? error.message : String(error),
    callId,
    error,
  )
}

function assertExactEvidenceResult(
  requestedIds: string[],
  materials: EvidenceMaterial[],
): void {
  const actualIds = materials.map((item) => item.evidenceId)
  const expected = [...requestedIds].sort()
  const actual = [...actualIds].sort()
  if (
    new Set(actualIds).size !== actualIds.length ||
    JSON.stringify(expected) !== JSON.stringify(actual)
  ) {
    throw new TranslationToolRuntimeError(
      'evidence_result_mismatch',
      'Evidence resolver must return every requested evidence ID exactly once and no additional evidence.',
      null,
    )
  }
}

export function createTranslationToolRuntime(input: {
  repository: TranslationToolRepository
  handlers: TranslationToolRuntimeHandlers
}) {
  const { repository, handlers } = input
  const discoveredEvidenceIds = new Set<string>()

  const execute = async (
    request: ExecuteTranslationToolInput,
  ): Promise<ExecuteTranslationToolResult> => {
    const requestedId = translationToolReferenceIdSchema.safeParse(request.id)
    let callId = requestedId.success ? requestedId.data : randomUUID()
    let context: TranslationToolExecutionContext
    let toolName: TranslationToolName
    try {
      context = translationToolExecutionContextSchema.parse(request.context)
      context = translationToolExecutionContextSchema.parse({
        ...context,
        knownEvidenceIds: context.knownEvidenceIds
          ? [...new Set([...context.knownEvidenceIds, ...discoveredEvidenceIds])]
          : undefined,
      })
      toolName = translationToolNameSchema.parse(request.name)
    } catch (error) {
      throw new TranslationToolRuntimeError(
        'invalid_tool_call',
        error instanceof z.ZodError
          ? z.prettifyError(error)
          : 'Invalid translation tool context.',
        null,
        error,
      )
    }

    const reviewRequestsInStage =
      toolName === 'request_review'
        ? repository.countReviewRequests({
            sessionId: context.sessionId,
            runId: context.runId,
            stage: context.stage,
          })
        : 0

    const prelim = z
      .object({ name: translationToolNameSchema, args: z.unknown() })
      .strict()
      .parse({ name: toolName, args: request.args })
    const parsedCall = translationToolCallSchema.safeParse(prelim)
    let evidenceIds = parsedCall.success
      ? getTranslationToolEvidenceIds(parsedCall.data)
      : []

    let trace = repository.beginCall({
      id: callId,
      sessionId: context.sessionId,
      runId: context.runId,
      invocationId: context.invocationId,
      parentToolCallId: context.parentToolCallId,
      providerToolCallId: request.providerToolCallId,
      logicalCallKey: request.logicalCallKey,
      stage: context.stage,
      actor: context.actor,
      depth: context.depth,
      toolName,
      arguments: request.args,
      evidenceIds,
      providerSeed: context.providerSeed,
      determinismLevel: context.determinismLevel,
    })
    // A run-scoped logical key may resolve to an earlier running or completed
    // record. From this point onward, every transition must target that durable
    // record rather than the caller's newly generated request ID.
    callId = trace.id

    if (trace.status === 'complete') {
      return { callId: trace.id, result: trace.output, trace }
    }
    if (trace.status !== 'running') {
      throw new TranslationToolRuntimeError(
        'idempotent_call_terminal',
        `Logical tool call already ended with ${trace.status}.`,
        trace.id,
      )
    }

    try {
      const validated = validateTranslationToolInvocation({
        call: prelim,
        context,
        reviewRequestsInStage,
      })
      const call = validated.call
      context = validated.context
      evidenceIds = getTranslationToolEvidenceIds(call)
      let result: unknown = null

      switch (call.name) {
        case 'inspect_evidence': {
          const materials = (await handlers.inspectEvidence(
            call.args,
            context,
          )).map((item) => evidenceMaterialSchema.parse(item))
          assertExactEvidenceResult(call.args.evidenceIds, materials)
          result = projectEvidenceForInheritance(
            materials,
            call.args.inheritanceMode,
          )
          break
        }
        case 'search_project_memory': {
          const memoryResult = projectMemorySearchResultSchema.parse(
            await handlers.searchProjectMemory(call.args, context),
          )
          result = memoryResult
          evidenceIds = [
            ...new Set([
              ...evidenceIds,
              ...memoryResult.items.map((item) => item.id),
            ]),
          ]
          memoryResult.items.forEach((item) => discoveredEvidenceIds.add(item.id))
          break
        }
        case 'request_review': {
          const childContext = translationToolExecutionContextSchema.parse({
            ...context,
            invocationId: null,
            parentToolCallId: callId,
            actor: 'review_subagent',
            depth: context.depth + 1,
          })
          const review = await handlers.requestReview(call.args, childContext)
          const material = evidenceMaterialSchema.parse(review.evidence)
          evidenceIds = [...new Set([...evidenceIds, material.evidenceId])]
          discoveredEvidenceIds.add(material.evidenceId)
          const projected = projectEvidenceForInheritance(
            [material],
            context.allowedInheritanceMode,
          )
          result = requestReviewResultSchema.parse({
            reviewInvocationId: review.reviewInvocationId,
            evidence: projected,
          })
          break
        }
        case 'record_issue': {
          const issue = repository.createIssue({
            sessionId: context.sessionId,
            runId: context.runId,
            invocationId: context.invocationId,
            sourceToolCallId: callId,
            stage: context.stage,
            ...call.args,
          })
          result = recordIssueResultSchema.parse({
            issueId: issue.id,
            status: 'open',
          })
          break
        }
        case 'propose_patch':
          result = proposePatchResultSchema.parse(
            handlers.proposePatch
              ? await handlers.proposePatch(call.args, context)
              : { proposalId: callId, status: 'proposed' },
          )
          break
        case 'write_draft':
          if (!handlers.writeDraft) {
            throw new TranslationToolRuntimeError(
              'tool_handler_unavailable',
              'write_draft has no configured runtime handler.',
              callId,
            )
          }
          {
            const committed = repository.runAtomically(() => {
              const handlerResult = handlers.writeDraft!(call.args, context)
              if (
                handlerResult &&
                typeof handlerResult === 'object' &&
                'then' in handlerResult
              ) {
                throw new TranslationToolRuntimeError(
                  'async_atomic_handler_forbidden',
                  'write_draft must use a synchronous atomic persistence handler.',
                  callId,
                )
              }
              const atomicResult = writeDraftResultSchema.parse(handlerResult)
              const atomicTrace = repository.completeCall(callId, {
                result: atomicResult,
                evidenceIds,
              })
              return { result: atomicResult, trace: atomicTrace }
            })
            return { callId, ...committed }
          }
        case 'replace_text':
          if (!handlers.replaceText) {
            throw new TranslationToolRuntimeError(
              'tool_handler_unavailable',
              'replace_text has no configured runtime handler.',
              callId,
            )
          }
          result = replaceTextResultSchema.parse(
            await handlers.replaceText(call.args, context),
          )
          break
      }

      trace = repository.completeCall(callId, { result, evidenceIds })
      return { callId, result, trace }
    } catch (error) {
      const normalized = runtimeError(error, callId)
      const status = normalized.code === 'tool_cancelled' ? 'cancelled' : 'failed'
      const failedTrace = repository.failCall(callId, {
        status,
        errorCode: normalized.code,
        errorMessage: normalized.message,
        evidenceIds,
      })
      throw new TranslationToolRuntimeError(
        normalized.code,
        failedTrace.errorMessage ?? 'Translation tool failed.',
        callId,
        normalized,
      )
    }
  }

  const executeReplaceTextBatch = async (input: {
    calls: ExecuteReplaceTextBatchCall[]
    context: unknown
  }): Promise<ExecuteReplaceTextBatchResult> => {
    let context: TranslationToolExecutionContext
    try {
      context = translationToolExecutionContextSchema.parse(input.context)
    } catch (error) {
      throw new TranslationToolRuntimeError(
        'invalid_tool_call',
        error instanceof z.ZodError
          ? z.prettifyError(error)
          : 'Invalid translation tool context.',
        null,
        error,
      )
    }
    if (input.calls.length === 0) {
      if (!context.baseVersion) {
        throw new TranslationToolRuntimeError(
          'base_version_required',
          'replace_text requires a frozen base version.',
          null,
        )
      }
      return {
        ok: true,
        newText: context.baseVersion.text,
        diffSummary: 'No changes',
        calls: [],
      }
    }

    // Begin every trace before parsing any argument or inspecting the text so
    // rolled_back and not_attempted calls are durable audit outcomes too.
    const traces = repository.runAtomically(() =>
      input.calls.map((request) => {
        const requestedId = translationToolReferenceIdSchema.safeParse(request.id)
        return repository.beginCall({
          id: requestedId.success ? requestedId.data : randomUUID(),
          sessionId: context.sessionId,
          runId: context.runId,
          invocationId: context.invocationId,
          parentToolCallId: context.parentToolCallId,
          providerToolCallId: request.providerToolCallId,
          logicalCallKey: request.logicalCallKey,
          stage: context.stage,
          actor: context.actor,
          depth: context.depth,
          toolName: 'replace_text',
          arguments: request.args,
          evidenceIds: [],
          providerSeed: context.providerSeed,
          determinismLevel: context.determinismLevel,
        })
      }),
    )

    if (traces.every((trace) => trace.status === 'complete')) {
      const calls = traces.map((trace) => ({
        callId: trace.id,
        result: trace.output,
        trace,
      }))
      const replay = replaceTextResultSchema.parse(calls[calls.length - 1].result)
      return {
        ok: true,
        newText: replay.newText,
        diffSummary: replay.diffSummary,
        calls,
      }
    }

    if (!context.baseVersion) {
      const failed = traces.map((trace, index) =>
        trace.status === 'running'
          ? repository.failCall(trace.id, {
              errorCode: index === 0 ? 'base_version_required' : 'not_attempted',
              errorMessage: index === 0
                ? 'replace_text requires a frozen base version.'
                : 'The replacement was not attempted because the frozen base version was unavailable.',
            })
          : trace,
      )
      return {
        ok: false,
        failedIndex: 0,
        code: 'base_version_required',
        reason: 'replace_text requires a frozen base version.',
        traces: failed,
      }
    }

    const terminalIndex = traces.findIndex((trace) => trace.status !== 'running')
    if (terminalIndex >= 0) {
      const terminal = traces[terminalIndex]
      traces.forEach((trace, index) => {
        if (trace.status !== 'running') return
        repository.failCall(trace.id, {
          errorCode: index < terminalIndex ? 'rolled_back' : 'not_attempted',
          errorMessage:
            index < terminalIndex
              ? 'The replacement batch was rolled back because a persisted call was already terminal.'
              : 'The replacement was not attempted because a persisted call was already terminal.',
        })
      })
      return {
        ok: false,
        failedIndex: terminalIndex,
        code: 'idempotent_call_terminal',
        reason: `Logical replacement call already ended with ${terminal.status}.`,
        traces: traces.map((trace) => repository.getCall(trace.id) ?? trace),
      }
    }

    let workingText = context.baseVersion.text
    const parsedCalls: Array<CallArgs<'replace_text'>> = []
    let failure:
      | {
          index: number
          code: string
          reason: string
          suggestions?: string[]
        }
      | undefined

    for (let index = 0; index < input.calls.length; index += 1) {
      const prelim = {
        name: 'replace_text' as const,
        args: input.calls[index].args,
      }
      let parsed: CallArgs<'replace_text'>
      try {
        parsed = validateTranslationToolInvocation({
          call: prelim,
          context: {
            ...context,
            baseVersion: { ...context.baseVersion, text: workingText },
          },
          reviewRequestsInStage: 0,
        }).call.args as CallArgs<'replace_text'>
      } catch (error) {
        const normalized = runtimeError(error, traces[index].id)
        failure = {
          index,
          code: normalized.code === 'tool_execution_failed'
            ? 'invalid_tool_call'
            : normalized.code,
          reason: normalized.message,
        }
        break
      }
      parsedCalls.push(parsed)
      if (parsed.old_string === parsed.new_string) {
        failure = {
          index,
          code: 'replacement_unchanged',
          reason: 'old_string and new_string must differ.',
        }
        break
      }
      const replacement = applyExactReplacement(
        workingText,
        parsed.old_string,
        parsed.new_string,
      )
      if (!replacement.ok) {
        failure = {
          index,
          code: replacement.matchCount && replacement.matchCount > 1
            ? 'patch_target_ambiguous'
            : 'patch_target_not_found',
          reason: replacement.reason,
          suggestions: replacement.suggestions,
        }
        break
      }
      workingText = replacement.newText
    }

    if (failure) {
      traces.forEach((trace, index) => {
        const errorCode = index < failure!.index
          ? 'rolled_back'
          : index === failure!.index
            ? failure!.code
            : 'not_attempted'
        const errorMessage = index < failure!.index
          ? `The replacement batch was rolled back after edit ${failure!.index + 1} failed.`
          : index === failure!.index
            ? failure!.reason
            : `The replacement was not attempted because edit ${failure!.index + 1} failed.`
        repository.failCall(trace.id, { errorCode, errorMessage })
      })
      return {
        ok: false,
        failedIndex: failure.index,
        code: failure.code,
        reason: failure.reason,
        suggestions: failure.suggestions,
        traces: traces.map((trace) => repository.getCall(trace.id)!),
      }
    }

    let intermediate = context.baseVersion.text
    let calls: ExecuteTranslationToolResult[]
    try {
      calls = repository.runAtomically(() =>
        parsedCalls.map((args, index) => {
          const replacement = applyExactReplacement(
            intermediate,
            args.old_string,
            args.new_string,
          )
          if (!replacement.ok) {
            throw new TranslationToolRuntimeError(
              'replacement_replay_failed',
              replacement.reason,
              traces[index].id,
            )
          }
          intermediate = replacement.newText
          const result = replaceTextResultSchema.parse({
            newText: intermediate,
            diffSummary: `replace_text:${args.old_string.length}->${args.new_string.length}`,
          })
          const trace = repository.completeCall(traces[index].id, { result })
          return { callId: trace.id, result, trace }
        }),
      )
    } catch (error) {
      traces.forEach((trace) => {
        const current = repository.getCall(trace.id)
        if (current?.status !== 'running') return
        repository.failCall(trace.id, {
          errorCode: 'batch_completion_failed',
          errorMessage: 'The exact replacement batch could not be committed.',
        })
      })
      throw runtimeError(error, traces[0].id)
    }
    return {
      ok: true,
      newText: workingText,
      diffSummary: parsedCalls.length === 1
        ? `replace_text:${parsedCalls[0].old_string.length}->${parsedCalls[0].new_string.length}`
        : `Applied ${parsedCalls.length} exact replacements.`,
      calls,
    }
  }

  const rejectReplaceTextBatch = (input: {
    calls: ExecuteReplaceTextBatchCall[]
    context: unknown
    reason: string
  }): AgentToolCallRecord[] => {
    const context = translationToolExecutionContextSchema.parse(input.context)
    return repository.runAtomically(() =>
      input.calls.map((request) => {
        const requestedId = translationToolReferenceIdSchema.safeParse(request.id)
        const trace = repository.beginCall({
          id: requestedId.success ? requestedId.data : randomUUID(),
          sessionId: context.sessionId,
          runId: context.runId,
          invocationId: context.invocationId,
          parentToolCallId: context.parentToolCallId,
          providerToolCallId: request.providerToolCallId,
          logicalCallKey: request.logicalCallKey,
          stage: context.stage,
          actor: context.actor,
          depth: context.depth,
          toolName: 'replace_text',
          arguments: request.args,
          evidenceIds: [],
          providerSeed: context.providerSeed,
          determinismLevel: context.determinismLevel,
        })
        if (trace.status !== 'running') return trace
        return repository.failCall(trace.id, {
          errorCode: 'not_attempted',
          errorMessage: input.reason,
        })
      }),
    )
  }

  return { execute, executeReplaceTextBatch, rejectReplaceTextBatch }
}

export type TranslationToolRuntime = ReturnType<
  typeof createTranslationToolRuntime
>
