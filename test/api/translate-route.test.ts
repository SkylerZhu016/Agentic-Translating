// ---------------------------------------------------------------------------
// Wave 3 Task 17 — Integration tests for translate + retry SSE routes
// ---------------------------------------------------------------------------
// Uses :memory: DB, mock LLM (chatCompletion), and SSE event assertion.
// Covers:
//   - C1 event sequence validation
//   - Mixed success/error agent results → correct DB persistence
//   - Invalid state transition → 409
//   - Single-agent retry → only specified agent_key updated
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { createRepositories, type Repositories } from '../../src/lib/db/repositories';
import { createSessionService } from '../../src/lib/services/session-service';
import { parseSSEChunk, type SSEEvent } from '../../src/lib/contracts/sse';
import type { LLMStreamEvent } from '../../src/lib/llm/client';
import type { ConfigSnapshot } from '../../src/lib/contracts/types';
import type { ConfigSnapshotVNext, ModelBinding } from '../../src/lib/contracts/vnext';
import { encryptSecret } from '../../src/lib/security/secrets';

// ── Hoisted mocks (must be defined before vi.mock which is hoisted) ────────
const { mockChatCompletion, mockGetDb } = vi.hoisted(() => ({
  mockChatCompletion: vi.fn<
    (
      endpoint: { baseUrl: string; apiKey: string },
      request: { model: string; messages: Array<{ role: string; content: string }>; stream?: boolean },
    ) => Promise<AsyncIterable<LLMStreamEvent>>
  >(),
  mockGetDb: vi.fn<() => Database.Database>(),
}));

vi.mock('@/src/lib/llm/client', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/lib/llm/client')>();
  return { ...mod, chatCompletion: mockChatCompletion };
});

vi.mock('@/src/lib/db', () => ({
  getDb: mockGetDb,
}));

// ── Route handlers (imported AFTER mocks are set up) ───────────────────────
import { POST as translatePost } from '../../app/api/sessions/[id]/translate/route';
import { POST as retryPost } from '../../app/api/sessions/[id]/agents/[agentKey]/retry/route';
import { createHandlers as createSessionDetailHandlers } from '../../app/api/sessions/[id]/handlers';

// ── Migration SQL ──────────────────────────────────────────────────────────
const MIGRATION_SQL_0001 = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/db/migrations/0001_init.sql'),
  'utf-8',
);
const MIGRATION_SQL_0002 = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/db/migrations/0002_presets_and_drop_parsed_output.sql'),
  'utf-8',
);

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build an async generator that yields one char at a time, then done. */
async function* mockStream(content: string): AsyncIterable<LLMStreamEvent> {
  for (const char of content) {
    yield { type: 'text', content: char };
    // Yield to event loop so parallel fan-out agents can interleave
    await new Promise((r) => setTimeout(r, 0));
  }
  yield { type: 'done', content };
}

/** Collect SSE events from a Response body. */
async function collectSSEEvents(response: Response): Promise<SSEEvent[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  return parseSSEChunk(buffer);
}

/** Helper to extract data objects from a series of SSE events by event name. */
function eventsByName(events: SSEEvent[], name: string): unknown[] {
  return events
    .filter((e) => e.event === name)
    .map((e) => {
      try {
        return JSON.parse(e.data);
      } catch {
        return e.data;
      }
    });
}

/** Create a mock Request with optional body for POST routes. */
function mockPostRequest(sessionId: string, agentKey?: string): Request {
  const url = agentKey
    ? `http://localhost/api/sessions/${sessionId}/agents/${agentKey}/retry`
    : `http://localhost/api/sessions/${sessionId}/translate`;
  return new Request(url, { method: 'POST' });
}

// ── Suite ──────────────────────────────────────────────────────────────────

describe('Translate SSE Route (fanout + retry)', () => {
  let db: Database.Database;
  let repos: Repositories;
  let service: ReturnType<typeof createSessionService>;

  const DEF_SOURCE = {
    sourceText: 'Hello world',
    sourceLang: 'English',
    targetLang: 'Chinese',
  };

  function createV3Session() {
    const session = service.createSession(DEF_SOURCE);
    const legacy = JSON.parse(session.config_snapshot) as ConfigSnapshot;
    const endpoints = legacy.endpoints ?? (legacy.endpoint ? [legacy.endpoint] : []);
    const firstAgent = legacy.agents[0];
    const defaultWorker: ModelBinding = {
      endpointId: firstAgent?.endpoint_id ?? null,
      model: firstAgent?.model ?? '',
      maxOutputTokens: 4_096,
    };
    const mainAgent: ModelBinding = {
      endpointId: legacy.coordinator?.endpoint_id ?? defaultWorker.endpointId,
      model: legacy.coordinator?.model ?? defaultWorker.model,
      maxOutputTokens: 4_096,
    };
    const editingAgent: ModelBinding = {
      endpointId:
        legacy.coordinator?.chat_endpoint_id ?? mainAgent.endpointId,
      model: legacy.coordinator?.chat_model ?? mainAgent.model,
      maxOutputTokens: 4_096,
    };
    const modern: ConfigSnapshot & ConfigSnapshotVNext = {
      ...legacy,
      version: 3,
      direction: 'en_to_zh',
      promptBundleSnapshot: {
        direction: 'en_to_zh',
        promptLanguage: 'zh',
        mainAgentSystemPrompt: '统筹翻译。',
        workerBasePrompt: legacy.prompts.translator ?? '翻译原文。',
        reviewPrompt: legacy.prompts.review ?? '审查译文。',
        filterPrompt: legacy.prompts.filter ?? '筛选译文。',
        orchestratePrompt: legacy.prompts.orchestrate ?? '统筹译文。',
        assemblePrompt: legacy.prompts.assemble ?? '组装译文。',
        editingPrompt: '编辑译文。',
        toolDescriptions: {},
        version: 1,
      },
      agentVariantSnapshots: legacy.agents.map((agent, index) => ({
        id: agent.name,
        archetypeId: `fixture-${index + 1}`,
        direction: 'en_to_zh' as const,
        catalogName: agent.name,
        catalogDescription: 'Route test translator',
        rolePrompt: agent.prompt_override ?? 'Translate faithfully.',
        promptLanguage: 'zh' as const,
        promptVersion: 1,
        enabled: true,
        endpointOverrideId: agent.endpoint_id,
        modelOverride: agent.model,
        sortOrder: agent.sort_order,
      })),
      endpointSnapshots: endpoints.map((endpoint) => ({
        id: endpoint.id,
        name: endpoint.name,
        baseUrl: endpoint.base_url,
        chatCompletionsPath:
          endpoint.chat_completions_path ?? '/v1/chat/completions',
        apiKey: encryptSecret(endpoint.api_key),
        hasApiKey: Boolean(endpoint.api_key),
        contextWindow: endpoint.context_window ?? 32_768,
      })),
      modelBindings: {
        defaultWorker,
        mainAgent,
        reviewAgent: mainAgent,
        filterAgent: mainAgent,
        orchestrateAgent: mainAgent,
        assembleAgent: mainAgent,
        editingAgent,
      },
      presetRevisionSnapshot: null,
      taskBrief: '',
      constraints: {},
      orchestrationPolicy: {
        teamPolicy: 'fixed',
        reviewMode: 'main_editor',
        maxAgentCalls: Math.max(1, legacy.agents.length),
        candidateAnnotationMode: 'body_only',
      },
    };
    db.prepare(
      'UPDATE sessions SET config_snapshot = ? WHERE id = ?',
    ).run(JSON.stringify(modern), session.id);
    return session;
  }

  function inflateLegacyTranslatorPrompt(sessionId: string): void {
    const stored = repos.sessions.getById(sessionId)!;
    const snapshot = JSON.parse(stored.config_snapshot) as ConfigSnapshot;
    db.prepare(
      'UPDATE sessions SET config_snapshot = ? WHERE id = ?',
    ).run(
      JSON.stringify({
        ...snapshot,
        prompts: {
          ...snapshot.prompts,
          translator: `Translate: ${'PRIVATE-PROMPT'.repeat(12_000)}`,
        },
      }),
      sessionId,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(MIGRATION_SQL_0001); db.exec(MIGRATION_SQL_0002);

    mockGetDb.mockReturnValue(db);

    repos = createRepositories(db);
    service = createSessionService(db, repos);

    // ── Seed config ─────────────────────────────────────────────
    repos.endpoints.insert({
      name: 'test-ep',
      base_url: 'https://api.test.com',
      api_key: 'sk-test',
    });
    repos.coordinatorConfig.upsert({
      endpoint_id: 1,
      model: 'gpt-4',
      chat_endpoint_id: 1,
      chat_model: 'gpt-4-chat',
    });
    repos.translatorAgents.insert({
      name: 'agent-alpha',
      endpoint_id: 1,
      model: 'gpt-4',
      prompt_override: null,
      sort_order: 0,
    });
    repos.translatorAgents.insert({
      name: 'agent-beta',
      endpoint_id: 1,
      model: 'claude-3',
      prompt_override: null,
      sort_order: 1,
    });
    repos.promptTemplates.insert({
      kind: 'translator',
      name: 'default',
      content: 'Translate from {{source_lang}} to {{target_lang}}: {{source_text}}',
      is_builtin: 1,
    });
    repos.promptTemplates.insert({
      kind: 'review',
      name: 'default',
      content: 'Review this translation',
      is_builtin: 1,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  // =========================================================================
  // TRANSLATE ROUTE
  // =========================================================================

  describe('POST /api/sessions/[id]/translate', () => {
    it('returns stable 422 for a legacy v2 snapshot', async () => {
      const session = service.createSession(DEF_SOURCE);
      const response = await translatePost(mockPostRequest(session.id), {
        params: Promise.resolve({ id: session.id }),
      });

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual(expect.objectContaining({
        error: 'preflight_snapshot_upgrade_required',
        params: { snapshotVersion: 2 },
      }));
      expect(mockChatCompletion).not.toHaveBeenCalled();
    });

    it('blocks the exact physical fanout request before provider I/O', async () => {
      const session = createV3Session();
      inflateLegacyTranslatorPrompt(session.id);

      const response = await translatePost(mockPostRequest(session.id), {
        params: Promise.resolve({ id: session.id }),
      });
      const events = await collectSSEEvents(response);

      expect(response.status).toBe(200);
      expect(eventsByName(events, 'agent_error')).toHaveLength(2);
      expect(mockChatCompletion).not.toHaveBeenCalled();
    });

    it('emits full C1 event sequence on success (2 agents)', async () => {
      // Arrange: both agents succeed
      mockChatCompletion.mockImplementation(async (_ep, _req) => {
        return mockStream('translated text');
      });

      const session = createV3Session();
      const req = mockPostRequest(session.id);

      // Act
      const response = await translatePost(req, {
        params: Promise.resolve({ id: session.id }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/event-stream');

      const events = await collectSSEEvents(response);

      // Assert: C1 event sequence
      const agentStarts = eventsByName(events, 'agent_start');
      expect(agentStarts).toHaveLength(2);
      const agentKeys = agentStarts.map((s: any) => s.agent_key).sort();
      expect(agentKeys).toEqual(['agent-alpha', 'agent-beta']);

      // Token events exist (interleaved from parallel agents)
      const tokens = eventsByName(events, 'token');
      expect(tokens.length).toBeGreaterThan(0);
      const tokenAgentKeys = new Set(tokens.map((t: any) => t.agent_key));
      expect(tokenAgentKeys.has('agent-alpha') || tokenAgentKeys.has('agent-beta')).toBe(true);

      // Agent complete events
      const completes = eventsByName(events, 'agent_complete');
      expect(completes).toHaveLength(2);
      for (const c of completes as any[]) {
        expect(c.status).toBe('complete');
        expect(c.content).toBe('translated text');
      }

      // fanout_complete + done
      const fanoutComplete = eventsByName(events, 'fanout_complete');
      expect(fanoutComplete).toHaveLength(1);
      expect((fanoutComplete[0] as any).succeeded).toBe(2);
      expect((fanoutComplete[0] as any).failed).toBe(0);

      const doneEvents = eventsByName(events, 'done');
      expect(doneEvents).toHaveLength(1);

      // Done is last event
      const lastEvent = events[events.length - 1];
      expect(lastEvent.event).toBe('done');
    });

    it('persists translation_results as complete in DB', async () => {
      mockChatCompletion.mockImplementation(async () => mockStream('你好世界'));

      const session = createV3Session();
      const req = mockPostRequest(session.id);

      const response = await translatePost(req, {
        params: Promise.resolve({ id: session.id }),
      });
      await collectSSEEvents(response); // consume stream

      const results = repos.translationResults.listBySession(session.id);
      expect(results).toHaveLength(2);
      for (const r of results) {
        expect(r.status).toBe('complete');
        expect(r.output_text).toBe('你好世界');
        expect(r.error).toBeNull();
        expect(r.latency_ms).toBeGreaterThan(0);
        expect(r.attempt).toBe(1);
      }
    });

    it('handles 1 mock error agent with status=error, rest complete', async () => {
      const sensitiveProviderError =
        'Bearer sk-provider-secret https://provider.private/v1 leaked Hello world and Translate from prompt';
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      let callCount = 0;
      mockChatCompletion.mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          // Second agent errors (non-retryable)
          throw new Error(sensitiveProviderError);
        }
        return mockStream('success text');
      });

      const session = createV3Session();
      const req = mockPostRequest(session.id);

      const response = await translatePost(req, {
        params: Promise.resolve({ id: session.id }),
      });
      const events = await collectSSEEvents(response);

      // agent_start × 2
      const starts = eventsByName(events, 'agent_start');
      expect(starts).toHaveLength(2);

      // agent_complete × 1, agent_error × 1
      const completes = eventsByName(events, 'agent_complete');
      expect(completes).toHaveLength(1);

      const errors = eventsByName(events, 'agent_error');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toEqual(
        expect.objectContaining({
          code: 'translation_agent_failed',
          error: '翻译 Agent 调用失败，请稍后重试。',
          message: '翻译 Agent 调用失败，请稍后重试。',
          diagnosticId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          ),
        }),
      );

      // fanout_complete shows 1 succeeded, 1 failed
      const fanout = eventsByName(events, 'fanout_complete')[0] as any;
      expect(fanout.succeeded).toBe(1);
      expect(fanout.failed).toBe(1);

      // done
      expect(eventsByName(events, 'done')).toHaveLength(1);

      // DB: first agent complete, second error
      const dbResults = repos.translationResults.listBySession(session.id);
      const alpha = dbResults.find((r) => r.agent_key === 'agent-alpha')!;
      expect(alpha.status).toBe('complete');
      expect(alpha.output_text).toBe('success text');

      const beta = dbResults.find((r) => r.agent_key === 'agent-beta')!;
      expect(beta.status).toBe('error');
      const persistedError = JSON.parse(beta.error!) as Record<string, string>;
      expect(persistedError).toEqual({
        error: 'translation_agent_failed',
        message: '翻译 Agent 调用失败，请稍后重试。',
        diagnosticId: (errors[0] as any).diagnosticId,
      });

      const detailResponse = await createSessionDetailHandlers(db).GET(
        new NextRequest(`http://localhost/api/sessions/${session.id}`),
        { params: Promise.resolve({ id: session.id }) },
      );
      const detail = await detailResponse.json();
      const publicBeta = detail.results.find(
        (result: { agent_key: string }) => result.agent_key === 'agent-beta',
      );
      expect(publicBeta).toEqual(
        expect.objectContaining({
          error: persistedError.message,
          errorDiagnostic: persistedError,
        }),
      );

      const exposed = JSON.stringify({
        events,
        dbResults,
        detail: { results: detail.results, stages: detail.stages },
        diagnostics: consoleError.mock.calls,
      });
      for (const sensitive of [
        sensitiveProviderError,
        'sk-provider-secret',
        'https://provider.private/v1',
        'Hello world',
        'Translate from prompt',
      ]) {
        expect(exposed).not.toContain(sensitive);
      }
      expect(JSON.stringify(consoleError.mock.calls)).toContain(
        persistedError.diagnosticId,
      );
    });

    it('returns 404 for non-existent session', async () => {
      const req = mockPostRequest('nonexistent-id');

      const response = await translatePost(req, {
        params: Promise.resolve({ id: 'nonexistent-id' }),
      });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Session not found');
    });

    it('returns 409 when state is coordinating (invalid_state_transition)', async () => {
      const session = createV3Session();
      // Transition to translated first, then coordinating
      service.transitionState(session.id, 'translating');
      service.transitionState(session.id, 'translated');
      service.transitionState(session.id, 'coordinating');

      const req = mockPostRequest(session.id);
      const response = await translatePost(req, {
        params: Promise.resolve({ id: session.id }),
      });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.code).toBe('invalid_state_transition');
      expect(body.error).toContain('coordinating');
    });

    it('allows re-translate from translated state', async () => {
      mockChatCompletion.mockImplementation(async () => mockStream('re-translated'));

      const session = createV3Session();
      // Transition to translated first
      service.transitionState(session.id, 'translating');
      service.transitionState(session.id, 'translated');

      const req = mockPostRequest(session.id);
      const response = await translatePost(req, {
        params: Promise.resolve({ id: session.id }),
      });

      expect(response.status).toBe(200);
      const events = await collectSSEEvents(response);
      expect(eventsByName(events, 'agent_complete')).toHaveLength(2);

      // State should still be translated (re-translated)
      const updated = repos.sessions.getById(session.id)!;
      expect(updated.state).toBe('translated');
    });

    it('transitions session state from draft to translated', async () => {
      mockChatCompletion.mockImplementation(async () => mockStream('done'));

      const session = createV3Session();
      expect(session.state).toBe('draft');

      const req = mockPostRequest(session.id);
      const response = await translatePost(req, {
        params: Promise.resolve({ id: session.id }),
      });
      await collectSSEEvents(response);

      const updated = repos.sessions.getById(session.id)!;
      expect(updated.state).toBe('translated');
    });

    it('propagates abort signal via ReadableStream cancel', async () => {
      // LLM mock that produces tokens and checks signal.aborted
      let aborted = false;
      mockChatCompletion.mockImplementation(async (_ep, req) => {
        const signal = (req as { signal?: AbortSignal }).signal;
        async function* stuckStream(): AsyncIterable<LLMStreamEvent> {
          try {
            while (!signal?.aborted) {
              yield { type: 'text', content: 'x' };
              await new Promise((r) => setTimeout(r, 10));
            }
            // Signal triggered abort
            aborted = true;
            return;
          } catch {
            aborted = true;
          }
        }
        return stuckStream();
      });

      const session = createV3Session();
      const req = mockPostRequest(session.id);

      const response = await translatePost(req, {
        params: Promise.resolve({ id: session.id }),
      });

      // Start consuming but cancel after a few tokens
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      // Read first few chunks
      let totalRead = 0;
      while (totalRead < 3) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text.includes('token')) totalRead++;
      }

      // Cancel the stream (simulates client disconnect)
      await reader.cancel();

      // Small wait for abort to propagate
      await new Promise((r) => setTimeout(r, 100));
      expect(aborted).toBe(true);
    });

    it('returns 422 when the v3 snapshot has no candidate binding', async () => {
      // Delete all agents before creating session, or manipulate snapshot
      const session = createV3Session();

      // Keep a complete v3 snapshot while removing the legacy route agents.
      const stored = repos.sessions.getById(session.id)!;
      const snapshot = JSON.parse(stored.config_snapshot) as ConfigSnapshot;
      db.prepare(
        "UPDATE sessions SET config_snapshot = ? WHERE id = ?",
      ).run(
        JSON.stringify({
          ...snapshot,
          agents: [],
          agentVariantSnapshots: [],
        }),
        session.id,
      );

      const req = mockPostRequest(session.id);
      const response = await translatePost(req, {
        params: Promise.resolve({ id: session.id }),
      });

      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body.error).toBe('preflight_binding_missing');
      expect(mockChatCompletion).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // RETRY ROUTE
  // =========================================================================

  describe('POST /api/sessions/[id]/agents/[agentKey]/retry', () => {
    it('returns stable 422 for a legacy v2 snapshot', async () => {
      const session = service.createSession(DEF_SOURCE);
      const response = await retryPost(
        mockPostRequest(session.id, 'agent-alpha'),
        {
          params: Promise.resolve({
            id: session.id,
            agentKey: 'agent-alpha',
          }),
        },
      );

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual(expect.objectContaining({
        error: 'preflight_snapshot_upgrade_required',
        params: { snapshotVersion: 2 },
      }));
      expect(mockChatCompletion).not.toHaveBeenCalled();
    });

    it('blocks the exact physical retry request before provider I/O', async () => {
      const session = createV3Session();
      inflateLegacyTranslatorPrompt(session.id);

      const response = await retryPost(
        mockPostRequest(session.id, 'agent-alpha'),
        {
          params: Promise.resolve({
            id: session.id,
            agentKey: 'agent-alpha',
          }),
        },
      );
      const events = await collectSSEEvents(response);

      expect(response.status).toBe(200);
      expect(eventsByName(events, 'agent_error')).toHaveLength(1);
      expect(mockChatCompletion).not.toHaveBeenCalled();
    });

    it('retries only the specified agent_key', async () => {
      mockChatCompletion.mockImplementation(async () => mockStream('retry result'));

      const session = createV3Session();
      service.transitionState(session.id, 'translating');
      service.transitionState(session.id, 'translated');

      // Set both results to complete with different content first
      const alphaRow = repos.translationResults.getBySessionAndAgent(
        session.id,
        'agent-alpha',
      )!;
      const betaRow = repos.translationResults.getBySessionAndAgent(
        session.id,
        'agent-beta',
      )!;
      repos.translationResults.update({
        id: alphaRow.id, status: 'complete', output_text: 'alpha old',
        error: null, latency_ms: 100, attempt: 1,
      });
      repos.translationResults.update({
        id: betaRow.id, status: 'complete', output_text: 'beta old',
        error: null, latency_ms: 100, attempt: 1,
      });

      // Retry agent-alpha only
      const req = mockPostRequest(session.id, 'agent-alpha');
      const response = await retryPost(req, {
        params: Promise.resolve({ id: session.id, agentKey: 'agent-alpha' }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/event-stream');

      const events = await collectSSEEvents(response);

      // Only 1 agent_start (agent-alpha)
      const starts = eventsByName(events, 'agent_start');
      expect(starts).toHaveLength(1);
      expect((starts[0] as any).agent_key).toBe('agent-alpha');

      // Only 1 agent_complete
      const completes = eventsByName(events, 'agent_complete');
      expect(completes).toHaveLength(1);
      expect((completes[0] as any).agent_key).toBe('agent-alpha');

      // fanout_complete → succeeded=1, failed=0
      const fanout = eventsByName(events, 'fanout_complete')[0] as any;
      expect(fanout.succeeded).toBe(1);
      expect(fanout.failed).toBe(0);

      // done
      expect(eventsByName(events, 'done')).toHaveLength(1);

      // DB: only agent-alpha updated; agent-beta untouched
      const results = repos.translationResults.listBySession(session.id);
      const alpha = results.find((r) => r.agent_key === 'agent-alpha')!;
      expect(alpha.status).toBe('complete');
      expect(alpha.output_text).toBe('retry result');
      expect(alpha.attempt).toBe(2); // incremented from 1

      const beta = results.find((r) => r.agent_key === 'agent-beta')!;
      expect(beta.status).toBe('complete');
      expect(beta.output_text).toBe('beta old'); // untouched
      expect(beta.attempt).toBe(1);
    });

    it('returns 400 when agent_key not in snapshot', async () => {
      const session = createV3Session();

      const req = mockPostRequest(session.id, 'nonexistent-agent');
      const response = await retryPost(req, {
        params: Promise.resolve({
          id: session.id,
          agentKey: 'nonexistent-agent',
        }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('not found');
    });

    it('returns 409 from coordinating state', async () => {
      const session = createV3Session();
      service.transitionState(session.id, 'translating');
      service.transitionState(session.id, 'translated');
      service.transitionState(session.id, 'coordinating');

      const req = mockPostRequest(session.id, 'agent-alpha');
      const response = await retryPost(req, {
        params: Promise.resolve({
          id: session.id,
          agentKey: 'agent-alpha',
        }),
      });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.code).toBe('invalid_state_transition');
    });

    it('returns 404 for non-existent session', async () => {
      const req = mockPostRequest('no-such-session', 'agent-alpha');
      const response = await retryPost(req, {
        params: Promise.resolve({
          id: 'no-such-session',
          agentKey: 'agent-alpha',
        }),
      });

      expect(response.status).toBe(404);
    });

    it('handles retry agent error and updates DB as error', async () => {
      const sensitiveProviderError =
        'sk-retry-secret https://retry.private/v1 leaked Hello world and translator prompt';
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockChatCompletion.mockImplementation(async () => {
        throw new Error(sensitiveProviderError);
      });

      const session = createV3Session();

      const req = mockPostRequest(session.id, 'agent-alpha');
      const response = await retryPost(req, {
        params: Promise.resolve({ id: session.id, agentKey: 'agent-alpha' }),
      });
      const events = await collectSSEEvents(response);

      // agent_error emitted
      const errors = eventsByName(events, 'agent_error');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toEqual(
        expect.objectContaining({
          code: 'translation_retry_failed',
          error: '翻译 Agent 重试失败，请稍后重试。',
          message: '翻译 Agent 重试失败，请稍后重试。',
          diagnosticId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          ),
        }),
      );

      // fanout_complete: succeeded=0, failed=1
      const fanout = eventsByName(events, 'fanout_complete')[0] as any;
      expect(fanout.succeeded).toBe(0);
      expect(fanout.failed).toBe(1);

      // DB: agent-alpha is error
      const results = repos.translationResults.listBySession(session.id);
      const alpha = results.find((r) => r.agent_key === 'agent-alpha')!;
      expect(alpha.status).toBe('error');
      const persistedError = JSON.parse(alpha.error!) as Record<string, string>;
      expect(persistedError).toEqual({
        error: 'translation_retry_failed',
        message: '翻译 Agent 重试失败，请稍后重试。',
        diagnosticId: (errors[0] as any).diagnosticId,
      });
      const exposed = JSON.stringify({
        events,
        results,
        diagnostics: consoleError.mock.calls,
      });
      for (const sensitive of [
        sensitiveProviderError,
        'sk-retry-secret',
        'https://retry.private/v1',
        'Hello world',
        'translator prompt',
      ]) {
        expect(exposed).not.toContain(sensitive);
      }
      expect(JSON.stringify(consoleError.mock.calls)).toContain(
        persistedError.diagnosticId,
      );
    });
  });
});
