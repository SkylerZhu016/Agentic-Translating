// ---------------------------------------------------------------------------
// 四阶段管道运行器 — stage state machine + streaming LLM
// ---------------------------------------------------------------------------

import { buildStageContext } from '../context/stage-context';
import { buildStagePrompt } from '../prompts/assemble';
import { writeRunArtifact } from '../storage/run-artifacts';
import type { Stage, TranslationResult, StageOutput } from '../contracts/types';
import type { ChatCompletionResponse, LLMStreamEvent, ChatCompletionRequest } from '../llm/client';
import { isAsyncIterable } from '../llm/client';
import { semanticBody } from '../protocol/semantic-output';

// ===========================================================================
// Exported types
// ===========================================================================

/** Result of running a single coordination stage */
export interface StageRunResult {
  ok: boolean;
  code: 'success' | 'stage_prerequisite_missing' | 'llm_error' | 'assemble_empty';
  detail?: string;
  raw_text?: string;
  /** Only set for assemble stage — the final translated text extracted from raw output */
  final_text?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/** Callbacks invoked during stage execution */
export interface PipelineCallbacks {
  onStageStart?(stage: Stage): void;
  onDelta?(stage: Stage, content: string): void;
  onStageComplete?(stage: Stage, result: StageRunResult): void;
  onError?(stage: Stage, error: Error): void;
  onAssembled?(finalText: string): void;
}

/** Session context containing all data needed by the pipeline */
export interface SessionContext {
  sessionId: string;
  sourceText: string;
  sourceLang: string;
  targetLang: string;
  taskBrief?: string;
  promptLanguage?: 'zh' | 'en';
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
  endpoint: { baseUrl: string; apiKey: string; chatCompletionsPath?: string },
  request: ChatCompletionRequest,
) => Promise<ChatCompletionResponse | AsyncIterable<LLMStreamEvent>>;

// ===========================================================================
// Stage config lookup tables
// ===========================================================================

/** Human-readable stage goals for stage prompts */
const STAGE_GOALS: Record<Stage, string> = {
  review: '请审查这些译文的质量',
  filter: '请筛选出最优译文',
  orchestrate: '请规划如何组装最终译文',
  assemble: '请输出最终译文',
};

const STAGE_GOALS_EN: Record<Stage, string> = {
  review: 'Review the candidate translations and identify material trade-offs.',
  filter: 'Select the most useful candidate evidence for the final translation.',
  orchestrate: 'Plan how the final translation should be assembled.',
  assemble: 'Produce the complete final translation.',
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
 *   5. Collect raw response text
 *   6. On assemble success → invoke `callbacks.onAssembled(finalText)`
 *      where finalText = rawText.split('\n---\n')[0].trim()
 *
 * @param stage           Which coordination stage to run
 * @param sessionContext  Source text, translations, prior stages, LLM config
 * @param callbacks       Lifecycle callbacks (optional)
 * @param llmCall         Injected LLM caller (defaults to the real chatCompletion)
 * @returns               StageRunResult with ok/code/detail/raw_text/final_text
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
      taskBrief: sessionContext.taskBrief,
    });

    const contextJson = JSON.stringify(contextResult.json);

    // ── 3. Build stage prompt ──────────────────────────────────
    const stageTemplate = sessionContext.promptTemplates[stage] ?? '';
    const stageGoal =
      sessionContext.promptLanguage === 'en'
        ? STAGE_GOALS_EN[stage]
        : STAGE_GOALS[stage];

    const { system, user } = buildStagePrompt(
      stageTemplate,
      contextJson,
      stageGoal,
      sessionContext.promptLanguage,
    );

    // ── 4. LLM call ────────────────────────────────────────────
    const streaming = isStreamingStage(stage);
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: system.content },
      { role: 'user', content: user.content },
    ];

    const llmResponse = await llmCall(sessionContext.coordinatorEndpoint, {
      model: sessionContext.coordinatorModel,
      messages,
      stream: streaming,
    });

    // ── 5. Collect response text ───────────────────────────────
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

    // ── 5b. Persist as txt artifact ─────────────────────────────
    writeRunArtifact(sessionContext.sessionId, stage, rawText);

    // ── 6. Build result ────────────────────────────────────────
    let finalText: string | undefined;
    if (stage === 'assemble') {
      finalText = semanticBody(rawText);
      if (finalText) {
        callbacks.onAssembled?.(finalText);
      }
    }

    const result: StageRunResult = {
      ok: true,
      code: 'success',
      raw_text: rawText,
      final_text: finalText,
    };

    callbacks.onStageComplete?.(stage, result);
    return result;
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
