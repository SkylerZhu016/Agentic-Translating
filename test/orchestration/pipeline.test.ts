/**
 * pipeline.test.ts — TDD for 四阶段管道运行器
 *
 * Covers:
 *   - markDownstreamStale: all 4 stages → correct downstream list
 *   - Stage ordering guard: prerequisite missing → stage_prerequisite_missing
 *   - All 4 stages return raw_text correctly
 *   - Assemble stage extracts final_text from raw response
 *   - Callbacks: onStageStart, onDelta, onStageComplete, onError, onAssembled
 *   - Assemble success → callbacks.onAssembled(finalText) with split extraction
 *
 * Uses an injectable mock LLM caller — no HTTP server needed.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runStage,
  markDownstreamStale,
  type StageRunResult,
  type SessionContext,
  type PipelineCallbacks,
  type LLMCaller,
} from '../../src/lib/orchestration/pipeline';
import type { Stage, StageOutput, TranslationResult } from '../../src/lib/contracts/types';
import type { ChatCompletionResponse, ChatCompletionRequest } from '../../src/lib/llm/client';

// =============================================================================
// Helpers
// =============================================================================

/** Create a minimal StageOutput fixture */
function stageOut(overrides: Partial<StageOutput> = {}): StageOutput {
  return {
    id: 1,
    session_id: 'sess_01J',
    stage: 'review',
    status: 'complete',
    prompt_used: null,
    raw_output: null,
    error: null,
    ...overrides,
  };
}

/** Create a minimal TranslationResult fixture */
function trans(overrides: Partial<TranslationResult> = {}): TranslationResult {
  return {
    id: 1,
    session_id: 'sess_01J',
    agent_key: 'agent1',
    agent_snapshot: JSON.stringify({ name: 'Agent 1', model: 'gpt-4' }),
    status: 'complete',
    output_text: '你好世界',
    error: null,
    latency_ms: 100,
    attempt: 1,
    ...overrides,
  };
}

/** Create a minimal SessionContext */
function makeCtx(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    sessionId: 'sess_01J',
    sourceText: 'Hello world',
    sourceLang: 'en',
    targetLang: 'zh',
    translations: [trans()],
    priorStages: [],
    coordinatorEndpoint: { baseUrl: 'http://mock.local', apiKey: 'sk-mock' },
    coordinatorModel: 'gpt-4o',
    promptTemplates: {
      review: 'Review these translations: {{context}}',
      filter: 'Filter these translations: {{context}}',
      orchestrate: 'Orchestrate these translations: {{context}}',
      assemble: 'Assemble this translation: {{context}}',
    },
    ...overrides,
  };
}

/** Create a mock LLM caller that returns predetermined content */
function mockLLM(content: string): LLMCaller {
  return vi.fn(async (
    _endpoint: { baseUrl: string; apiKey: string },
    _request: ChatCompletionRequest,
  ) => {
    const response: ChatCompletionResponse = { content };
    return response;
  });
}

/** Create a streaming mock LLM caller that yields delta events */
function mockStreamLLM(content: string): LLMCaller {
  return vi.fn(async function* (
    _endpoint: { baseUrl: string; apiKey: string },
    _request: ChatCompletionRequest,
  ) {
    for (const ch of content) {
      yield { type: 'text' as const, content: ch };
    }
    yield { type: 'done' as const, content };
  } as any);
}

// =============================================================================
// markDownstreamStale
// =============================================================================

describe('markDownstreamStale', () => {
  it('review → [filter, orchestrate, assemble]', () => {
    expect(markDownstreamStale('review')).toEqual(['filter', 'orchestrate', 'assemble']);
  });

  it('filter → [orchestrate, assemble]', () => {
    expect(markDownstreamStale('filter')).toEqual(['orchestrate', 'assemble']);
  });

  it('orchestrate → [assemble]', () => {
    expect(markDownstreamStale('orchestrate')).toEqual(['assemble']);
  });

  it('assemble → []', () => {
    expect(markDownstreamStale('assemble')).toEqual([]);
  });
});

// =============================================================================
// Stage ordering guard — prerequisite checks
// =============================================================================

describe('stage prerequisite guard', () => {
  it('review has no prerequisite — runs normally', async () => {
    const llm = mockLLM('some output text');
    const ctx = makeCtx({ priorStages: [] });

    const result = await runStage('review', ctx, {}, llm);
    expect(result.ok).toBe(true);
  });

  it('filter without complete review → stage_prerequisite_missing', async () => {
    const llm = mockLLM('output');
    const ctx = makeCtx({ priorStages: [] });

    const result = await runStage('filter', ctx, {}, llm);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('stage_prerequisite_missing');
    expect(result.detail).toContain('review');
  });

  it('orchestrate without complete filter → stage_prerequisite_missing', async () => {
    const llm = mockLLM('output');
    const ctx = makeCtx({
      priorStages: [stageOut({ stage: 'review', status: 'complete' })],
    });

    const result = await runStage('orchestrate', ctx, {}, llm);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('stage_prerequisite_missing');
    expect(result.detail).toContain('filter');
  });

  it('assemble without complete orchestrate → stage_prerequisite_missing', async () => {
    const llm = mockLLM('output');
    const ctx = makeCtx({
      priorStages: [
        stageOut({ stage: 'review', status: 'complete' }),
        stageOut({ stage: 'filter', status: 'complete' }),
      ],
    });

    const result = await runStage('assemble', ctx, {}, llm);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('stage_prerequisite_missing');
    expect(result.detail).toContain('orchestrate');
  });

  it('filter with complete review → proceeds (no prereq error)', async () => {
    const llm = mockLLM('some output for filter');
    const ctx = makeCtx({
      priorStages: [stageOut({ stage: 'review', status: 'complete' })],
    });

    const result = await runStage('filter', ctx, {}, llm);
    // Should not be prereq error
    expect(result.code).not.toBe('stage_prerequisite_missing');
  });
});

// =============================================================================
// All 4 stages — success paths
// =============================================================================

describe('runStage — success paths', () => {
  describe('review stage', () => {
    it('returns ok with raw_text', async () => {
      const llm = mockLLM('review analysis output');
      const ctx = makeCtx();

      const result = await runStage('review', ctx, {}, llm);
      expect(result.ok).toBe(true);
      expect(result.code).toBe('success');
      expect(result.raw_text).toBe('review analysis output');
      expect(llm).toHaveBeenCalledTimes(1);
    });
  });

  describe('filter stage', () => {
    it('returns ok with raw_text', async () => {
      const llm = mockLLM('filter results output');
      const ctx = makeCtx({
        priorStages: [stageOut({ stage: 'review', status: 'complete' })],
      });

      const result = await runStage('filter', ctx, {}, llm);
      expect(result.ok).toBe(true);
      expect(result.code).toBe('success');
      expect(result.raw_text).toBe('filter results output');
      expect(llm).toHaveBeenCalledTimes(1);
    });
  });

  describe('orchestrate stage', () => {
    it('returns ok with raw_text (streaming)', async () => {
      const llm = mockStreamLLM('orchestration plan output');
      const ctx = makeCtx({
        priorStages: [
          stageOut({ stage: 'review', status: 'complete' }),
          stageOut({ stage: 'filter', status: 'complete' }),
        ],
      });

      const result = await runStage('orchestrate', ctx, {}, llm);
      expect(result.ok).toBe(true);
      expect(result.code).toBe('success');
      expect(result.raw_text).toBe('orchestration plan output');
      expect(llm).toHaveBeenCalledTimes(1);
    });
  });

  describe('assemble stage', () => {
    it('returns ok with raw_text and final_text (streaming)', async () => {
      const output = '最终译文\n---\nnotes about the translation';
      const llm = mockStreamLLM(output);
      const ctx = makeCtx({
        priorStages: [
          stageOut({ stage: 'review', status: 'complete' }),
          stageOut({ stage: 'filter', status: 'complete' }),
          stageOut({ stage: 'orchestrate', status: 'complete' }),
        ],
      });

      const result = await runStage('assemble', ctx, {}, llm);
      expect(result.ok).toBe(true);
      expect(result.code).toBe('success');
      expect(result.raw_text).toBe(output);
      expect(result.final_text).toBe('最终译文');
      expect(llm).toHaveBeenCalledTimes(1);
    });

    it('sets final_text to first segment before --- separator', async () => {
      const output = 'Final translated text.\n---\nSome notes here.';
      const llm = mockStreamLLM(output);
      const ctx = makeCtx({
        priorStages: [
          stageOut({ stage: 'review', status: 'complete' }),
          stageOut({ stage: 'filter', status: 'complete' }),
          stageOut({ stage: 'orchestrate', status: 'complete' }),
        ],
      });

      const result = await runStage('assemble', ctx, {}, llm);
      expect(result.final_text).toBe('Final translated text.');
    });

    it('calls onAssembled with final_text on success', async () => {
      const output = '最终译文\n---\ndone';
      const llm = mockStreamLLM(output);
      const ctx = makeCtx({
        priorStages: [
          stageOut({ stage: 'review', status: 'complete' }),
          stageOut({ stage: 'filter', status: 'complete' }),
          stageOut({ stage: 'orchestrate', status: 'complete' }),
        ],
      });

      const onAssembled = vi.fn();
      const result = await runStage('assemble', ctx, { onAssembled }, llm);
      expect(result.ok).toBe(true);
      expect(onAssembled).toHaveBeenCalledWith('最终译文');
    });

    it('does NOT call onAssembled when assemble output is empty', async () => {
      const llm = mockStreamLLM('');
      const ctx = makeCtx({
        priorStages: [
          stageOut({ stage: 'review', status: 'complete' }),
          stageOut({ stage: 'filter', status: 'complete' }),
          stageOut({ stage: 'orchestrate', status: 'complete' }),
        ],
      });

      const onAssembled = vi.fn();
      const result = await runStage('assemble', ctx, { onAssembled }, llm);
      expect(result.ok).toBe(true);
      // final_text should be empty string from split + trim, which is falsy
      expect(onAssembled).not.toHaveBeenCalled();
    });
  });
});

// =============================================================================
// Callbacks
// =============================================================================

describe('callbacks', () => {
  it('onStageStart is called at the beginning', async () => {
    const llm = mockLLM('some output');
    const ctx = makeCtx();
    const onStageStart = vi.fn();

    await runStage('review', ctx, { onStageStart }, llm);
    expect(onStageStart).toHaveBeenCalledWith('review');
    expect(onStageStart).toHaveBeenCalledTimes(1);
  });

  it('onStageComplete is called with the result', async () => {
    const llm = mockLLM('output text');
    const ctx = makeCtx();
    const onStageComplete = vi.fn();

    const result = await runStage('review', ctx, { onStageComplete }, llm);
    expect(onStageComplete).toHaveBeenCalledWith('review', expect.objectContaining({ ok: true }));
  });

  it('onDelta is called for streaming stages (orchestrate)', async () => {
    const llm = mockStreamLLM('orchestration output');
    const ctx = makeCtx({
      priorStages: [
        stageOut({ stage: 'review', status: 'complete' }),
        stageOut({ stage: 'filter', status: 'complete' }),
      ],
    });
    const onDelta = vi.fn();

    await runStage('orchestrate', ctx, { onDelta }, llm);
    expect(onDelta).toHaveBeenCalled();
    const firstCall = onDelta.mock.calls[0];
    expect(firstCall[0]).toBe('orchestrate');
    expect(typeof firstCall[1]).toBe('string');
  });

  it('onDelta is called for streaming stages (assemble)', async () => {
    const llm = mockStreamLLM('assemble output\n---\nnotes');
    const ctx = makeCtx({
      priorStages: [
        stageOut({ stage: 'review', status: 'complete' }),
        stageOut({ stage: 'filter', status: 'complete' }),
        stageOut({ stage: 'orchestrate', status: 'complete' }),
      ],
    });
    const onDelta = vi.fn();

    await runStage('assemble', ctx, { onDelta }, llm);
    expect(onDelta).toHaveBeenCalled();
  });

  it('onDelta is NOT called for non-streaming stages (review)', async () => {
    const llm = mockLLM('review output');
    const ctx = makeCtx();
    const onDelta = vi.fn();

    await runStage('review', ctx, { onDelta }, llm);
    expect(onDelta).not.toHaveBeenCalled();
  });

  it('onDelta is NOT called for non-streaming stages (filter)', async () => {
    const llm = mockLLM('filter output');
    const ctx = makeCtx({
      priorStages: [stageOut({ stage: 'review', status: 'complete' })],
    });
    const onDelta = vi.fn();

    await runStage('filter', ctx, { onDelta }, llm);
    expect(onDelta).not.toHaveBeenCalled();
  });

  it('onError is called when LLM caller throws', async () => {
    const llm: LLMCaller = vi.fn(async () => {
      throw new Error('Network failure');
    });
    const ctx = makeCtx();
    const onError = vi.fn();

    const result = await runStage('review', ctx, { onError }, llm);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('llm_error');
    expect(result.detail).toContain('Network failure');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('review', expect.any(Error));
  });

  it('onError is called with the original error object', async () => {
    const customError = new Error('Custom LLM crash');
    const llm: LLMCaller = vi.fn(async () => {
      throw customError;
    });
    const ctx = makeCtx();
    const onError = vi.fn();

    await runStage('review', ctx, { onError }, llm);
    expect(onError).toHaveBeenCalledWith('review', customError);
  });
});

// =============================================================================
// Edge cases
// =============================================================================

describe('edge cases', () => {
  it('returns raw_text alongside final_text for assemble', async () => {
    const rawText = 'Final text here.\n---\nExtra notes.';
    const llm = mockLLM(rawText);
    const ctx = makeCtx({
      priorStages: [
        stageOut({ stage: 'review', status: 'complete' }),
        stageOut({ stage: 'filter', status: 'complete' }),
        stageOut({ stage: 'orchestrate', status: 'complete' }),
      ],
    });

    const result = await runStage('assemble', ctx, {}, llm);
    expect(result.ok).toBe(true);
    expect(result.raw_text).toBe(rawText);
    expect(result.final_text).toBe('Final text here.');
  });

  it('non-assemble stages do not set final_text', async () => {
    const llm = mockLLM('some review text');
    const ctx = makeCtx();

    const result = await runStage('review', ctx, {}, llm);
    expect(result.ok).toBe(true);
    expect(result.raw_text).toBe('some review text');
    expect(result.final_text).toBeUndefined();
  });

  it('empty prompt templates still work', async () => {
    const llm = mockLLM('output text');
    const ctx = makeCtx();
    ctx.promptTemplates.review = 'Review: {{context}}';

    const result = await runStage('review', ctx, {}, llm);
    expect(result.ok).toBe(true);
  });
});

// =============================================================================
// Refactored pipeline behavior — raw_text instead of parsed_output
// =============================================================================

describe('refactored pipeline behavior', () => {
  it('runStage returns raw_text, not parsed_output', async () => {
    const llm = mockLLM('Plain text review without JSON parsing.');
    const ctx = makeCtx();

    const result = await runStage('review', ctx, {}, llm);
    expect(result.ok).toBe(true);
    expect(result.code).toBe('success');
    expect(result.raw_text).toBe('Plain text review without JSON parsing.');
    // The result must NOT contain a parsed_output field
    expect((result as unknown as Record<string, unknown>).parsed_output).toBeUndefined();
  });

  it('assemble final_text uses \\n---\\n split regex (plain text + notes)', async () => {
    const output = '最终译文正文\n---\n注释部分';
    const llm = mockLLM(output);
    const ctx = makeCtx({
      priorStages: [
        stageOut({ stage: 'review', status: 'complete' }),
        stageOut({ stage: 'filter', status: 'complete' }),
        stageOut({ stage: 'orchestrate', status: 'complete' }),
      ],
    });

    const result = await runStage('assemble', ctx, {}, llm);
    expect(result.ok).toBe(true);
    expect(result.raw_text).toBe(output);
    expect(result.final_text).toBe('最终译文正文');
  });

  it('assemble with no --- separator returns full output as final_text', async () => {
    const output = 'Just final text without any separator.';
    const llm = mockLLM(output);
    const ctx = makeCtx({
      priorStages: [
        stageOut({ stage: 'review', status: 'complete' }),
        stageOut({ stage: 'filter', status: 'complete' }),
        stageOut({ stage: 'orchestrate', status: 'complete' }),
      ],
    });

    const result = await runStage('assemble', ctx, {}, llm);
    expect(result.ok).toBe(true);
    expect(result.raw_text).toBe(output);
    expect(result.final_text).toBe(output);
  });

  it('assemble with empty LLM output → empty final_text, onAssembled NOT called', async () => {
    const llm = mockLLM('');
    const ctx = makeCtx({
      priorStages: [
        stageOut({ stage: 'review', status: 'complete' }),
        stageOut({ stage: 'filter', status: 'complete' }),
        stageOut({ stage: 'orchestrate', status: 'complete' }),
      ],
    });

    const onAssembled = vi.fn();
    const result = await runStage('assemble', ctx, { onAssembled }, llm);
    expect(result.ok).toBe(true);
    expect(result.raw_text).toBe('');
    expect(result.final_text).toBe('');
    expect(onAssembled).not.toHaveBeenCalled();
  });

  it('assemble with multi-line text and --- on its own line splits correctly', async () => {
    const output = 'Line 1\nLine 2\n---\nNote about assembly';
    const llm = mockStreamLLM(output);
    const ctx = makeCtx({
      priorStages: [
        stageOut({ stage: 'review', status: 'complete' }),
        stageOut({ stage: 'filter', status: 'complete' }),
        stageOut({ stage: 'orchestrate', status: 'complete' }),
      ],
    });

    const result = await runStage('assemble', ctx, {}, llm);
    expect(result.final_text).toBe('Line 1\nLine 2');
  });

  it('extractJson is no longer exported from pipeline (refactored away)', async () => {
    // The JSON-extraction helper was deleted during the refactor; the named
    // export must be undefined on the module namespace.
    const mod = await import('../../src/lib/orchestration/pipeline');
    expect((mod as Record<string, unknown>).extractJson).toBeUndefined();
  });
});
