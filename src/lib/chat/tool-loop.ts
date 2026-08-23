// ---------------------------------------------------------------------------
// Chat Tool Loop — R4 engine: dual-protocol, self-correction, transactional
//
// Wave 2 Task 12 — spec lines 873-930
//
// Provides:
//   runChatTurn(params) → Promise<ChatTurnResult>
//     - Native OpenAI function calling with replace_text tool
//     - JSON fence fallback when endpoint doesn't support tools
//     - Self-correction loop on ambiguous/not_found errors
//     - Transactional batch replacement via applyReplacementBatch
//     - Configurable loop cap via CHAT_LOOP_MAX
// ---------------------------------------------------------------------------

import { isAsyncIterable, ToolsNotSupportedError } from '../llm/client';
import type { ChatCompletionRequest, ChatCompletionResponse, LLMStreamEvent } from '../llm/client';
import { applyExactReplacementBatch, type Edit } from '../editing/replace';
import { CHAT_TOOLS } from './tools';
import { executeProgrammaticTool } from './program-tools';
import { CHAT_LOOP_MAX } from '../constants';
import { resolveCompletionTokenBudget } from '../guards/tokens';
import {
  ledgeredChatCompletion,
  type BestEffortLlmCallContext,
} from '../services/llm-call-ledger';
import type {
  TranslationToolExecutionContext,
} from '../contracts/translation-tools';
import type { TranslationToolRuntime } from '../orchestration/translation-tool-runtime';
import { TRANSLATION_DOMAIN_TOOL_DEFINITIONS } from '../orchestration/translation-tools';

const MAX_EDIT_CORRECTION_ATTEMPTS = 1;

// =============================================================================
// Types
// =============================================================================

/** Callbacks for observing chat turn progress */
export interface ChatCallbacks {
  /** Called when the provider sends activity, including hidden reasoning. */
  onActivity?: () => void;
  /** Called for each text delta during streaming */
  onDelta?: (text: string) => void;
  /** Called when the model invokes a replace_text tool */
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  /** Called with the result of applying tool calls */
  onToolResult?: (ok: boolean, result?: { newText: string; diffSummary: string }) => void;
  /** Called after a translation-domain tool returns or fails. */
  onDomainToolResult?: (
    name: string,
    ok: boolean,
    payload: unknown,
    toolCallId: string,
  ) => void;
  /** Called when falling back from native tools to JSON fence protocol */
  onProtocolFallback?: () => void;
}

/** Parameters for a single chat turn */
export interface RunChatTurnParams {
  endpoint: { baseUrl: string; apiKey: string; chatCompletionsPath?: string };
  model: string;
  messages: Array<{ role: string; content: string; name?: string; tool_call_id?: string }>;
  /** The current full text being edited */
  currentText: string;
  /** Tools exposed to the model (default: safe product CHAT_TOOLS — replace_text only) */
  tools?: ChatCompletionRequest['tools'];
  /** Bound translation-domain runtime. Omit to disable domain tools. */
  domainRuntime?: TranslationToolRuntime;
  /** Frozen execution context shared by domain calls in this chat turn. */
  domainContext?: TranslationToolExecutionContext;
  callbacks?: ChatCallbacks;
  /** Whether to use streaming (default: true) */
  stream?: boolean;
  /** Configured provider context window, when known. */
  contextWindow?: number | null;
  /** Optional explicit completion budget. Defaults to 65,536 tokens. */
  maxTokens?: number;
  /** Cancels every physical provider request made by this chat turn. */
  signal?: AbortSignal;
  /** Privacy-safe accounting identifiers for this session's physical calls. */
  ledger?: Omit<BestEffortLlmCallContext, 'operation' | 'retryCount'>;
  /** Exact-request paid-call gate, invoked immediately before every provider I/O. */
  beforePhysicalCall?: (input: {
    messages: Array<{ role: string; content: string }>;
    tools?: ChatCompletionRequest['tools'];
    maxTokens: number;
    attempted: number;
  }) => void;
}

const DOMAIN_TOOL_NAMES: ReadonlySet<string> = new Set(
  TRANSLATION_DOMAIN_TOOL_DEFINITIONS.map((tool) => tool.function.name),
);
const PROGRAMMING_TOOL_NAMES = new Set([
  'file_read',
  'file_edit',
  'run_command',
]);

/** Result of a chat turn */
export type ChatTurnResult =
  | { ok: true; kind: 'message'; text: string }
  | { ok: true; kind: 'edited'; newText: string; diffSummary: string }
  | { ok: false; code: string; message?: string };

// =============================================================================
// Internal helpers
// =============================================================================

/** Shallow-clone a messages array so we don't mutate the caller's copy */
function cloneMessages(
  msgs: RunChatTurnParams['messages'],
): Array<{ role: string; content: string; name?: string; tool_call_id?: string }> {
  return msgs.map((m) => ({ ...m }));
}

function paidCallPreflightMessages(
  messages: RunChatTurnParams['messages'],
): Array<{ role: string; content: string }> {
  return messages.map((message) => {
    const wireMessage = message as unknown as Record<string, unknown>;
    const toolCalls = wireMessage.tool_calls;
    return {
      role: message.role,
      content:
        message.content +
        (toolCalls === undefined ? '' : `\n${JSON.stringify(toolCalls)}`),
    };
  });
}

/** Build a diff summary string from a list of edits */
function buildDiffSummary(edits: Edit[]): string {
  if (edits.length === 0) return 'No changes';
  if (edits.length === 1) {
    return `Replaced "${edits[0].old_string}" → "${edits[0].new_string}"`;
  }
  const lines = edits.map(
    (e) => `  "${e.old_string}" → "${e.new_string}"`,
  );
  return `Applied ${edits.length} replacements:\n${lines.join('\n')}`;
}

/**
 * Parse tool call arguments as JSON, returning the parsed object or null.
 */
function parseToolArgs(rawArgs: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawArgs);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function buildExactMatchCorrectionMessage(params: {
  failedIndex: number;
  reason: string;
  suggestions?: string[];
  currentText: string;
}): string {
  const suggestions = params.suggestions?.filter(Boolean).slice(0, 3) ?? [];
  return (
    `Edit failed (edit #${params.failedIndex + 1}): ${params.reason}\n\n` +
    (suggestions.length > 0
      ? 'Closest exact excerpts from the current translation (diagnostic only):\n' +
        suggestions.map((item, index) => `${index + 1}. ${JSON.stringify(item)}`).join('\n') +
        '\n\n'
      : '') +
    'You have one correction attempt. Copy old_string character-for-character ' +
    'from CURRENT COMPLETE TRANSLATION below. Do not copy a quotation from the ' +
    'audit, source, or an earlier version. The system will not apply fuzzy matches. ' +
    'Every replacement must be unique; include unchanged surrounding context when needed.\n\n' +
    'CURRENT COMPLETE TRANSLATION:\n' +
    params.currentText
  );
}

interface InvalidEditToolCall {
  callIndex: number;
  reason: string;
}

/** Parse every replace_text call without silently dropping malformed entries. */
function extractEdits(
  toolCalls: Array<{ id: string; name: string; arguments: string }>,
): {
  valid: Array<{ edit: Edit; callId: string }>;
  invalid: InvalidEditToolCall[];
} {
  const valid: Array<{ edit: Edit; callId: string }> = [];
  const invalid: InvalidEditToolCall[] = [];
  for (const [callIndex, tc] of toolCalls.entries()) {
    if (tc.name !== 'replace_text') continue;
    const args = parseToolArgs(tc.arguments);
    if (!args) {
      invalid.push({
        callIndex,
        reason:
          'invalid JSON arguments; expected one JSON object with string fields "old_string" and "new_string"',
      });
      continue;
    }
    if (typeof args.old_string !== 'string' || args.old_string.length === 0) {
      invalid.push({
        callIndex,
        reason: '"old_string" must be a non-empty string',
      });
      continue;
    }
    if (typeof args.new_string !== 'string') {
      invalid.push({
        callIndex,
        reason: '"new_string" must be a string',
      });
      continue;
    }
    valid.push({
      edit: { old_string: args.old_string, new_string: args.new_string },
      callId: tc.id,
    });
  }
  return { valid, invalid };
}

/** System instruction for JSON fence protocol fallback */
const JSON_FENCE_SYSTEM_PROMPT =
  'You MUST output any text edits using ONLY the following format inside a fenced code block:\n\n' +
  '```json\n' +
  '{"old_string": "<exact text to replace>", "new_string": "<replacement text>"}\n' +
  '```\n\n' +
  'Each replacement must be a separate JSON code block. ' +
  'The old_string must be an exact, unique fragment of the current text. ' +
  'Include enough context to make the match unambiguous. ' +
  'You may include explanatory text outside the code blocks.';

/**
 * Parse JSON fence blocks from a text response.
 * Looks for ```json ... ``` blocks and extracts {old_string, new_string} objects.
 */
function parseJsonFenceEdits(content: string): Edit[] {
  const edits: Edit[] = [];
  // Match ```json ... ``` blocks (supports both ```json and ``` json)
  const fenceRegex = /```\s*json\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(content)) !== null) {
    const blockContent = match[1].trim();
    // Try to parse the entire block as a single JSON object
    try {
      const parsed = JSON.parse(blockContent);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const oldStr = typeof parsed.old_string === 'string' ? parsed.old_string : '';
        const newStr = typeof parsed.new_string === 'string' ? parsed.new_string : '';
        if (oldStr) {
          edits.push({ old_string: oldStr, new_string: newStr });
        }
      }
    } catch {
      // Try line-by-line parsing for multi-object blocks
      const lines = blockContent.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const oldStr = typeof parsed.old_string === 'string' ? parsed.old_string : '';
            const newStr = typeof parsed.new_string === 'string' ? parsed.new_string : '';
            if (oldStr) {
              edits.push({ old_string: oldStr, new_string: newStr });
            }
          }
        } catch {
          // skip unparsable lines
        }
      }
    }
  }

  return edits;
}

// =============================================================================
// Streaming helper: collect all events from a chat completion call
// =============================================================================

interface CollectedStreamResult {
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

async function collectStream(
  result: ChatCompletionResponse | AsyncIterable<LLMStreamEvent>,
  onDelta?: (text: string) => void,
): Promise<CollectedStreamResult> {
  if (!isAsyncIterable(result)) {
    // Non-streaming response
    if (result.content && onDelta) {
      onDelta(result.content);
    }
    return {
      content: result.content,
      toolCalls: result.toolCalls,
    };
  }

  // Streaming response
  let content = '';
  let toolCalls: Array<{ id: string; name: string; arguments: string }> | undefined;

  for await (const event of result) {
    switch (event.type) {
      case 'text':
        content += event.content;
        if (onDelta) onDelta(event.content);
        break;
      case 'done':
        content = event.content || content;
        toolCalls = event.toolCalls;
        break;
      // tool_call_delta events are informational; final merged data is in 'done'
    }
  }

  return { content, toolCalls };
}

// =============================================================================
// Core: native tools call
// =============================================================================

async function callWithTools(
  endpoint: { baseUrl: string; apiKey: string; chatCompletionsPath?: string },
  model: string,
  messages: Array<{ role: string; content: string; name?: string; tool_call_id?: string }>,
  tools: ChatCompletionRequest['tools'],
  onDelta?: (text: string) => void,
  onActivity?: () => void,
  stream: boolean = true,
  maxTokens?: number,
  signal?: AbortSignal,
  ledgerContext?: BestEffortLlmCallContext,
): Promise<CollectedStreamResult> {
  const request: ChatCompletionRequest = {
    model,
    messages,
    tools,
    maxTokens,
    stream,
    onActivity,
    signal,
  };

  const result = await ledgeredChatCompletion(endpoint, request, ledgerContext);
  return collectStream(result, onDelta);
}

// =============================================================================
// Core: JSON fence protocol call (no tools)
// =============================================================================

async function callJsonFence(
  endpoint: { baseUrl: string; apiKey: string; chatCompletionsPath?: string },
  model: string,
  messages: Array<{ role: string; content: string; name?: string; tool_call_id?: string }>,
  onDelta?: (text: string) => void,
  onActivity?: () => void,
  maxTokens?: number,
  signal?: AbortSignal,
  ledgerContext?: BestEffortLlmCallContext,
): Promise<CollectedStreamResult> {
  const request: ChatCompletionRequest = {
    model,
    messages,
    maxTokens,
    stream: false, // Non-streaming for easier JSON parsing
    onActivity,
    signal,
  };

  const result = await ledgeredChatCompletion(endpoint, request, ledgerContext);
  return collectStream(result, onDelta);
}

// =============================================================================
// Main entry point
// =============================================================================

/**
 * Run a single chat turn with tool-calling loop.
 *
 * The function calls the LLM with the replace_text tool. If the model returns
 * tool_calls, the edits are applied transactionally via applyReplacementBatch.
 * On failure (ambiguous/not_found), an error message is injected into the
 * conversation and the model gets a chance to self-correct, up to CHAT_LOOP_MAX
 * iterations.
 *
 * If the endpoint does not support tools (ToolsNotSupportedError), the function
 * automatically falls back to a JSON fence protocol: a system instruction is
 * injected asking the model to output edits in ```json blocks, and those are
 * parsed and applied.
 *
 * @returns ChatTurnResult — ok:true with kind:'message' or kind:'edited',
 *          or ok:false with an error code.
 */
export async function runChatTurn(
  params: RunChatTurnParams,
): Promise<ChatTurnResult> {
  const {
    endpoint,
    model,
    messages: inputMessages,
    callbacks,
    stream = true,
    contextWindow = null,
    maxTokens: requestedMaxTokens,
    tools = CHAT_TOOLS,
  } = params;
  const maxTokens = resolveCompletionTokenBudget(
    inputMessages.map((message) => message.content).join('\n') +
      (tools ? JSON.stringify(tools) : ''),
    contextWindow,
    requestedMaxTokens,
  );

  let currentText = params.currentText;

  const onDelta = callbacks?.onDelta;
  const onActivity = callbacks?.onActivity;
  const onToolCall = callbacks?.onToolCall;
  const onToolResult = callbacks?.onToolResult;
  const onDomainToolResult = callbacks?.onDomainToolResult;
  const onProtocolFallback = callbacks?.onProtocolFallback;
  const exposedToolNames = new Set(
    (tools ?? []).map((tool) => tool.function.name),
  );
  const applyAndTraceReplaceBatch = async (
    calls: Array<{
      args: unknown;
      providerToolCallId?: string;
    }>,
    legacyEdits: Edit[],
  ): Promise<
    | { ok: true; newText: string }
    | {
        ok: false;
        failedIndex: number;
        reason: string;
        suggestions?: string[];
      }
  > => {
    if (!params.domainRuntime || !params.domainContext) {
      return applyExactReplacementBatch(currentText, legacyEdits);
    }
    const executed = await params.domainRuntime.executeReplaceTextBatch({
      calls: calls.map((call) => ({
        args: call.args,
        providerToolCallId: call.providerToolCallId,
      })),
      context: {
        ...params.domainContext,
        baseVersion: params.domainContext.baseVersion
          ? { ...params.domainContext.baseVersion, text: currentText }
          : null,
      },
    });
    if (executed.ok) {
      executed.calls.forEach((call, index) => {
        onDomainToolResult?.(
          'replace_text',
          true,
          call.result,
          calls[index]?.providerToolCallId ?? call.callId,
        );
      });
      return { ok: true, newText: executed.newText };
    }
    executed.traces.forEach((trace, index) => {
      onDomainToolResult?.(
        'replace_text',
        false,
        { code: trace.errorCode, message: trace.errorMessage },
        calls[index]?.providerToolCallId ?? trace.id,
      );
    });
    return {
      ok: false,
      failedIndex: executed.failedIndex,
      reason: executed.reason,
      suggestions: executed.suggestions,
    };
  };

  // Clone messages so we don't mutate the caller's array
  const messages = cloneMessages(inputMessages);
  let useFallbackProtocol = false;
  let fallbackSystemInjected = false;
  let editCorrectionAttempts = 0;
  let physicalRequestCount = 0;

  const nextPhysicalRequest = (
    requestMessages: RunChatTurnParams['messages'],
    requestTools?: ChatCompletionRequest['tools'],
  ): BestEffortLlmCallContext | undefined => {
    const retryCount = physicalRequestCount;
    physicalRequestCount += 1;
    params.beforePhysicalCall?.({
      messages: paidCallPreflightMessages(requestMessages),
      tools: requestTools,
      maxTokens,
      attempted: physicalRequestCount,
    });
    if (!params.ledger) return undefined;
    return {
      ...params.ledger,
      operation: 'chat_edit',
      retryCount,
    };
  };

  for (let iteration = 0; iteration < CHAT_LOOP_MAX; iteration++) {
    let collected: CollectedStreamResult;

    // ---------------------------------------------------------------
    // Step 1: Call the LLM (native tools or JSON fence fallback)
    // ---------------------------------------------------------------
    try {
      if (useFallbackProtocol) {
        // JSON fence protocol (no tools)
        if (!fallbackSystemInjected) {
          // Inject system instruction for JSON fence format
          // Insert after any existing system messages
          const systemIdx = messages.findIndex((m) => m.role === 'system');
          const fenceMsg = { role: 'system', content: JSON_FENCE_SYSTEM_PROMPT };
          if (systemIdx >= 0) {
            messages.splice(systemIdx + 1, 0, fenceMsg);
          } else {
            messages.unshift(fenceMsg);
          }
          fallbackSystemInjected = true;
        }

        if (onProtocolFallback) {
          onProtocolFallback();
        }

        collected = await callJsonFence(
          endpoint,
          model,
          messages,
          onDelta,
          onActivity,
          maxTokens,
          params.signal,
          nextPhysicalRequest(messages),
        );
      } else {
        // Native tools protocol
        collected = await callWithTools(
          endpoint,
          model,
          messages,
          tools,
          onDelta,
          onActivity,
          stream,
          maxTokens,
          params.signal,
          nextPhysicalRequest(messages, tools),
        );
      }
    } catch (error: unknown) {
      // ToolsNotSupportedError → switch to fallback protocol
      if (error instanceof ToolsNotSupportedError) {
        useFallbackProtocol = true;
        if (onProtocolFallback) {
          onProtocolFallback();
        }
        // Don't consume an iteration for the protocol switch itself
        // Retry immediately with fallback
        continue;
      }
      // Other errors: propagate
      throw error;
    }

    const { content, toolCalls } = collected;

    // ---------------------------------------------------------------
    // Step 2: If in fallback mode, parse JSON fence blocks
    // ---------------------------------------------------------------
    if (useFallbackProtocol) {
      const fenceEdits = parseJsonFenceEdits(content);

      if (fenceEdits.length === 0) {
        // No valid JSON fences found — inject error and retry
        messages.push({
          role: 'assistant',
          content,
        });
        messages.push({
          role: 'user',
          content:
            'No valid JSON edit blocks found in your response. ' +
            'You MUST include at least one ```json block with {"old_string":..., "new_string":...}. ' +
            'The current text is:\n\n' +
            currentText,
        });
        continue;
      }

      // Apply the fence edits and, when audit tooling is available, persist
      // every replacement outcome through the same trace-first batch runtime.
      const batchResult = await applyAndTraceReplaceBatch(
        fenceEdits.map((edit) => ({ args: edit })),
        fenceEdits,
      );

      if (batchResult.ok) {
        // Fire callbacks for each edit
        for (const edit of fenceEdits) {
          if (onToolCall) {
            onToolCall('replace_text', {
              old_string: edit.old_string,
              new_string: edit.new_string,
            });
          }
        }

        const diffSummary = buildDiffSummary(fenceEdits);

        if (onToolResult) {
          onToolResult(true, { newText: batchResult.newText, diffSummary });
        }

        return {
          ok: true,
          kind: 'edited',
          newText: batchResult.newText,
          diffSummary,
        };
      }

      if (onToolResult) onToolResult(false);
      if (editCorrectionAttempts >= MAX_EDIT_CORRECTION_ATTEMPTS) {
        return {
          ok: false,
          code: 'chat_edit_correction_failed',
          message:
            `Edit #${batchResult.failedIndex + 1} still did not identify an exact unique passage after one correction: ` +
            batchResult.reason,
        };
      }
      editCorrectionAttempts += 1;

      // Batch failed — inject one bounded exact-match correction.
      messages.push({
        role: 'assistant',
        content,
      });
      messages.push({
        role: 'user',
        content: buildExactMatchCorrectionMessage({
          failedIndex: batchResult.failedIndex,
          reason: batchResult.reason,
          suggestions: batchResult.suggestions,
          currentText,
        }),
      });
      continue;
    }

    // ---------------------------------------------------------------
    // Step 3: Native tools — check for tool_calls
    // ---------------------------------------------------------------
    if (!toolCalls || toolCalls.length === 0) {
      // No tool calls — pure discussion message
      return { ok: true, kind: 'message', text: content };
    }

    // ---------------------------------------------------------------
    // Step 3a: non-edit tools. Domain calls use the bound translation runtime;
    // programming calls require an explicitly exposed programming definition.
    // ---------------------------------------------------------------
    // When the model mixes programming tools with replace_text in one batch,
    // every call is executed and its result backfilled, then the loop
    // continues so the model sees the outcomes (replace_text edits update
    // currentText for subsequent iterations). Pure replace_text batches
    // keep the legacy path below (apply → return on success).
    const nonEditCalls = toolCalls.filter((tc) => tc.name !== 'replace_text');
    if (nonEditCalls.length > 0) {
      if (toolCalls.some((tc) => tc.name === 'replace_text')) {
        if (params.domainRuntime && params.domainContext) {
          const replaceCalls = toolCalls.filter(
            (tc) => tc.name === 'replace_text',
          );
          const traces = params.domainRuntime.rejectReplaceTextBatch({
            calls: replaceCalls.map((tc) => ({
              args: parseToolArgs(tc.arguments) ?? {
                invalidJsonArguments: tc.arguments,
              },
              providerToolCallId: tc.id,
            })),
            context: params.domainContext,
            reason:
              'The replacement was not attempted because the provider mixed text edits with other tools.',
          });
          traces.forEach((trace, index) => {
            onDomainToolResult?.(
              'replace_text',
              false,
              { code: trace.errorCode, message: trace.errorMessage },
              replaceCalls[index]?.id ?? trace.id,
            );
          });
        }
        return {
          ok: false,
          code: 'mixed_tool_batch_not_supported',
          message:
            'Text edits and other tools cannot run in the same model response. ' +
            'No edit or tool side effect was applied.',
        };
      }
      messages.push({
        role: 'assistant',
        content: content || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      } as unknown as { role: string; content: string });

      for (const tc of toolCalls) {
        const args = parseToolArgs(tc.arguments) ?? {};
        if (onToolCall) onToolCall(tc.name, args);
        let toolContent: string;
        if (DOMAIN_TOOL_NAMES.has(tc.name)) {
          if (!params.domainRuntime || !params.domainContext) {
            toolContent = `Error: translation domain tool ${tc.name} is unavailable in this turn.`;
            onDomainToolResult?.(tc.name, false, {
              code: 'domain_runtime_unavailable',
              message: toolContent,
            }, tc.id);
          } else {
            try {
              const executed = await params.domainRuntime.execute({
                name: tc.name,
                args,
                providerToolCallId: tc.id,
                context: params.domainContext,
              });
              toolContent = JSON.stringify(executed.result);
              onDomainToolResult?.(tc.name, true, executed.result, tc.id);
            } catch (error) {
              const failure = {
                code:
                  error && typeof error === 'object' && 'code' in error
                    ? String(error.code)
                    : 'domain_tool_failed',
                message: error instanceof Error ? error.message : String(error),
              };
              toolContent = `Error: ${failure.code}: ${failure.message}`;
              onDomainToolResult?.(tc.name, false, failure, tc.id);
            }
          }
        } else if (
          PROGRAMMING_TOOL_NAMES.has(tc.name) &&
          exposedToolNames.has(tc.name)
        ) {
          const toolResult = await executeProgrammaticTool(tc.name, args);
          toolContent = toolResult.content;
          if (onToolResult) {
            onToolResult(toolResult.ok, toolResult.ok
              ? { newText: currentText, diffSummary: toolResult.content.slice(0, 200) }
              : undefined);
          }
        } else {
          // A hallucinated or unexposed name is never forwarded to the host
          // programming executor.
          toolContent = 'Unknown tool — ignored.';
        }
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: toolContent,
        });
      }
      continue;
    }

    // Parse the complete replace_text batch before applying any edit. A model
    // argument error rejects the whole batch so a valid sibling cannot be
    // committed while a malformed sibling is silently discarded.
    const extracted = extractEdits(toolCalls);
    const extractedEdits = extracted.valid;
    const edits = extractedEdits.map((e) => e.edit);

    if (extracted.invalid.length > 0) {
      const invalidByCallIndex = new Map(
        extracted.invalid.map((failure) => [failure.callIndex, failure]),
      );
      const firstFailure = extracted.invalid[0];
      const batchReason =
        `replace_text call #${firstFailure.callIndex + 1} has ${firstFailure.reason}. ` +
        'No edit in this batch was applied.';

      if (params.domainRuntime && params.domainContext) {
        const traces = params.domainRuntime.rejectReplaceTextBatch({
          calls: toolCalls.map((tc) => ({
            args: parseToolArgs(tc.arguments) ?? {
              invalidJsonArguments: tc.arguments,
            },
            providerToolCallId: tc.id,
          })),
          context: params.domainContext,
          reason: batchReason,
        });
        traces.forEach((trace, index) => {
          onDomainToolResult?.(
            'replace_text',
            false,
            { code: trace.errorCode, message: trace.errorMessage },
            toolCalls[index]?.id ?? trace.id,
          );
        });
      }

      if (onToolResult) onToolResult(false);
      messages.push({
        role: 'assistant',
        content: content || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      } as unknown as { role: string; content: string });

      for (const [callIndex, tc] of toolCalls.entries()) {
        const failure = invalidByCallIndex.get(callIndex);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: failure
            ? `Error: replace_text call #${failure.callIndex + 1} has ${failure.reason}. ` +
              'The entire edit batch was rejected; no edit was applied.'
            : `Error: this replace_text call was not applied because another call ` +
              `in the same batch was invalid (call #${firstFailure.callIndex + 1}). ` +
              'The entire edit batch was rejected.',
        });
      }
      continue;
    }

    const tracedBatch = params.domainRuntime && params.domainContext
      ? await applyAndTraceReplaceBatch(
          toolCalls.map((tc) => ({
            args: parseToolArgs(tc.arguments) ?? {
              invalidJsonArguments: tc.arguments,
            },
            providerToolCallId: tc.id,
          })),
          edits,
        )
      : null;

    // Fire onToolCall for each valid edit
    if (onToolCall) {
      for (const ext of extractedEdits) {
        const args = parseToolArgs(
          toolCalls.find((tc) => tc.id === ext.callId)?.arguments ?? '{}',
        );
        onToolCall('replace_text', args ?? {});
      }
    }

    // ---------------------------------------------------------------
    // Step 4: Apply edits transactionally
    // ---------------------------------------------------------------
    const batchResult = tracedBatch ?? applyExactReplacementBatch(currentText, edits);

    if (batchResult.ok) {
      const diffSummary = buildDiffSummary(edits);

      if (onToolResult) {
        onToolResult(true, { newText: batchResult.newText, diffSummary });
      }

      return {
        ok: true,
        kind: 'edited',
        newText: batchResult.newText,
        diffSummary,
      };
    }

    // ---------------------------------------------------------------
    // Step 5: Batch failed — inject error for self-correction
    // ---------------------------------------------------------------

    // Fire onToolResult for the failure
    if (onToolResult) {
      onToolResult(false);
    }

    if (editCorrectionAttempts >= MAX_EDIT_CORRECTION_ATTEMPTS) {
      return {
        ok: false,
        code: 'chat_edit_correction_failed',
        message:
          `Edit #${batchResult.failedIndex + 1} still did not identify an exact unique passage after one correction: ` +
          batchResult.reason,
      };
    }
    editCorrectionAttempts += 1;

    // Add the assistant message with tool_calls to the conversation
    messages.push({
      role: 'assistant',
      content: content || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    } as unknown as { role: string; content: string });

    // Add tool result messages — one per tool_call in the batch
    // For tool_calls before the failed one: report rolled back
    // For the failed one: report the actual error
    // For tool_calls after: not attempted
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      let toolContent: string;

      if (tc.name !== 'replace_text') {
        toolContent = 'Unknown tool — ignored.';
      } else if (i < batchResult.failedIndex) {
        toolContent =
          'This edit was not applied because a subsequent edit in the same batch failed. ' +
          `The batch was rolled back. Failed at edit #${batchResult.failedIndex + 1}: ${batchResult.reason}`;
      } else if (i === batchResult.failedIndex) {
        toolContent = buildExactMatchCorrectionMessage({
          failedIndex: batchResult.failedIndex,
          reason: batchResult.reason,
          suggestions: batchResult.suggestions,
          currentText,
        });
      } else {
        toolContent =
          'This edit was not attempted because a prior edit in the same batch failed.';
      }

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: toolContent,
      });
    }

    // Continue to next iteration
  }

  // Loop exhausted
  return {
    ok: false,
    code: 'chat_loop_exhausted',
    message: `Chat tool loop reached the maximum of ${CHAT_LOOP_MAX} iterations without a successful outcome.`,
  };
}
