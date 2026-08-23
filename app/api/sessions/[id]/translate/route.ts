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
import {
  executionDiagnosticError,
  logSafeDiagnostic,
  serializeExecutionDiagnosticError,
  type ExecutionDiagnosticErrorDto,
} from '@/src/lib/security/diagnostic-error';
import {
  createPreflightedLlmCaller,
  ensureStoredSessionPreflight,
  resolvePreflightOutputLimit,
  sessionPreflightErrorDto,
  type PhysicalPaidCallIdentity,
} from '@/src/lib/services/session-preflight';
import {
  currentRuntimeEndpoint,
  resolveRuntimeEndpoint,
  runtimeEndpointCredentialErrorDto,
} from '@/src/lib/services/runtime-endpoint-credentials';

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
  let config: ConfigSnapshot;
  try {
    config = ensureStoredSessionPreflight(db, session) as unknown as ConfigSnapshot;
  } catch (error) {
    const preflightError = sessionPreflightErrorDto(error);
    if (preflightError) {
      return Response.json(preflightError.body, {
        status: preflightError.status,
      });
    }
    throw error;
  }
  const boundAgents = (config.agents ?? []).filter(
    (agent): agent is typeof agent & { endpoint_id: number } =>
      agent.endpoint_id !== null,
  );
  if (boundAgents.length === 0) {
    return Response.json(
      { error: 'No translator agents are bound in session snapshot' },
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
  const preflightByMessages = new WeakMap<object, PhysicalPaidCallIdentity>();
  let agents: AgentRuntime[];
  try {
    agents = boundAgents.map((agent) => {
    const variant = config.agentVariantSnapshots?.find(
      (candidate) =>
        candidate.id === agent.name || candidate.catalogName === agent.name,
    );
    const endpointConfig = resolveRuntimeEndpoint(db, config, agent.endpoint_id);
    const template = resolveTranslatorPrompt(
      { prompt_override: agent.prompt_override },
      defaultTemplate,
    );
    const { system, user } = buildTranslatorPrompt(template, {
      source_lang: session.source_lang,
      target_lang: session.target_lang,
      source_text: session.source_text,
    });

    const bindingRole = variant ? `worker:${variant.id}` : `worker:${agent.name}`;
    const maxTokens = resolvePreflightOutputLimit(
      config.preflight!,
      {
        stage: 'candidate_generation',
        bindingRole,
        endpointId: endpointConfig.id,
        model: agent.model,
        fallbackOutputTokens:
          config.modelBindings?.defaultWorker.maxOutputTokens,
      },
    );
    const frozenStage = config.preflight!.stages.find(
      (stage) =>
        stage.stage === 'candidate_generation' &&
        stage.bindingRole === bindingRole &&
        stage.endpointId === endpointConfig.id &&
        stage.model === agent.model,
    );
    const runtime: AgentRuntime = {
      agentKey: agent.name,
      name: agent.name,
      endpoint: {
        baseUrl: endpointConfig.baseUrl,
        chatCompletionsPath: endpointConfig.chatCompletionsPath,
        apiKey: endpointConfig.apiKey,
      },
      model: agent.model,
      maxTokens,
      messages: [
        { role: system.role, content: system.content },
        { role: user.role, content: user.content },
      ],
    };
    preflightByMessages.set(runtime.messages, {
      attemptKey: `translate:${agent.name}`,
      stage: 'candidate_generation',
      bindingRole,
      endpointId: endpointConfig.id,
      model: agent.model,
      contextWindow:
        frozenStage?.contextWindowTokens ?? endpointConfig.contextWindow,
      maxOutputTokens: maxTokens,
    });
      return runtime;
    });
  } catch (error) {
    const credentialError = runtimeEndpointCredentialErrorDto(error);
    if (credentialError) {
      return Response.json(credentialError.body, {
        status: credentialError.status,
      });
    }
    throw error;
  }
  const preflightedChatCompletion = createPreflightedLlmCaller(
    (endpoint, llmRequest) => {
      const identity = preflightByMessages.get(llmRequest.messages);
      if (!identity) {
        throw new Error('Physical preflight identity is unavailable for fanout call.');
      }
      if (identity.endpointId == null) {
        throw new Error('Physical call endpoint identity is unavailable.');
      }
      return chatCompletion(
        {
          ...endpoint,
          resolveRuntimeEndpoint: () =>
            currentRuntimeEndpoint(db, identity.endpointId!),
        },
        llmRequest,
      );
    },
    (_endpoint, llmRequest) => {
      const identity = preflightByMessages.get(llmRequest.messages);
      if (!identity) {
        throw new Error('Physical preflight identity is unavailable for fanout call.');
      }
      return identity;
    },
  );

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

      const failures = new Map<string, ExecutionDiagnosticErrorDto>();
      const emittedFailures = new Set<string>();
      const failureFor = (
        agentKey: string,
        cause: unknown,
      ): ExecutionDiagnosticErrorDto => {
        const existing = failures.get(agentKey);
        if (existing) return existing;
        const diagnostic = executionDiagnosticError(
          'translation_agent_failed',
        );
        failures.set(agentKey, diagnostic);
        logSafeDiagnostic({
          scope: 'legacy.translate.agent',
          diagnosticId: diagnostic.diagnosticId,
          cause,
        });
        return diagnostic;
      };
      const sendAgentFailure = (
        agentKey: string,
        cause: unknown,
      ): ExecutionDiagnosticErrorDto => {
        const diagnostic = failureFor(agentKey, cause);
        if (!emittedFailures.has(agentKey)) {
          emittedFailures.add(agentKey);
          send('agent_error', {
            agent_key: agentKey,
            error: diagnostic.message,
            code: diagnostic.error,
            message: diagnostic.message,
            diagnosticId: diagnostic.diagnosticId,
          });
        }
        return diagnostic;
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
          if (result.status !== 'complete') {
            sendAgentFailure(agentKey, { code: 'empty_response' });
            return;
          }
          send('agent_complete', {
            agent_key: agentKey,
            status: result.status,
            content: result.content,
          });
        },
        onAgentError(agentKey: string, error: Error) {
          sendAgentFailure(agentKey, error);
        },
      };

      try {
        const summary = await runFanOut(agents, callbacks, preflightedChatCompletion, {
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
          const failure =
            dbStatus === 'error'
              ? sendAgentFailure(result.agentKey, {
                  code: result.status === 'aborted' ? 'aborted' : 'unknown',
                })
              : null;

          repos.translationResults.update({
            id: trRow.id,
            status: dbStatus,
            output_text: result.content ?? null,
            error: failure
              ? serializeExecutionDiagnosticError(failure)
              : null,
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
        const diagnostic = executionDiagnosticError(
          'translation_pipeline_failed',
        );
        logSafeDiagnostic({
          scope: 'legacy.translate.pipeline',
          diagnosticId: diagnostic.diagnosticId,
          cause: error,
        });
        send('error', {
          error: diagnostic.message,
          code: diagnostic.error,
          message: diagnostic.message,
          diagnosticId: diagnostic.diagnosticId,
        });

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
              error: serializeExecutionDiagnosticError(diagnostic),
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
