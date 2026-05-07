// ---------------------------------------------------------------------------
// 四阶段管道运行器 — schema 校验 + 重试 + stale 失效
// Wave 2 Task 11 — plan lines 814–871
// ---------------------------------------------------------------------------

import { z } from 'zod';
import { buildStageContext } from '../context/stage-context';
import { buildStagePrompt } from '../prompts/assemble';
import {
  reviewOutputSchema,
  filterOutputSchema,
  orchestrateOutputSchema,
  assembleOutputSchema,
} from '../contracts/schemas';
import type { Stage, TranslationResult, StageOutput } from '../contracts/types';
import type { ChatCompletionResponse, LLMStreamEvent, ChatCompletionRequest } from '../llm/client';
import { isAsyncIterable } from '../llm/client';

// ===========================================================================
// Exported types
// ===========================================================================

/** Result of running a single coordination stage */
export interface StageRunResult {
  ok: boolean;
  code: 'success' | 'stage_schema_error' | 'stage_prerequisite_missing' | 'llm_error';
  detail?: string;
  parsed_output?: unknown;
  raw_text?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/** Callbacks invoked during stage execution */
export interface PipelineCallbacks {
  onStageStart?(stage: Stage): void;
  onDelta?(stage: Stage, content: string): void;
  onStageComplete?(stage: Stage, result: StageRunResult): void;
  onSchemaError?(stage: Stage, rawText: string, zodError: string, attempt: number): void;
  onError?(stage: Stage, error: Error): void;
  onAssembled?(finalText: string): void;
}

/** Session context containing all data needed by the pipeline */
export interface SessionContext {
  sourceText: string;
  sourceLang: string;
  targetLang: string;
  translations: TranslationResult[];
  priorStages: StageOutput[];
  coordinatorEndpoint: { baseUrl: string; apiKey: string };
  coordinatorModel: string;
  promptTemplates: Record<string, string>;
}

/**
 * Injectable LLM caller — matches `chatCompletion` signature but allows
 * tests to inject a mock without vi.mock.
 */
export type LLMCaller = (
  endpoint: { baseUrl: string; apiKey: string },
  request: ChatCompletionRequest,
) => Promise<ChatCompletionResponse | AsyncIterable<LLMStreamEvent>>;

// ===========================================================================
// Stage config lookup tables
// ===========================================================================

/** C2 schemas indexed by stage name */
const STAGE_SCHEMAS: Record<Stage, z.ZodTypeAny> = {
  review: reviewOutputSchema,
  filter: filterOutputSchema,
  orchestrate: orchestrateOutputSchema,
  assemble: assembleOutputSchema,
};

/** Human-readable schema descriptions for stage prompts */
const STAGE_SCHEMA_DESCRIPTIONS: Record<Stage, string> = {
  review: JSON.stringify({
    assessments: [
      {
        agent_id: 'string',
        strengths: ['string'],
        weaknesses: ['string'],
        quality_score: 'integer 1-10',
        keep: 'boolean',
      },
    ],
  }, null, 2),
  filter: JSON.stringify({
    selected_agent_ids: ['string'],
    rejected_agent_ids: ['string'],
    rationale: 'string',
  }, null, 2),
  orchestrate: JSON.stringify({
    structure_notes: 'string',
    segment_assignments: [
      {
        segment_index: 'integer',
        source_agent_id: 'string',
        source_segment: 'string',
        rationale: 'string',
      },
    ],
  }, null, 2),
  assemble: JSON.stringify({
    final_text: 'string (non-empty)',
    notes: 'string',
  }, null, 2),
};

/** Prerequisite stage for each stage — must be `complete` before this stage runs */
const STAGE_PREREQUISITES: Record<Stage, Stage | null> = {
  review: null,
  filter: 'review',
  orchestrate: 'filter',
  assemble: 'orchestrate',
};

/** Which stages use streaming LLM calls */
function isStreamingStage(stage: Stage): boolean {
  return stage === 'orchestrate' || stage === 'assemble';
}

// ===========================================================================
// Public API — extractJson
// ===========================================================================

/**
 * Extract the first complete JSON object or array from raw LLM output text.
 *
 * Handles:
 *   - Markdown code fences (` ```json ... ``` `, ` ``` ... ``` `)
 *   - Prose before/after the JSON
 *   - Escaped quotes and backslashes inside string values
 *   - Nested objects/arrays
 *
 * Returns the extracted JSON string, or an empty string if none found.
 */
export function extractJson(rawText: string): string {
  let cleaned = rawText.trim();

  // ── 1. Strip markdown code fences ────────────────────────────
  const fenceMatch = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // ── 2. Find first `{` or `[` ─────────────────────────────────
  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');

  if (firstBrace === -1 && firstBracket === -1) return '';

  const startIdx =
    firstBrace === -1
      ? firstBracket
      : firstBracket === -1
        ? firstBrace
        : Math.min(firstBrace, firstBracket);

  // ── 3. Walk characters tracking depth, strings, escapes ──────
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < cleaned.length; i++) {
    const ch = cleaned[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        return cleaned.slice(startIdx, i + 1);
      }
    }
  }

  // Unclosed brackets — no valid JSON
  return '';
}

// ===========================================================================
// Public API — markDownstreamStale
// ===========================================================================

/**
 * Return the list of downstream stages that become stale when `stage` is
 * re-run or modified.
 *
 *   review     → [filter, orchestrate, assemble]
 *   filter     → [orchestrate, assemble]
 *   orchestrate → [assemble]
 *   assemble   → []
 */
export function markDownstreamStale(stage: Stage): Stage[] {
  switch (stage) {
    case 'review':
      return ['filter', 'orchestrate', 'assemble'];
    case 'filter':
      return ['orchestrate', 'assemble'];
    case 'orchestrate':
      return ['assemble'];
    case 'assemble':
      return [];
  }
}

// ===========================================================================
// Public API — runStage
// ===========================================================================

/**
 * Run a single coordination stage end-to-end.
 *
 * Flow:
 *   1. Check stage prerequisites (ordering guard)
 *   2. Build stage context JSON (C3)
 *   3. Build stage prompt (system + user messages)
 *   4. Call LLM — streaming for orchestrate/assemble, non-streaming for review/filter
 *   5. Extract JSON from raw response via `extractJson`
 *   6. Validate against the C2 zod schema
 *   7. On validation failure → auto-retry once with a correction message
 *   8. On assemble success → invoke `callbacks.onAssembled(finalText)`
 *
 * @param stage           Which coordination stage to run
 * @param sessionContext  Source text, translations, prior stages, LLM config
 * @param callbacks       Lifecycle callbacks (optional)
 * @param llmCall         Injected LLM caller (defaults to the real chatCompletion)
 * @returns               StageRunResult with ok/code/detail/parsed_output/raw_text
 */
export async function runStage(
  stage: Stage,
  sessionContext: SessionContext,
  callbacks: PipelineCallbacks = {},
  llmCall: LLMCaller,
): Promise<StageRunResult> {
  callbacks.onStageStart?.(stage);

  try {
    // ── 1. Check prerequisite ──────────────────────────────────
    const prereq = STAGE_PREREQUISITES[stage];
    if (prereq) {
      const prereqOutput = sessionContext.priorStages.find(
        (s) => s.stage === prereq,
      );
      if (!prereqOutput || prereqOutput.status !== 'complete') {
        const result: StageRunResult = {
          ok: false,
          code: 'stage_prerequisite_missing',
          detail: `Prerequisite stage '${prereq}' is not complete`,
        };
        callbacks.onStageComplete?.(stage, result);
        return result;
      }
    }

    // ── 2. Build stage context ─────────────────────────────────
    const contextResult = buildStageContext(stage, {
      sourceText: sessionContext.sourceText,
      sourceLang: sessionContext.sourceLang,
      targetLang: sessionContext.targetLang,
      translations: sessionContext.translations,
      priorStages: sessionContext.priorStages,
    });

    const contextJson = JSON.stringify(contextResult.json);

    // ── 3. Build stage prompt ──────────────────────────────────
    const schema = STAGE_SCHEMAS[stage];
    const stageTemplate = sessionContext.promptTemplates[stage] ?? '';
    const schemaDesc = STAGE_SCHEMA_DESCRIPTIONS[stage];

    const { system, user } = buildStagePrompt(
      stageTemplate,
      contextJson,
      schemaDesc,
    );

    // ── 4. LLM call with retry ─────────────────────────────────
    const streaming = isStreamingStage(stage);
    const maxAttempts = 2;
    let lastRawText = '';

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const messages: Array<{ role: string; content: string }> = [
        { role: 'system', content: system.content },
        { role: 'user', content: user.content },
      ];

      // If retrying, append correction message
      if (attempt > 0) {
        messages.push({ role: 'assistant', content: lastRawText });
        messages.push({
          role: 'user',
          content: '上次输出未通过校验，请严格只输出JSON',
        });
      }

      const llmResponse = await llmCall(sessionContext.coordinatorEndpoint, {
        model: sessionContext.coordinatorModel,
        messages,
        stream: streaming,
      });

      // ── 4a. Collect response text ────────────────────────────
      let rawText = '';

      if (isAsyncIterable(llmResponse)) {
        for await (const event of llmResponse) {
          if (event.type === 'text') {
            rawText += event.content;
            callbacks.onDelta?.(stage, event.content);
          } else if (event.type === 'done') {
            // Use accumulated content, or the done.content if available
            if (event.content && event.content.length > 0) {
              rawText = event.content;
            }
          }
        }
      } else {
        rawText = llmResponse.content;
      }

      lastRawText = rawText;

      // ── 5. Extract JSON ─────────────────────────────────────
      const jsonStr = extractJson(rawText);

      if (!jsonStr) {
        callbacks.onSchemaError?.(
          stage,
          rawText,
          'No JSON found in LLM output',
          attempt + 1,
        );
        if (attempt === 0) continue; // retry

        const result: StageRunResult = {
          ok: false,
          code: 'stage_schema_error',
          detail: 'No valid JSON found in LLM output after retry',
          raw_text: rawText,
        };
        callbacks.onStageComplete?.(stage, result);
        return result;
      }

      // ── 6. Parse JSON ───────────────────────────────────────
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        callbacks.onSchemaError?.(
          stage,
          rawText,
          'JSON parse error — extracted text is not valid JSON syntax',
          attempt + 1,
        );
        if (attempt === 0) continue; // retry

        const result: StageRunResult = {
          ok: false,
          code: 'stage_schema_error',
          detail: 'Failed to parse extracted text as JSON after retry',
          raw_text: rawText,
        };
        callbacks.onStageComplete?.(stage, result);
        return result;
      }

      // ── 7. Zod validation ───────────────────────────────────
      const validationResult = schema.safeParse(parsed);

      if (!validationResult.success) {
        const zodDetail = validationResult.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ');

        callbacks.onSchemaError?.(stage, rawText, zodDetail, attempt + 1);

        if (attempt === 0) continue; // retry once

        const result: StageRunResult = {
          ok: false,
          code: 'stage_schema_error',
          detail: zodDetail,
          raw_text: rawText,
        };
        callbacks.onStageComplete?.(stage, result);
        return result;
      }

      // ── 8. Success ──────────────────────────────────────────
      const result: StageRunResult = {
        ok: true,
        code: 'success',
        parsed_output: validationResult.data,
        raw_text: rawText,
      };

      callbacks.onStageComplete?.(stage, result);

      // Assemble special callback
      if (stage === 'assemble') {
        const data = validationResult.data as Record<string, unknown>;
        if (typeof data.final_text === 'string') {
          callbacks.onAssembled?.(data.final_text);
        }
      }

      return result;
    }

    // Should never reach here — loop always returns
    throw new Error('Unexpected: retry loop exhausted without return');
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    callbacks.onError?.(stage, err);

    const result: StageRunResult = {
      ok: false,
      code: 'llm_error',
      detail: err.message,
    };
    callbacks.onStageComplete?.(stage, result);
    return result;
  }
}
