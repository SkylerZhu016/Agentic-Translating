/**
 * stage-route.test.ts — 集成测试: 阶段 SSE 路由 (Wave 3 Task 18)
 *
 * Covers:
 *   - 4 阶段 happy path → stage_complete + 落库 parsed_output
 *   - assemble → final_versions (version_no=max+1, source='assemble') + state→assembled
 *   - AC7: 重跑 filter → downstream orchestrate/assemble status='stale'
 *   - 前置缺失 → 409 stage_prerequisite_missing
 *   - 并发守卫 → 409 stage_already_running
 *   - schema 错误 → stage_schema_error SSE 事件
 *   - 非法 stage → 404
 *   - 非法 state → 409
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { type Repositories, createRepositories } from '../../src/lib/db/repositories';
import { parseSSEChunk } from '../../src/lib/contracts/sse';

// =============================================================================
// Setup
// =============================================================================

const MIGRATION_SQL = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/db/migrations/0001_init.sql'),
  'utf-8',
);

// Mock DB singleton
vi.mock('../../src/lib/db', () => ({
  getDb: vi.fn(),
}));

// Mock LLM client — pass through real exports, mock only chatCompletion
vi.mock('../../src/lib/llm/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm/client')>();
  return {
    ...actual,
    chatCompletion: vi.fn(),
  };
});

import { getDb } from '../../src/lib/db';
import { chatCompletion } from '../../src/lib/llm/client';
import { POST } from '../../app/api/sessions/[id]/stages/[stage]/run/route';
import type { ChatCompletionResponse, LLMStreamEvent } from '../../src/lib/llm/client';

// =============================================================================
// Test Helpers
// =============================================================================

/** Create a fresh :memory: DB, run migration, set as global singleton */
function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(MIGRATION_SQL);
  vi.mocked(getDb).mockReturnValue(db);
  return db;
}

interface SSEDecodedEvent {
  event: string;
  data: unknown;
}

/** Read all SSE events from a Response with ReadableStream body */
async function readSSE(response: Response): Promise<SSEDecodedEvent[]> {
  const body = response.body!;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  // Flush remaining
  buffer += decoder.decode();

  const parsed = parseSSEChunk(buffer);
  return parsed.map((e) => ({
    event: e.event,
    data: e.data ? JSON.parse(e.data) : {},
  }));
}

/** Seed endpoint, coordinator, agents, prompts into a fresh DB */
function seedConfig(repos: Repositories): void {
  repos.endpoints.insert({
    name: 'test-ep',
    base_url: 'https://mock.local',
    api_key: 'sk-test',
  });
  repos.coordinatorConfig.upsert({
    endpoint_id: 1,
    model: 'test-model',
    chat_endpoint_id: 1,
    chat_model: 'chat-test',
  });
  repos.translatorAgents.insert({
    name: 'agent-alpha',
    endpoint_id: 1,
    model: 'gpt-4',
    prompt_override: null,
    sort_order: 0,
  });
  for (const stage of ['review', 'filter', 'orchestrate', 'assemble'] as const) {
    repos.promptTemplates.insert({
      kind: stage,
      name: 'default',
      content: `${stage}: {{context}}`,
      is_builtin: 1,
    });
  }
  repos.promptTemplates.insert({
    kind: 'translator',
    name: 'default',
    content: 'Translate: {{source_text}}',
    is_builtin: 1,
  });
}

/** Seed a session in 'translated' state with one completed translation */
function seedSession(
  repos: Repositories,
  sessionId: string = 'sess-test-001',
  state: string = 'translated',
): string {
  repos.sessions.insert({
    id: sessionId,
    source_text: 'Hello world',
    source_lang: 'en',
    target_lang: 'zh',
    state,
    config_snapshot: JSON.stringify({
      endpoint: {
        id: 1,
        name: 'test-ep',
        base_url: 'https://mock.local',
        api_key: 'sk-test',
        created_at: '2025-01-01',
      },
      agents: [
        {
          id: 1,
          name: 'agent-alpha',
          endpoint_id: 1,
          model: 'gpt-4',
          prompt_override: null,
          sort_order: 0,
          created_at: '2025-01-01',
        },
      ],
      coordinator: {
        id: 1,
        endpoint_id: 1,
        model: 'test-model',
        chat_endpoint_id: 1,
        chat_model: 'chat-test',
        updated_at: '2025-01-01',
      },
      prompts: {
        translator: 'Translate: {{source_text}}',
        review: 'Review: {{context}}',
        filter: 'Filter: {{context}}',
        orchestrate: 'Orchestrate: {{context}}',
        assemble: 'Assemble: {{context}}',
      },
    }),
  });
  // Completed translation
  repos.translationResults.insert({
    session_id: sessionId,
    agent_key: 'agent-alpha',
    agent_snapshot: JSON.stringify({ name: 'Agent Alpha', model: 'gpt-4' }),
    status: 'complete',
    output_text: '你好世界',
    error: null,
    latency_ms: 100,
    attempt: 1,
  });
  return sessionId;
}

/** Seed a completed prerequisite stage output */
function seedStageOutput(
  repos: Repositories,
  sessionId: string,
  stage: string,
  status: string = 'complete',
  parsedOutput?: unknown,
): void {
  const existing = repos.stageOutputs.getBySessionAndStage(sessionId, stage as any);
  if (existing) {
    repos.stageOutputs.update({
      id: existing.id,
      status: status as any,
      prompt_used: 'test prompt',
      raw_output: 'test raw',
      parsed_output: parsedOutput != null ? JSON.stringify(parsedOutput) : null,
      error: null,
    });
  } else {
    repos.stageOutputs.insert({
      session_id: sessionId,
      stage: stage as any,
      status: status as any,
      prompt_used: 'test prompt',
      raw_output: 'test raw',
      parsed_output: parsedOutput != null ? JSON.stringify(parsedOutput) : null,
      error: null,
    });
  }
}

/** Build a mock non-streaming LLM response */
function mockLLMResponse(content: string): ChatCompletionResponse {
  return { content, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
}

/** Build a mock streaming LLM response (async iterable) */
async function* mockStreamResponse(content: string): AsyncIterable<LLMStreamEvent> {
  // Emit one character at a time like real stream
  for (let i = 0; i < content.length; i++) {
    yield { type: 'text', content: content[i] };
  }
  yield { type: 'done', content };
}

// Valid JSON fixtures for each stage
const VALID_REVIEW_JSON = JSON.stringify({
  assessments: [
    { agent_id: 'agent-alpha', strengths: ['good flow'], weaknesses: ['stiff'], quality_score: 7, keep: true },
  ],
});

const VALID_FILTER_JSON = JSON.stringify({
  selected_agent_ids: ['agent-alpha'],
  rejected_agent_ids: [],
  rationale: 'Best translation',
});

const VALID_ORCHESTRATE_JSON = JSON.stringify({
  structure_notes: 'Single segment',
  segment_assignments: [
    { segment_index: 0, source_agent_id: 'agent-alpha', source_segment: '你好世界', rationale: 'Only option' },
  ],
});

const VALID_ASSEMBLE_JSON = JSON.stringify({
  final_text: '你好世界',
  notes: 'Assembled from agent-alpha',
});

// =============================================================================
// Tests
// =============================================================================

describe('POST /api/sessions/[id]/stages/[stage]/run', () => {
  let db: Database.Database;
  let repos: Repositories;

  beforeEach(() => {
    db = setupDb();
    repos = createRepositories(db);
    seedConfig(repos);
    vi.mocked(chatCompletion).mockReset();
  });

  afterEach(() => {
    db.close();
  });

  // ===========================================================================
  // Happy paths
  // ===========================================================================

  describe('happy path — review', () => {
    it('returns stage_start → stage_complete → done, persists parsed_output', async () => {
      const sid = seedSession(repos);
      vi.mocked(chatCompletion).mockResolvedValue(mockLLMResponse(VALID_REVIEW_JSON));

      const req = new Request(`http://localhost/api/sessions/${sid}/stages/review/run`, {
        method: 'POST',
      });
      const res = await POST(req, { params: Promise.resolve({ id: sid, stage: 'review' }) });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const events = await readSSE(res);
      expect(events.length).toBeGreaterThanOrEqual(3);

      // First event: stage_start
      expect(events[0].event).toBe('stage_start');
      expect((events[0].data as any).stage).toBe('review');

      // Check stage_complete exists
      const completeEvent = events.find((e) => e.event === 'stage_complete');
      expect(completeEvent).toBeDefined();
      expect((completeEvent!.data as any).stage).toBe('review');
      expect((completeEvent!.data as any).parsed_output).toBeDefined();

      // Last event: done
      const lastEvent = events[events.length - 1];
      expect(lastEvent.event).toBe('done');

      // DB check: stage_outputs
      const saved = repos.stageOutputs.getBySessionAndStage(sid, 'review');
      expect(saved).toBeDefined();
      expect(saved!.status).toBe('complete');
      expect(saved!.parsed_output).toBeDefined();
      expect(JSON.parse(saved!.parsed_output!)).toHaveProperty('assessments');

      // Check session state transitioned to coordinating
      const session = repos.sessions.getById(sid);
      expect(session!.state).toBe('coordinating');
    });
  });

  describe('happy path — filter (stale cascade)', () => {
    it('marks downstream orchestrate/assemble as stale', async () => {
      const sid = seedSession(repos);

      // Pre-seed review as complete
      seedStageOutput(repos, sid, 'review', 'complete', { assessments: [] });

      // Pre-seed orchestrate and assemble as complete (to verify they go stale)
      seedStageOutput(repos, sid, 'orchestrate', 'complete', {});
      seedStageOutput(repos, sid, 'assemble', 'complete', {});

      vi.mocked(chatCompletion).mockResolvedValue(mockLLMResponse(VALID_FILTER_JSON));

      const req = new Request(`http://localhost/api/sessions/${sid}/stages/filter/run`, {
        method: 'POST',
      });
      const res = await POST(req, { params: Promise.resolve({ id: sid, stage: 'filter' }) });

      const events = await readSSE(res);
      const completeEvent = events.find((e) => e.event === 'stage_complete');
      expect(completeEvent).toBeDefined();
      expect((completeEvent!.data as any).stage).toBe('filter');

      // AC7: downstream should be stale
      const orchRow = repos.stageOutputs.getBySessionAndStage(sid, 'orchestrate');
      expect(orchRow!.status).toBe('stale');

      const asmRow = repos.stageOutputs.getBySessionAndStage(sid, 'assemble');
      expect(asmRow!.status).toBe('stale');
    });
  });

  describe('happy path — assemble (version generation)', () => {
    it('inserts final_version with version_no=max+1, source=assemble, state→assembled', async () => {
      const sid = seedSession(repos);

      // Pre-seed review, filter, orchestrate as complete
      seedStageOutput(repos, sid, 'review', 'complete', { assessments: [] });
      seedStageOutput(repos, sid, 'filter', 'complete', { selected_agent_ids: [] });
      seedStageOutput(repos, sid, 'orchestrate', 'complete', { segment_assignments: [] });

      vi.mocked(chatCompletion).mockResolvedValue(
        (async function* () {
          yield* mockStreamResponse(VALID_ASSEMBLE_JSON);
        })() as any,
      );

      const req = new Request(`http://localhost/api/sessions/${sid}/stages/assemble/run`, {
        method: 'POST',
      });
      const res = await POST(req, { params: Promise.resolve({ id: sid, stage: 'assemble' }) });

      const events = await readSSE(res);

      // Should have stage_delta events (streaming)
      const deltaEvents = events.filter((e) => e.event === 'stage_delta');
      expect(deltaEvents.length).toBeGreaterThan(0);

      // stage_complete
      const completeEvent = events.find((e) => e.event === 'stage_complete');
      expect(completeEvent).toBeDefined();
      expect((completeEvent!.data as any).stage).toBe('assemble');

      // DB: final_versions
      const latestVersion = repos.finalVersions.getLatestBySession(sid);
      expect(latestVersion).toBeDefined();
      expect(latestVersion!.version_no).toBe(1);
      expect(latestVersion!.source).toBe('assemble');
      expect(latestVersion!.text).toBe('你好世界');

      // DB: session state → assembled
      const session = repos.sessions.getById(sid);
      expect(session!.state).toBe('assembled');
    });

    it('creates version_no=2 when a previous version exists', async () => {
      const sid = seedSession(repos);

      seedStageOutput(repos, sid, 'review', 'complete', { assessments: [] });
      seedStageOutput(repos, sid, 'filter', 'complete', { selected_agent_ids: [] });
      seedStageOutput(repos, sid, 'orchestrate', 'complete', { segment_assignments: [] });

      // Pre-existing version_no=1
      repos.finalVersions.insert({
        session_id: sid,
        version_no: 1,
        text: '旧版本',
        source: 'edit',
      });

      // Session must be in coordinating state for assemble to transition
      repos.sessions.updateState('coordinating', sid);

      // Verify the pre-existing version is visible
      const preExisting = repos.finalVersions.getLatestBySession(sid);
      expect(preExisting).toBeDefined();
      expect(preExisting!.version_no).toBe(1);

      vi.mocked(chatCompletion).mockResolvedValue(
        (async function* () {
          yield* mockStreamResponse(JSON.stringify({ final_text: '新版本你好世界', notes: 'assembled' }));
        })() as any,
      );

      const req = new Request(`http://localhost/api/sessions/${sid}/stages/assemble/run`, {
        method: 'POST',
      });
      const res = await POST(req, { params: Promise.resolve({ id: sid, stage: 'assemble' }) });

      // Read SSE to ensure processing completed
      const events = await readSSE(res);
      const completeEvent = events.find((e) => e.event === 'stage_complete');
      expect(completeEvent).toBeDefined();

      const latestVersion = repos.finalVersions.getLatestBySession(sid);
      expect(latestVersion).toBeDefined();
      expect(latestVersion!.version_no).toBe(2);
      expect(latestVersion!.source).toBe('assemble');
      expect(latestVersion!.text).toBe('新版本你好世界');
    });
  });

  // ===========================================================================
  // Negative cases
  // ===========================================================================

  describe('validation guards', () => {
    it('returns 404 for invalid stage', async () => {
      const sid = seedSession(repos);
      const req = new Request(`http://localhost/api/sessions/${sid}/stages/bogus/run`, {
        method: 'POST',
      });
      const res = await POST(req, { params: Promise.resolve({ id: sid, stage: 'bogus' }) });
      expect(res.status).toBe(404);
    });

    it('returns 404 for non-existent session', async () => {
      const req = new Request('http://localhost/api/sessions/nonexistent/stages/review/run', {
        method: 'POST',
      });
      const res = await POST(req, {
        params: Promise.resolve({ id: 'nonexistent', stage: 'review' }),
      });
      expect(res.status).toBe(404);
    });

    it('returns 409 for invalid session state (draft)', async () => {
      const sid = seedSession(repos, 'sess-draft', 'draft');
      const req = new Request(`http://localhost/api/sessions/${sid}/stages/review/run`, {
        method: 'POST',
      });
      const res = await POST(req, { params: Promise.resolve({ id: sid, stage: 'review' }) });
      expect(res.status).toBe(409);
    });
  });

  // ===========================================================================
  // Prerequisite guard
  // ===========================================================================

  describe('prerequisite guard', () => {
    it('returns 409 with missing stages when prerequisite not complete', async () => {
      const sid = seedSession(repos);
      // No review seeded → filter should fail

      const req = new Request(`http://localhost/api/sessions/${sid}/stages/filter/run`, {
        method: 'POST',
      });
      const res = await POST(req, { params: Promise.resolve({ id: sid, stage: 'filter' }) });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toContain('Prerequisite');
      expect(body.missing).toContain('review');
    });

    it('allows filter when review is complete', async () => {
      const sid = seedSession(repos);
      seedStageOutput(repos, sid, 'review', 'complete', { assessments: [] });
      vi.mocked(chatCompletion).mockResolvedValue(mockLLMResponse(VALID_FILTER_JSON));

      const req = new Request(`http://localhost/api/sessions/${sid}/stages/filter/run`, {
        method: 'POST',
      });
      const res = await POST(req, { params: Promise.resolve({ id: sid, stage: 'filter' }) });

      expect(res.status).toBe(200);
    });
  });

  // ===========================================================================
  // Concurrency guard
  // ===========================================================================

  describe('concurrency guard', () => {
    it('returns 409 when another stage is already running', async () => {
      const sid = seedSession(repos);
      // Seed review as complete (prerequisite for filter)
      seedStageOutput(repos, sid, 'review', 'complete', { assessments: [] });

      // Mark orchestrate as running (not related to filter's prerequisite)
      seedStageOutput(repos, sid, 'orchestrate', 'running');

      const req = new Request(`http://localhost/api/sessions/${sid}/stages/filter/run`, {
        method: 'POST',
      });
      const res = await POST(req, {
        params: Promise.resolve({ id: sid, stage: 'filter' }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toContain('already running');
    });
  });

  // ===========================================================================
  // Schema error
  // ===========================================================================

  describe('schema error', () => {
    it('emits stage_schema_error SSE event for malformed JSON', async () => {
      const sid = seedSession(repos);
      // Both LLM calls return malformed JSON
      vi.mocked(chatCompletion)
        .mockResolvedValueOnce(mockLLMResponse(JSON.stringify({ wrong: 'field' })))
        .mockResolvedValueOnce(mockLLMResponse(JSON.stringify({ also: 'wrong' })));

      const req = new Request(`http://localhost/api/sessions/${sid}/stages/review/run`, {
        method: 'POST',
      });
      const res = await POST(req, { params: Promise.resolve({ id: sid, stage: 'review' }) });

      const events = await readSSE(res);

      // Should have at least one stage_schema_error
      const schemaErrorEvents = events.filter((e) => e.event === 'stage_schema_error');
      expect(schemaErrorEvents.length).toBeGreaterThan(0);

      // First schema error during retry
      const firstSchemaErr = schemaErrorEvents[0];
      expect((firstSchemaErr.data as any).stage).toBe('review');
      expect((firstSchemaErr.data as any).zodError).toBeDefined();
      expect((firstSchemaErr.data as any).attempt).toBe(1);

      // DB: status should be 'failed'
      const saved = repos.stageOutputs.getBySessionAndStage(sid, 'review');
      expect(saved!.status).toBe('failed');
    });
  });

  // ===========================================================================
  // Orchestrate streaming
  // ===========================================================================

  describe('orchestrate streaming', () => {
    it('emits stage_delta events for streaming stage', async () => {
      const sid = seedSession(repos);
      seedStageOutput(repos, sid, 'review', 'complete', { assessments: [] });
      seedStageOutput(repos, sid, 'filter', 'complete', {
        selected_agent_ids: ['agent-alpha'],
        rejected_agent_ids: [],
        rationale: 'ok',
      });

      vi.mocked(chatCompletion).mockResolvedValue(
        (async function* () {
          yield* mockStreamResponse(VALID_ORCHESTRATE_JSON);
        })() as any,
      );

      const req = new Request(
        `http://localhost/api/sessions/${sid}/stages/orchestrate/run`,
        { method: 'POST' },
      );
      const res = await POST(req, {
        params: Promise.resolve({ id: sid, stage: 'orchestrate' }),
      });

      const events = await readSSE(res);

      // Should have delta events
      const deltaEvents = events.filter((e) => e.event === 'stage_delta');
      expect(deltaEvents.length).toBeGreaterThan(0);

      // Each delta has stage and content
      for (const d of deltaEvents) {
        expect((d.data as any).stage).toBe('orchestrate');
        expect(typeof (d.data as any).content).toBe('string');
      }
    });
  });

  // ===========================================================================
  // Stale cascade — AC7 full verification
  // ===========================================================================

  describe('AC7 — stale cascade full flow', () => {
    it('re-running filter after full pipeline → orchestrate/assemble stale, not pending', async () => {
      const sid = seedSession(repos);

      // Full pipeline complete
      seedStageOutput(repos, sid, 'review', 'complete', { assessments: [] });
      seedStageOutput(repos, sid, 'filter', 'complete', {
        selected_agent_ids: ['agent-alpha'],
        rejected_agent_ids: [],
        rationale: 'best',
      });
      seedStageOutput(repos, sid, 'orchestrate', 'complete', {
        structure_notes: 'ok',
        segment_assignments: [],
      });
      seedStageOutput(repos, sid, 'assemble', 'complete', { final_text: 'hello' });

      // Session in assembled state (valid for re-running)
      repos.sessions.updateState('assembled', sid);

      // Verify initial state before running
      expect(repos.stageOutputs.getBySessionAndStage(sid, 'orchestrate')!.status).toBe('complete');
      expect(repos.stageOutputs.getBySessionAndStage(sid, 'assemble')!.status).toBe('complete');

      // Re-run filter
      vi.mocked(chatCompletion).mockResolvedValue(mockLLMResponse(VALID_FILTER_JSON));

      const req = new Request(`http://localhost/api/sessions/${sid}/stages/filter/run`, {
        method: 'POST',
      });
      const res = await POST(req, { params: Promise.resolve({ id: sid, stage: 'filter' }) });

      // Read SSE to ensure processing completed
      const events = await readSSE(res);
      const completeEvent = events.find((e) => e.event === 'stage_complete');
      expect(completeEvent).toBeDefined();
      expect((completeEvent!.data as any).stage).toBe('filter');

      // Verify LLM was called
      expect(vi.mocked(chatCompletion)).toHaveBeenCalled();

      // Verify downstream stale
      const orch = repos.stageOutputs.getBySessionAndStage(sid, 'orchestrate');
      expect(orch!.status).toBe('stale');

      const asm = repos.stageOutputs.getBySessionAndStage(sid, 'assemble');
      expect(asm!.status).toBe('stale');

      // Review should remain complete (upstream, not affected)
      const rev = repos.stageOutputs.getBySessionAndStage(sid, 'review');
      expect(rev!.status).toBe('complete');
    });

    it('re-running review → all downstream stale', async () => {
      const sid = seedSession(repos);

      seedStageOutput(repos, sid, 'review', 'complete', { assessments: [] });
      seedStageOutput(repos, sid, 'filter', 'complete', {
        selected_agent_ids: ['agent-alpha'],
        rejected_agent_ids: [],
        rationale: 'best',
      });
      seedStageOutput(repos, sid, 'orchestrate', 'complete', {
        structure_notes: 'ok',
        segment_assignments: [],
      });
      seedStageOutput(repos, sid, 'assemble', 'complete', { final_text: 'hello' });

      repos.sessions.updateState('assembled', sid);

      vi.mocked(chatCompletion).mockResolvedValue(mockLLMResponse(VALID_REVIEW_JSON));

      const req = new Request(`http://localhost/api/sessions/${sid}/stages/review/run`, {
        method: 'POST',
      });
      const res = await POST(req, { params: Promise.resolve({ id: sid, stage: 'review' }) });

      // Read SSE to ensure processing completed
      const events = await readSSE(res);
      const completeEvent = events.find((e) => e.event === 'stage_complete');
      expect(completeEvent).toBeDefined();
      expect((completeEvent!.data as any).stage).toBe('review');

      // All downstream stale
      expect(repos.stageOutputs.getBySessionAndStage(sid, 'filter')!.status).toBe('stale');
      expect(repos.stageOutputs.getBySessionAndStage(sid, 'orchestrate')!.status).toBe('stale');
      expect(repos.stageOutputs.getBySessionAndStage(sid, 'assemble')!.status).toBe('stale');

      // Review itself should be complete again
      expect(repos.stageOutputs.getBySessionAndStage(sid, 'review')!.status).toBe('complete');
    });
  });
});
