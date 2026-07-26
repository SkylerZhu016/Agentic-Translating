// ---------------------------------------------------------------------------
// POST /api/sessions/[id]/agents/[agentKey]/retry
//
// Single-agent retry route (Wave 3 Task 17).
// Re-runs only the specified agent_key via runFanOut and returns SSE stream.
// Guards: session exists, state valid, agent_key present in snapshot.
// ---------------------------------------------------------------------------

import { getDb } from '@/src/lib/db';
import { createRepositories } from '@/src/lib/db/repositories';
import { createSessionService } from '@/src/lib/services/session-service';
import { runFanOut, type AgentRuntime, type FanOutCallbacks } from '@/src/lib/orchestration/fanout';
import { chatCompletion } from '@/src/lib/llm/client';
import {
  resolveTranslatorPrompt,
  buildTranslatorPrompt,
} from '@/src/lib/prompts/assemble';
import { encodeSSE } from '@/src/lib/contracts/sse';
import { InvalidTransitionError } from '@/src/lib/guards';
import type { ConfigSnapshot } from '@/src/lib/contracts/types';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; agentKey: string }> },
): Promise<Response> {
  const { id, agentKey } = await params;

  const db = getDb();
  const repos = createRepositories(db);
  const service = createSessionService(db, repos);

  // ── Guard: session exists ──────────────────────────────────────
  const session = repos.sessions.getById(id);
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }

  // ── Guard: state allows retry ──────────────────────────────────
  if (!['draft', 'translated'].includes(session.state)) {
    return Response.json(
      {
        error: `Cannot retry from state "${session.state}"`,
        code: 'invalid_state_transition' as const,
      },
      { status: 409 },
    );
  }

  // ── Guard: snapshot agents ≥ 1 & agent_key present ────────────
  const config: ConfigSnapshot = service.snapshotConfig(session.config_snapshot);
  if (!config.agents || config.agents.length === 0) {
    return Response.json(
      { error: 'No translator agents configured in session snapshot' },
      { status: 400 },
    );
  }

  const targetAgent = config.agents.find((a) => a.name === agentKey);
  if (!targetAgent) {
    return Response.json(
      { error: `Agent "${agentKey}" not found in session snapshot` },
      { status: 400 },
    );
  }

  // ── Guard: endpoint configured ────────────────────────────────
  const endpointConfig =
    config.endpoints?.find(
      (endpoint) => endpoint.id === targetAgent.endpoint_id,
    ) ?? config.endpoint;
  if (!endpointConfig) {
    return Response.json(
      { error: 'No API endpoint configured in session snapshot' },
      { status: 400 },
    );
  }

  // ── Build single AgentRuntime ──────────────────────────────────
  const defaultTemplate = config.prompts.translator ?? '';
  const template = resolveTranslatorPrompt(
    { prompt_override: targetAgent.prompt_override },
    defaultTemplate,
  );
  const { system, user } = buildTranslatorPrompt(template, {
    source_lang: session.source_lang,
    target_lang: session.target_lang,
    source_text: session.source_text,
  });

  const singleAgent: AgentRuntime = {
    agentKey: targetAgent.name,
    name: targetAgent.name,
    endpoint: {
      baseUrl: endpointConfig.base_url,
      chatCompletionsPath:
        endpointConfig.chat_completions_path ?? '/v1/chat/completions',
      apiKey: endpointConfig.api_key,
    },
    model: targetAgent.model,
    messages: [
      { role: system.role, content: system.content },
      { role: user.role, content: user.content },
    ],
  };

  // ── Mark result as streaming ───────────────────────────────────
  let trRow = repos.translationResults.getBySessionAndAgent(id, agentKey);
  let newAttempt = trRow ? trRow.attempt + 1 : 0;
  if (trRow) {
    repos.translationResults.update({
      id: trRow.id,
      status: 'streaming',
      output_text: null,
      error: null,
      latency_ms: null,
      attempt: newAttempt,
    });
  }

  // ── SSE abort controller ──────────────────────────────────────
  const controller = new AbortController();

  // ── SSE ReadableStream ────────────────────────────────────────
  const encoder = new TextEncoder();
  let agentStartTime = 0;

  const stream = new ReadableStream({
    async start(streamController) {
      const send = (event: string, data: unknown) => {
        try {
          streamController.enqueue(encoder.encode(encodeSSE(event, data)));
        } catch {
          // stream already closed — ignore
        }
      };

      const callbacks: FanOutCallbacks = {
        onAgentStart() {
          agentStartTime = performance.now();
          send('agent_start', { agent_key: agentKey });
        },
        onToken(_ak: string, content: string) {
          send('token', { agent_key: agentKey, delta: content });
        },
        onAgentComplete(_ak: string, result) {
          send('agent_complete', {
            agent_key: agentKey,
            status: result.status,
            content: result.content,
          });
        },
        onAgentError(_ak: string, error: Error) {
          send('agent_error', {
            agent_key: agentKey,
            error: error.message,
          });
        },
      };

      try {
        const summary = await runFanOut([singleAgent], callbacks, chatCompletion, {
          signal: controller.signal,
          sessionId: id,
        });

        // ── Persist result to DB ─────────────────────────────────
        const result = summary.results[0];
        if (result && trRow) {
          const dbStatus =
            result.status === 'aborted'
              ? ('error' as const)
              : (result.status as 'complete' | 'error');

          repos.translationResults.update({
            id: trRow.id,
            status: dbStatus,
            output_text: result.content ?? null,
            error:
              result.error ??
              (result.status === 'aborted' ? 'Request was aborted' : null),
            latency_ms: agentStartTime
              ? Math.round(performance.now() - agentStartTime)
              : null,
            attempt: newAttempt,
          });
        }

        // ── Emit fanout_complete ──────────────────────────────────
        send('fanout_complete', {
          succeeded: summary.succeeded,
          failed: summary.failed,
          duration_ms: summary.durationMs,
        });

        send('done', {});
        streamController.close();
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        send('error', { error: message });

        if (trRow) {
          repos.translationResults.update({
            id: trRow.id,
            status: 'error',
            output_text: null,
            error: 'Retry pipeline failed',
            latency_ms: null,
            attempt: newAttempt,
          });
        }

        streamController.close();
      }
    },
    cancel() {
      controller.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
