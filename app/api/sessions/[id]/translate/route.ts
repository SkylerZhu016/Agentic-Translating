// ---------------------------------------------------------------------------
// POST /api/sessions/[id]/translate
//
// SSE fan-out translation route (Wave 3 Task 17).
// - Guards: session exists, state ∈ {draft, translated}, snapshot agents ≥ 1
// - Builds AgentRuntime[] from snapshot agents + resolved translator prompts
// - Streams SSE events via runFanOut callbacks (C1 event sequence)
// - Persists translation_results on agent complete/error
// - Transitions session to 'translated' on fanout_complete
// - Propagates client disconnect (request.signal) → AbortController → fanOut
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
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  const db = getDb();
  const repos = createRepositories(db);
  const service = createSessionService(db, repos);

  // ── Guard: session exists ──────────────────────────────────────
  const session = repos.sessions.getById(id);
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }

  // ── Guard: state ∈ {draft, translated} ─────────────────────────
  if (!['draft', 'translated'].includes(session.state)) {
    return Response.json(
      {
        error: `Cannot translate from state "${session.state}"`,
        code: 'invalid_state_transition' as const,
      },
      { status: 409 },
    );
  }

  // ── Guard: snapshot agents ≥ 1 ────────────────────────────────
  const config: ConfigSnapshot = service.snapshotConfig(session.config_snapshot);
  if (!config.agents || config.agents.length === 0) {
    return Response.json(
      { error: 'No translator agents configured in session snapshot' },
      { status: 400 },
    );
  }

  // ── Guard: endpoint configured ────────────────────────────────
  if (!config.endpoint && (!config.endpoints || config.endpoints.length === 0)) {
    return Response.json(
      { error: 'No API endpoint configured in session snapshot' },
      { status: 400 },
    );
  }

  // ── Build AgentRuntime array ──────────────────────────────────
  const defaultTemplate = config.prompts.translator ?? '';
  const endpointById = new Map(
    (config.endpoints ?? (config.endpoint ? [config.endpoint] : [])).map(
      (endpoint) => [endpoint.id, endpoint],
    ),
  );

  const agents: AgentRuntime[] = config.agents.map((agent) => {
    const endpointConfig =
      endpointById.get(agent.endpoint_id) ?? config.endpoint;
    if (!endpointConfig) {
      throw new Error(
        `Endpoint ${agent.endpoint_id} for agent "${agent.name}" is missing from the session snapshot`,
      );
    }
    const template = resolveTranslatorPrompt(
      { prompt_override: agent.prompt_override },
      defaultTemplate,
    );
    const { system, user } = buildTranslatorPrompt(template, {
      source_lang: session.source_lang,
      target_lang: session.target_lang,
      source_text: session.source_text,
    });

    return {
      agentKey: agent.name,
      name: agent.name,
      endpoint: {
        baseUrl: endpointConfig.base_url,
        chatCompletionsPath:
          endpointConfig.chat_completions_path ?? '/v1/chat/completions',
        apiKey: endpointConfig.api_key,
      },
      model: agent.model,
      messages: [
        { role: system.role, content: system.content },
        { role: user.role, content: user.content },
      ],
    };
  });

  // ── Transition to translating (if draft) ──────────────────────
  try {
    if (session.state === 'draft') {
      service.transitionState(id, 'translating');
    }
  } catch (e) {
    if (e instanceof InvalidTransitionError) {
      return Response.json(
        { error: e.message, code: e.code },
        { status: 409 },
      );
    }
    throw e;
  }

  // ── Mark results as streaming ─────────────────────────────────
  for (const agent of agents) {
    const trRow = repos.translationResults.getBySessionAndAgent(id, agent.agentKey);
    if (trRow) {
      repos.translationResults.update({
        id: trRow.id,
        status: 'streaming',
        output_text: null,
        error: null,
        latency_ms: null,
        attempt: trRow.attempt + 1,
      });
    }
  }

  // ── SSE abort controller ──────────────────────────────────────
  const controller = new AbortController();

  // ── SSE ReadableStream ────────────────────────────────────────
  const encoder = new TextEncoder();
  const agentStartTimes = new Map<string, number>();

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
        onAgentStart(agentKey: string) {
          agentStartTimes.set(agentKey, performance.now());
          send('agent_start', { agent_key: agentKey });
        },
        onToken(agentKey: string, content: string) {
          send('token', { agent_key: agentKey, delta: content });
        },
        onAgentComplete(agentKey: string, result) {
          send('agent_complete', {
            agent_key: agentKey,
            status: result.status,
            content: result.content,
          });
        },
        onAgentError(agentKey: string, error: Error) {
          send('agent_error', {
            agent_key: agentKey,
            error: error.message,
          });
        },
      };

      try {
        const summary = await runFanOut(agents, callbacks, chatCompletion, {
          signal: controller.signal,
          sessionId: id,
        });

        // ── Persist all results to DB ────────────────────────────
        for (const result of summary.results) {
          const trRow = repos.translationResults.getBySessionAndAgent(
            id,
            result.agentKey,
          );
          if (!trRow) continue;

          const startTime = agentStartTimes.get(result.agentKey);
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
            latency_ms: startTime
              ? Math.round(performance.now() - startTime)
              : null,
            attempt: trRow.attempt,
          });
        }

        // ── Emit fanout_complete and transition ──────────────────
        send('fanout_complete', {
          succeeded: summary.succeeded,
          failed: summary.failed,
          duration_ms: summary.durationMs,
        });

        try {
          service.transitionState(id, 'translated');
        } catch {
          // transition may be invalid if already translated — non-fatal
        }

        send('done', {});
        streamController.close();
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        send('error', { error: message });

        // Update all results to error for untracked agents
        for (const agent of agents) {
          const trRow = repos.translationResults.getBySessionAndAgent(
            id,
            agent.agentKey,
          );
          if (trRow && trRow.status === 'streaming') {
            repos.translationResults.update({
              id: trRow.id,
              status: 'error',
              output_text: null,
              error: 'Fan-out pipeline failed',
              latency_ms: null,
              attempt: trRow.attempt,
            });
          }
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
