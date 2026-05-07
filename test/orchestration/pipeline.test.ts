/**
 * pipeline.test.ts — TDD for 四阶段管道运行器 (Wave 2 Task 11)
 *
 * Covers:
 *   - extractJson: clean JSON, markdown fence, prose-wrapped, nested brackets
 *   - markDownstreamStale: all 4 stages → correct downstream list
 *   - Stage ordering guard: prerequisite missing → stage_prerequisite_missing
 *   - All 4 stages with valid JSON → parsed_output matches C2 schemas
 *   - Malformed JSON → auto retry (2 total requests) → still bad → stage_schema_error
 *   - Malformed JSON → retry succeeds → ok
 *   - JSON inside ```json ... ``` fence → correctly extracted and parsed
 *   - Callbacks: onStageStart, onDelta, onStageComplete, onSchemaError, onError, onAssembled
 *   - Assemble success → callbacks.onAssembled(finalText)
 *
 * Uses an injectable mock LLM caller — no HTTP server needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runStage,
  extractJson,
  markDownstreamStale,
  type StageRunResult,
  type SessionContext,
  type PipelineCallbacks,
  type LLMCaller,
} from '../../src/lib/orchestration/pipeline';
import type { Stage, StageOutput, TranslationResult } from '../../src/lib/contracts/types';
import type { ChatCompletionResponse, ChatCompletionRequest } from '../../src/lib/llm/client';
import { reviewOutputSchema, filterOutputSchema, orchestrateOutputSchema, assembleOutputSchema } from '../../src/lib/contracts/schemas';

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
    parsed_output: null,
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

/** Create a mock LLM caller that fails on first call, succeeds on second */
function mockRetryLLM(firstContent: string, secondContent: string): LLMCaller {
  let callCount = 0;
  return vi.fn(async (
    _endpoint: { baseUrl: string; apiKey: string },
    _request: ChatCompletionRequest,
  ) => {
    callCount++;
    const content = callCount === 1 ? firstContent : secondContent;
    const response: ChatCompletionResponse = { content };
    return response;
  });
}

// =============================================================================
// extractJson
// =============================================================================

describe('extractJson', () => {
  it('returns clean JSON unchanged', () => {
    const json = '{"key":"value"}';
    expect(extractJson(json)).toBe(json);
  });

  it('extracts JSON from markdown code fence (```json ... ```)', () => {
    const raw = '```json\n{"key":"value"}\n```';
    expect(extractJson(raw)).toBe('{"key":"value"}');
  });

  it('extracts JSON from generic code fence (``` ... ```)', () => {
    const raw = '```\n{"key":"value"}\n```';
    expect(extractJson(raw)).toBe('{"key":"value"}');
  });

  it('extracts JSON object surrounded by prose before', () => {
    const raw = 'Here is your result:\n{"ok":true,"data":{"nested":"yes"}}\nHope this helps!';
    expect(extractJson(raw)).toBe('{"ok":true,"data":{"nested":"yes"}}');
  });

  it('extracts JSON array from prose', () => {
    const raw = 'Results: [1, 2, 3] end.';
    expect(extractJson(raw)).toBe('[1, 2, 3]');
  });

  it('handles nested objects and arrays correctly', () => {
    const raw = 'Some text {"a": [1, {"b": "c"}, [2, 3]], "d": {"e": "f"}} trailing text';
    expect(extractJson(raw)).toBe('{"a": [1, {"b": "c"}, [2, 3]], "d": {"e": "f"}}');
  });

  it('returns empty string when no JSON found', () => {
    expect(extractJson('no json here at all')).toBe('');
  });

  it('handles JSON with string values containing { and }', () => {
    const raw = '{"greeting": "hello {world}"}';
    expect(extractJson(raw)).toBe('{"greeting": "hello {world}"}');
  });

  it('handles JSON with escaped quotes', () => {
    const raw = '{"quote": "he said \\"hello\\""}';
    expect(extractJson(raw)).toBe('{"quote": "he said \\"hello\\""}');
  });

  it('handles JSON with escaped backslashes', () => {
    const raw = '{"path": "C:\\\\Users\\\\test"}';
    expect(extractJson(raw)).toBe('{"path": "C:\\\\Users\\\\test"}');
  });

  it('handles unclosed brackets gracefully', () => {
    const raw = '{"key": "value"';
    // Bracket never closes; no valid JSON extractable
    expect(extractJson(raw)).toBe('');
  });

  it('picks the first valid JSON when multiple objects exist', () => {
    const raw = '{"first":1} and {"second":2}';
    expect(extractJson(raw)).toBe('{"first":1}');
  });
});

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
    const llm = mockLLM(JSON.stringify({ assessments: [{ agent_id: 'a1', strengths: [], weaknesses: [], quality_score: 5, keep: true }] }));
    const ctx = makeCtx({ priorStages: [] });

    const result = await runStage('review', ctx, {}, llm);
    expect(result.ok).toBe(true);
  });

  it('filter without complete review → stage_prerequisite_missing', async () => {
    const llm = mockLLM('{}');
    const ctx = makeCtx({ priorStages: [] });

    const result = await runStage('filter', ctx, {}, llm);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('stage_prerequisite_missing');
    expect(result.detail).toContain('review');
  });

  it('orchestrate without complete filter → stage_prerequisite_missing', async () => {
    const llm = mockLLM('{}');
    const ctx = makeCtx({
      priorStages: [stageOut({ stage: 'review', status: 'complete' })],
    });

    const result = await runStage('orchestrate', ctx, {}, llm);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('stage_prerequisite_missing');
    expect(result.detail).toContain('filter');
  });

  it('assemble without complete orchestrate → stage_prerequisite_missing', async () => {
    const llm = mockLLM('{}');
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
    const llm = mockLLM(JSON.stringify({ selected_agent_ids: ['a1'], rejected_agent_ids: [], rationale: 'ok' }));
    const ctx = makeCtx({
      priorStages: [stageOut({ stage: 'review', status: 'complete' })],
    });

    const result = await runStage('filter', ctx, {}, llm);
    // Should not be prereq error — may be schema or success
    expect(result.code).not.toBe('stage_prerequisite_missing');
  });
});

// =============================================================================
// All 4 stages — success paths with valid JSON
// =============================================================================

describe('runStage — success paths', () => {
  describe('review stage', () => {
    it('returns ok with parsed_output matching reviewOutputSchema', async () => {
      const validReview = {
        assessments: [
          { agent_id: 'agent1', strengths: ['good flow'], weaknesses: ['missed nuance'], quality_score: 7, keep: true },
          { agent_id: 'agent2', strengths: ['accurate'], weaknesses: ['stiff'], quality_score: 5, keep: false },
        ],
      };
      const llm = mockLLM(JSON.stringify(validReview));
      const ctx = makeCtx();

      const result = await runStage('review', ctx, {}, llm);
      expect(result.ok).toBe(true);
      expect(result.code).toBe('success');
      expect(result.parsed_output).toEqual(validReview);
      expect(llm).toHaveBeenCalledTimes(1);
    });

    it('parsed_output passes zod safeParse for reviewOutputSchema', async () => {
      const data = {
        assessments: [
          { agent_id: 'a1', strengths: [], weaknesses: [], quality_score: 1, keep: true },
        ],
      };
      const llm = mockLLM(JSON.stringify(data));
      const ctx = makeCtx();

      const result = await runStage('review', ctx, {}, llm);
      expect(result.ok).toBe(true);
      const parseResult = reviewOutputSchema.safeParse(result.parsed_output);
      expect(parseResult.success).toBe(true);
    });
  });

  describe('filter stage', () => {
    it('returns ok with parsed_output matching filterOutputSchema', async () => {
      const validFilter = {
        selected_agent_ids: ['agent1', 'agent3'],
        rejected_agent_ids: ['agent2'],
        rationale: 'Agent 1 has best fluency, Agent 3 most accurate',
      };
      const llm = mockLLM(JSON.stringify(validFilter));
      const ctx = makeCtx({
        priorStages: [stageOut({ stage: 'review', status: 'complete' })],
      });

      const result = await runStage('filter', ctx, {}, llm);
      expect(result.ok).toBe(true);
      expect(result.code).toBe('success');
      expect(result.parsed_output).toEqual(validFilter);
      expect(llm).toHaveBeenCalledTimes(1);
    });

    it('parsed_output passes zod safeParse for filterOutputSchema', async () => {
      const data = {
        selected_agent_ids: ['a1'],
        rejected_agent_ids: [],
        rationale: 'best choice',
      };
      const llm = mockLLM(JSON.stringify(data));
      const ctx = makeCtx({
        priorStages: [stageOut({ stage: 'review', status: 'complete' })],
      });

      const result = await runStage('filter', ctx, {}, llm);
      expect(result.ok).toBe(true);
      const parseResult = filterOutputSchema.safeParse(result.parsed_output);
      expect(parseResult.success).toBe(true);
    });
  });

  describe('orchestrate stage', () => {
    it('returns ok with parsed_output matching orchestrateOutputSchema (streaming)', async () => {
      const validOrch = {
        structure_notes: 'Split into intro, body, conclusion',
        segment_assignments: [
          { segment_index: 0, source_agent_id: 'agent1', source_segment: 'Hello world', rationale: 'best intro' },
          { segment_index: 1, source_agent_id: 'agent2', source_segment: 'This is body', rationale: 'best body' },
        ],
      };
      const llm = mockStreamLLM(JSON.stringify(validOrch));
      const ctx = makeCtx({
        priorStages: [
          stageOut({ stage: 'review', status: 'complete' }),
          stageOut({ stage: 'filter', status: 'complete' }),
        ],
      });

      const result = await runStage('orchestrate', ctx, {}, llm);
      expect(result.ok).toBe(true);
      expect(result.code).toBe('success');
      expect(result.parsed_output).toEqual(validOrch);
      expect(llm).toHaveBeenCalledTimes(1);
    });

    it('parsed_output passes zod safeParse for orchestrateOutputSchema', async () => {
      const data = {
        structure_notes: 'simple',
        segment_assignments: [
          { segment_index: 0, source_agent_id: 'a1', source_segment: 'segment text', rationale: 'best fit' },
        ],
      };
      const llm = mockStreamLLM(JSON.stringify(data));
      const ctx = makeCtx({
        priorStages: [
          stageOut({ stage: 'review', status: 'complete' }),
          stageOut({ stage: 'filter', status: 'complete' }),
        ],
      });

      const result = await runStage('orchestrate', ctx, {}, llm);
      expect(result.ok).toBe(true);
      const parseResult = orchestrateOutputSchema.safeParse(result.parsed_output);
      expect(parseResult.success).toBe(true);
    });
  });

  describe('assemble stage', () => {
    it('returns ok with parsed_output matching assembleOutputSchema (streaming)', async () => {
      const validAssemble = {
        final_text: '你好世界',
        notes: 'Combined from agent1 intro + agent2 body',
      };
      const llm = mockStreamLLM(JSON.stringify(validAssemble));
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
      expect(result.parsed_output).toEqual(validAssemble);
      expect(llm).toHaveBeenCalledTimes(1);
    });

    it('parsed_output passes zod safeParse for assembleOutputSchema', async () => {
      const data = { final_text: '结果文本', notes: '' };
      const llm = mockStreamLLM(JSON.stringify(data));
      const ctx = makeCtx({
        priorStages: [
          stageOut({ stage: 'review', status: 'complete' }),
          stageOut({ stage: 'filter', status: 'complete' }),
          stageOut({ stage: 'orchestrate', status: 'complete' }),
        ],
      });

      const result = await runStage('assemble', ctx, {}, llm);
      expect(result.ok).toBe(true);
      const parseResult = assembleOutputSchema.safeParse(result.parsed_output);
      expect(parseResult.success).toBe(true);
    });

    it('calls onAssembled with final_text on success', async () => {
      const validAssemble = { final_text: '最终译文', notes: 'done' };
      const llm = mockStreamLLM(JSON.stringify(validAssemble));
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

    it('does NOT call onAssembled when assemble validation fails', async () => {
      const invalidJson = JSON.stringify({ wrong_field: 'bad' });
      const llm = mockLLM(invalidJson);
      const ctx = makeCtx({
        priorStages: [
          stageOut({ stage: 'review', status: 'complete' }),
          stageOut({ stage: 'filter', status: 'complete' }),
          stageOut({ stage: 'orchestrate', status: 'complete' }),
        ],
      });

      const onAssembled = vi.fn();
      // assemble is a streaming stage, so we use mockLLM (non-streaming works too,
      // but the pipeline will treat it as an async iterable. Let's use mockStreamLLM for consistency.)
      const streamLLM = mockStreamLLM(invalidJson);
      const result = await runStage('assemble', ctx, { onAssembled }, streamLLM);
      expect(onAssembled).not.toHaveBeenCalled();
    });
  });
});

// =============================================================================
// Schema validation + retry behavior
// =============================================================================

describe('schema validation + retry', () => {
  it('malformed JSON → retries once → still fails → stage_schema_error with zod detail', async () => {
    // First call returns malformed, second also returns malformed
    const llm = mockRetryLLM(
      JSON.stringify({ wrong_field: 'bad' }),
      JSON.stringify({ also_wrong: true }),
    );
    const ctx = makeCtx({
      priorStages: [stageOut({ stage: 'review', status: 'complete' })],
    });

    const result = await runStage('filter', ctx, {}, llm);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('stage_schema_error');
    expect(result.detail).toBeTruthy();
    // detail should contain zod error info
    expect(result.detail).toMatch(/selected_agent_ids|rationale|rejected_agent_ids/);
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it('malformed JSON with no JSON structure → stage_schema_error after retry', async () => {
    const llm = mockRetryLLM('not json at all', 'still not json');
    const ctx = makeCtx();

    const result = await runStage('review', ctx, {}, llm);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('stage_schema_error');
    expect(result.detail).toContain('No valid JSON');
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it('first call malformed, second call valid → succeeds', async () => {
    const validFilter = {
      selected_agent_ids: ['agent1'],
      rejected_agent_ids: [],
      rationale: 'best',
    };
    const llm = mockRetryLLM(
      JSON.stringify({ wrong: 'field' }),
      JSON.stringify(validFilter),
    );
    const ctx = makeCtx({
      priorStages: [stageOut({ stage: 'review', status: 'complete' })],
    });

    const result = await runStage('filter', ctx, {}, llm);
    expect(result.ok).toBe(true);
    expect(result.code).toBe('success');
    expect(result.parsed_output).toEqual(validFilter);
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it('valid JSON on first attempt → only 1 LLM call', async () => {
    const validReview = {
      assessments: [{ agent_id: 'a1', strengths: [], weaknesses: [], quality_score: 8, keep: true }],
    };
    const llm = mockLLM(JSON.stringify(validReview));
    const ctx = makeCtx();

    const result = await runStage('review', ctx, {}, llm);
    expect(result.ok).toBe(true);
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it('JSON parse error (not valid JSON syntax) → retries → still fails → stage_schema_error', async () => {
    const llm = mockRetryLLM('{broken: json}', '{also: broken}');
    const ctx = makeCtx();

    const result = await runStage('review', ctx, {}, llm);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('stage_schema_error');
    expect(result.detail).toContain('Failed to parse');
    expect(llm).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// Fence-wrapped JSON extraction within full flow
// =============================================================================

describe('JSON fence extraction in runStage', () => {
  it('extracts JSON from ```json fence and validates correctly', async () => {
    const wrapped = '```json\n{"assessments":[{"agent_id":"a1","strengths":["good"],"weaknesses":["bad"],"quality_score":5,"keep":true}]}\n```';
    const llm = mockLLM(wrapped);
    const ctx = makeCtx();

    const result = await runStage('review', ctx, {}, llm);
    expect(result.ok).toBe(true);
    expect(result.code).toBe('success');
    expect(result.parsed_output).toHaveProperty('assessments');
  });

  it('extracts JSON preceded by explanatory prose and validates', async () => {
    const withProse = 'Here is the review output based on my analysis:\n\n{"assessments":[{"agent_id":"a1","strengths":[],"weaknesses":[],"quality_score":7,"keep":true}]}\n\nI hope this is correct.';
    const llm = mockLLM(withProse);
    const ctx = makeCtx();

    const result = await runStage('review', ctx, {}, llm);
    expect(result.ok).toBe(true);
    expect(result.parsed_output).toHaveProperty('assessments');
  });
});

// =============================================================================
// Callbacks
// =============================================================================

describe('callbacks', () => {
  it('onStageStart is called at the beginning', async () => {
    const validJson = JSON.stringify({ assessments: [{ agent_id: 'a1', strengths: [], weaknesses: [], quality_score: 5, keep: true }] });
    const llm = mockLLM(validJson);
    const ctx = makeCtx();
    const onStageStart = vi.fn();

    await runStage('review', ctx, { onStageStart }, llm);
    expect(onStageStart).toHaveBeenCalledWith('review');
    expect(onStageStart).toHaveBeenCalledTimes(1);
  });

  it('onStageComplete is called with the result', async () => {
    const validJson = JSON.stringify({ assessments: [{ agent_id: 'a1', strengths: [], weaknesses: [], quality_score: 5, keep: true }] });
    const llm = mockLLM(validJson);
    const ctx = makeCtx();
    const onStageComplete = vi.fn();

    const result = await runStage('review', ctx, { onStageComplete }, llm);
    expect(onStageComplete).toHaveBeenCalledWith('review', expect.objectContaining({ ok: true }));
  });

  it('onDelta is called for streaming stages (orchestrate)', async () => {
    const validOrch = {
      structure_notes: 'ok',
      segment_assignments: [{ segment_index: 0, source_agent_id: 'a1', source_segment: 'text', rationale: 'best' }],
    };
    const llm = mockStreamLLM(JSON.stringify(validOrch));
    const ctx = makeCtx({
      priorStages: [
        stageOut({ stage: 'review', status: 'complete' }),
        stageOut({ stage: 'filter', status: 'complete' }),
      ],
    });
    const onDelta = vi.fn();

    await runStage('orchestrate', ctx, { onDelta }, llm);
    expect(onDelta).toHaveBeenCalled();
    // Each call receives stage name and content string
    const firstCall = onDelta.mock.calls[0];
    expect(firstCall[0]).toBe('orchestrate');
    expect(typeof firstCall[1]).toBe('string');
  });

  it('onDelta is called for streaming stages (assemble)', async () => {
    const validAssemble = { final_text: 'hello', notes: '' };
    const llm = mockStreamLLM(JSON.stringify(validAssemble));
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
    const validReview = JSON.stringify({ assessments: [{ agent_id: 'a1', strengths: [], weaknesses: [], quality_score: 5, keep: true }] });
    const llm = mockLLM(validReview);
    const ctx = makeCtx();
    const onDelta = vi.fn();

    await runStage('review', ctx, { onDelta }, llm);
    expect(onDelta).not.toHaveBeenCalled();
  });

  it('onDelta is NOT called for non-streaming stages (filter)', async () => {
    const validFilter = JSON.stringify({ selected_agent_ids: ['a1'], rejected_agent_ids: [], rationale: 'ok' });
    const llm = mockLLM(validFilter);
    const ctx = makeCtx({
      priorStages: [stageOut({ stage: 'review', status: 'complete' })],
    });
    const onDelta = vi.fn();

    await runStage('filter', ctx, { onDelta }, llm);
    expect(onDelta).not.toHaveBeenCalled();
  });

  it('onSchemaError is called on first validation failure (before retry)', async () => {
    const llm = mockRetryLLM(
      JSON.stringify({ wrong: 'field' }),
      JSON.stringify({ selected_agent_ids: ['a1'], rejected_agent_ids: [], rationale: 'ok' }),
    );
    const ctx = makeCtx({
      priorStages: [stageOut({ stage: 'review', status: 'complete' })],
    });
    const onSchemaError = vi.fn();

    await runStage('filter', ctx, { onSchemaError }, llm);
    expect(onSchemaError).toHaveBeenCalledTimes(1); // only first attempt fails
    expect(onSchemaError).toHaveBeenCalledWith(
      'filter',
      expect.any(String), // rawText
      expect.stringContaining('selected_agent_ids'), // zod error
      1, // attempt number
    );
  });

  it('onSchemaError is called twice when both attempts fail', async () => {
    const llm = mockRetryLLM(
      JSON.stringify({ wrong: 'field' }),
      JSON.stringify({ also: 'wrong' }),
    );
    const ctx = makeCtx({
      priorStages: [stageOut({ stage: 'review', status: 'complete' })],
    });
    const onSchemaError = vi.fn();

    await runStage('filter', ctx, { onSchemaError }, llm);
    expect(onSchemaError).toHaveBeenCalledTimes(2);
    expect(onSchemaError.mock.calls[0][3]).toBe(1); // first call, attempt 1
    expect(onSchemaError.mock.calls[1][3]).toBe(2); // second call, attempt 2
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

  it('all callbacks integrated: start → delta → schemaError → retry → complete', async () => {
    const onStageStart = vi.fn();
    const onDelta = vi.fn();
    const onSchemaError = vi.fn();
    const onStageComplete = vi.fn();

    const validOrch = {
      structure_notes: 'retry success',
      segment_assignments: [{ segment_index: 0, source_agent_id: 'a1', source_segment: 'text', rationale: 'best' }],
    };
    const llm: LLMCaller = vi.fn(async function* (
      _endpoint: { baseUrl: string; apiKey: string },
      _request: ChatCompletionRequest,
    ) {
      // unused placeholder
    } as any);

    // Use a counter-based streaming mock
    let callCount = 0;
    const streamingLLM: LLMCaller = vi.fn(async function* (
      _endpoint: { baseUrl: string; apiKey: string },
      _request: ChatCompletionRequest,
    ) {
      callCount++;
      const content = callCount === 1
        ? JSON.stringify({ bad: 'shape' })
        : JSON.stringify(validOrch);
      for (let i = 0; i < content.length; i++) {
        yield { type: 'text' as const, content: content[i] };
      }
      yield { type: 'done' as const, content };
    } as any);

    const ctx = makeCtx({
      priorStages: [
        stageOut({ stage: 'review', status: 'complete' }),
        stageOut({ stage: 'filter', status: 'complete' }),
      ],
    });

    const result = await runStage('orchestrate', ctx, {
      onStageStart,
      onDelta,
      onSchemaError,
      onStageComplete,
    }, streamingLLM);

    expect(onStageStart).toHaveBeenCalledWith('orchestrate');
    expect(onDelta).toHaveBeenCalled(); // streaming
    expect(onSchemaError).toHaveBeenCalledTimes(1); // first attempt fails
    expect(onStageComplete).toHaveBeenCalledWith('orchestrate', expect.objectContaining({ ok: true }));
    expect(result.ok).toBe(true);
  });
});

// =============================================================================
// Edge cases
// =============================================================================

describe('edge cases', () => {
  it('returns raw_text alongside parsed_output on success', async () => {
    const validReview = { assessments: [{ agent_id: 'a1', strengths: [], weaknesses: [], quality_score: 5, keep: true }] };
    const rawText = 'Here is the result:\n' + JSON.stringify(validReview) + '\nDone.';
    const llm = mockLLM(rawText);
    const ctx = makeCtx();

    const result = await runStage('review', ctx, {}, llm);
    expect(result.ok).toBe(true);
    expect(result.raw_text).toBe(rawText);
    expect(result.parsed_output).toEqual(validReview);
  });

  it('returns raw_text on schema error', async () => {
    const rawText = JSON.stringify({ bad: 'data' });
    const llm = mockRetryLLM(rawText, JSON.stringify({ also: 'bad' }));
    const ctx = makeCtx();

    const result = await runStage('review', ctx, {}, llm);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('stage_schema_error');
    expect(result.raw_text).toBeTruthy();
  });

  it('empty prompt templates still work (no extra context inserted)', async () => {
    const validReview = { assessments: [{ agent_id: 'a1', strengths: [], weaknesses: [], quality_score: 5, keep: true }] };
    const llm = mockLLM(JSON.stringify(validReview));
    const ctx = makeCtx();
    ctx.promptTemplates.review = 'Review: {{context}}';

    const result = await runStage('review', ctx, {}, llm);
    expect(result.ok).toBe(true);
  });
});
