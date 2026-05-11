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

import { chatCompletion, isAsyncIterable, ToolsNotSupportedError } from '../llm/client';
import type { ChatCompletionRequest, ChatCompletionResponse, LLMStreamEvent } from '../llm/client';
import { applyReplacementBatch, type Edit } from '../editing/replace';
import { REPLACE_TEXT_TOOL } from './tools';
import { CHAT_LOOP_MAX } from '../constants';

// =============================================================================
// Types
// =============================================================================

/** Callbacks for observing chat turn progress */
export interface ChatCallbacks {
  /** Called for each text delta during streaming */
  onDelta?: (text: string) => void;
  /** Called when the model invokes a replace_text tool */
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  /** Called with the result of applying tool calls */
  onToolResult?: (ok: boolean, result?: { newText: string; diffSummary: string }) => void;
  /** Called when falling back from native tools to JSON fence protocol */
  onProtocolFallback?: () => void;
}

/** Parameters for a single chat turn */
export interface RunChatTurnParams {
  endpoint: { baseUrl: string; apiKey: string };
  model: string;
  messages: Array<{ role: string; content: string; name?: string; tool_call_id?: string }>;
  /** The current full text being edited */
  currentText: string;
  callbacks?: ChatCallbacks;
  /** Whether to use streaming (default: true) */
  stream?: boolean;
}

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

/**
 * Extract replace_text edits from tool calls, filtering out unknown tools
 * and invalid arguments.
 */
function extractEdits(
  toolCalls: Array<{ id: string; name: string; arguments: string }>,
): Array<{ edit: Edit; callId: string }> {
  const results: Array<{ edit: Edit; callId: string }> = [];
  for (const tc of toolCalls) {
    if (tc.name !== 'replace_text') continue;
    const args = parseToolArgs(tc.arguments);
    if (!args) continue;
    const oldString = typeof args.old_string === 'string' ? args.old_string : '';
    const newString = typeof args.new_string === 'string' ? args.new_string : '';
    if (!oldString && oldString !== '') continue; // empty old_string is invalid
    results.push({
      edit: { old_string: oldString, new_string: newString },
      callId: tc.id,
    });
  }
  return results;
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
  endpoint: { baseUrl: string; apiKey: string },
  model: string,
  messages: Array<{ role: string; content: string; name?: string; tool_call_id?: string }>,
  onDelta?: (text: string) => void,
  stream: boolean = true,
): Promise<CollectedStreamResult> {
  const request: ChatCompletionRequest = {
    model,
    messages,
    tools: [REPLACE_TEXT_TOOL],
    stream,
  };

  const result = await chatCompletion(endpoint, request);
  return collectStream(result, onDelta);
}

// =============================================================================
// Core: JSON fence protocol call (no tools)
// =============================================================================

async function callJsonFence(
  endpoint: { baseUrl: string; apiKey: string },
  model: string,
  messages: Array<{ role: string; content: string; name?: string; tool_call_id?: string }>,
  onDelta?: (text: string) => void,
): Promise<CollectedStreamResult> {
  const request: ChatCompletionRequest = {
    model,
    messages,
    stream: false, // Non-streaming for easier JSON parsing
  };

  const result = await chatCompletion(endpoint, request);
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
    currentText,
    callbacks,
    stream = true,
  } = params;

  const onDelta = callbacks?.onDelta;
  const onToolCall = callbacks?.onToolCall;
  const onToolResult = callbacks?.onToolResult;
  const onProtocolFallback = callbacks?.onProtocolFallback;

  // Clone messages so we don't mutate the caller's array
  const messages = cloneMessages(inputMessages);
  let useFallbackProtocol = false;
  let fallbackSystemInjected = false;

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

        collected = await callJsonFence(endpoint, model, messages, onDelta);
      } else {
        // Native tools protocol
        collected = await callWithTools(endpoint, model, messages, onDelta, stream);
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

      // Apply the fence edits
      const batchResult = applyReplacementBatch(currentText, fenceEdits);

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

      // Batch failed — inject error and retry
      messages.push({
        role: 'assistant',
        content,
      });
      messages.push({
        role: 'user',
        content:
          `Edit failed (edit #${batchResult.failedIndex + 1}): ${batchResult.reason}\n\n` +
          'Current text for reference:\n\n' +
          currentText +
          '\n\nPlease correct the old_string to match the text exactly.',
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

    // Extract replace_text edits from tool calls
    const extractedEdits = extractEdits(toolCalls);
    const edits = extractedEdits.map((e) => e.edit);

    if (edits.length === 0) {
      // Tool calls exist but none produced valid replace_text edits
      // (e.g., unknown tool names or invalid JSON arguments)
      // Check if there were any replace_text calls at all
      const hasReplaceTextCalls = toolCalls.some((tc) => tc.name === 'replace_text');

      if (hasReplaceTextCalls) {
        // Model tried to use replace_text but arguments were invalid → inject error
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
          if (tc.name !== 'replace_text') continue;
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content:
              'Error: invalid JSON arguments for replace_text. ' +
              'Arguments must be valid JSON with "old_string" and "new_string" fields. ' +
              `Received: ${tc.arguments}`,
          });
        }
        continue;
      }

      // No replace_text calls at all — pure message
      return { ok: true, kind: 'message', text: content };
    }

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
    const batchResult = applyReplacementBatch(currentText, edits);

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
        toolContent =
          `Edit failed: ${batchResult.reason}\n\n` +
          'Current text for reference:\n\n' +
          currentText +
          '\n\nPlease use a more specific old_string that uniquely matches the text.';
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
