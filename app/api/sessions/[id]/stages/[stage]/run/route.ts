// ---------------------------------------------------------------------------
// POST /api/sessions/[id]/stages/[stage]/run — 单阶段 SSE 路由 (Wave 3 Task 18)
// ---------------------------------------------------------------------------
// 守卫 → 快照 → runStage → C1 SSE 事件 → 落库 + stale 联动 + 版本生成
// ---------------------------------------------------------------------------

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { createRepositories } from '@/lib/db/repositories';
import { createSessionService } from '@/lib/services/session-service';
import { runStage, markDownstreamStale } from '@/lib/orchestration/pipeline';
import { buildStageContext } from '@/lib/context/stage-context';
import { chatCompletion } from '@/lib/llm/client';
import { encodeSSE } from '@/lib/contracts/sse';
import type { Stage, StageOutput, TranslationResult } from '@/lib/contracts/types';
import type { SessionContext, StageRunResult } from '@/lib/orchestration/pipeline';

// =============================================================================
// Constants
// =============================================================================

const VALID_STAGES: Set<string> = new Set(['review', 'filter', 'orchestrate', 'assemble']);

/** States in which a session may run coordination stages */
const COORDINATION_RUN_STATES: Set<string> = new Set([
  'translated',
  'coordinating',
  'assembled',
  'refining',
]);

// =============================================================================
// Helpers
// =============================================================================

function sseStream(
  controller: ReadableStreamDefaultController,
  event: string,
  data: unknown,
): void {
  controller.enqueue(new TextEncoder().encode(encodeSSE(event, data)));
}

/** Build StageOutput array from DB rows, mapping fields to contract types */
function mapStageOutputs(
  rows: Array<{
    id: number;
    session_id: string;
    stage: string;
    status: string;
    prompt_used: string | null;
    raw_output: string | null;
    parsed_output: string | null;
    error: string | null;
  }>,
): StageOutput[] {
  return rows.map((r) => ({
    id: r.id,
    session_id: r.session_id,
    stage: r.stage as Stage,
    status: r.status as StageOutput['status'],
    prompt_used: r.prompt_used,
    raw_output: r.raw_output,
    parsed_output: r.parsed_output,
    error: r.error,
  }));
}

/** Get the prerequisite stage for a given stage, or null if none */
function getPrerequisite(stage: Stage): Stage | null {
  const PREREQS: Record<Stage, Stage | null> = {
    review: null,
    filter: 'review',
    orchestrate: 'filter',
    assemble: 'orchestrate',
  };
  return PREREQS[stage];
}

/** Build the prompt_used string for persisting (system + user content) */
function buildPromptUsed(
  stageTemplate: string,
  contextJson: string,
  schemaDesc: string,
): string {
  const system = [
    'You must output ONLY valid JSON that conforms to the schema below.',
    'Do not include any explanation, markdown formatting, or code fences.',
    '',
    '--- stage_schema ---',
    schemaDesc,
    '--- end stage_schema ---',
  ].join('\n');

  return `SYSTEM:\n${system}\n\nUSER:\n${stageTemplate.replace('{{context}}', contextJson)}`;
}

// =============================================================================
// Route Handler
// =============================================================================

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; stage: string }> },
): Promise<Response> {
  const { id: sessionId, stage: stageParam } = await params;

  // ── 0. Validate stage enum ────────────────────────────────────
  if (!VALID_STAGES.has(stageParam)) {
    return NextResponse.json(
      { error: `Invalid stage: ${stageParam}. Must be one of review, filter, orchestrate, assemble.` },
      { status: 404 },
    );
  }
  const stage = stageParam as Stage;

  // ── 1. Database & services ────────────────────────────────────
  const db = getDb();
  const repos = createRepositories(db);
  const service = createSessionService(db, repos);

  // ── 2. Load session ───────────────────────────────────────────
  const session = repos.sessions.getById(sessionId);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  // ── 3. Guard: session state ───────────────────────────────────
  const currentState = session.state;
  if (!COORDINATION_RUN_STATES.has(currentState)) {
    return NextResponse.json(
      { error: `Cannot run stage in state '${currentState}'. Allowed: translated, coordinating, assembled, refining.` },
      { status: 409 },
    );
  }

  // ── 4. Transition translated → coordinating (first coordination) ─
  if (currentState === 'translated') {
    try {
      service.transitionState(sessionId, 'coordinating');
    } catch {
      return NextResponse.json(
        { error: 'Unable to transition to coordinating state.' },
        { status: 409 },
      );
    }
  }

  // ── 5. Guard: prerequisite ────────────────────────────────────
  const prereq = getPrerequisite(stage);
  if (prereq) {
    const prereqRow = repos.stageOutputs.getBySessionAndStage(sessionId, prereq);
    if (!prereqRow || prereqRow.status !== 'complete') {
      const missing: string[] = [];
      // Walk back to find all missing prerequisites
      let cur: Stage | null = stage;
      while (cur) {
        const p = getPrerequisite(cur);
        if (!p) break;
        const pRow = repos.stageOutputs.getBySessionAndStage(sessionId, p);
        if (!pRow || pRow.status !== 'complete') {
          missing.push(p);
          break; // Stop at the first missing one
        }
        cur = p;
      }
      return NextResponse.json(
        { error: 'Prerequisite stage not complete.', missing },
        { status: 409 },
      );
    }
  }

  // ── 6. Guard: concurrency (no other stage running for this session) ──
  const allStages = repos.stageOutputs.listBySession(sessionId);
  const runningStage = allStages.find(
    (s) => s.stage !== stage && s.status === 'running',
  );
  if (runningStage) {
    return NextResponse.json(
      { error: `Stage '${runningStage.stage}' is already running for this session.` },
      { status: 409 },
    );
  }

  // ── 7. Mark current stage as 'running' (UPSERT stage_outputs) ──
  const existingStageRow = repos.stageOutputs.getBySessionAndStage(sessionId, stage);
  if (existingStageRow) {
    repos.stageOutputs.update({
      id: existingStageRow.id,
      status: 'running',
      prompt_used: null,
      raw_output: null,
      parsed_output: null,
      error: null,
    });
  } else {
    repos.stageOutputs.insert({
      session_id: sessionId,
      stage,
      status: 'running',
      prompt_used: null,
      raw_output: null,
      parsed_output: null,
      error: null,
    });
  }

  // ── 8. Build session context from snapshot ────────────────────
  const snapshot = service.snapshotConfig(session.config_snapshot);
  const endpoint = snapshot.endpoint;
  if (!endpoint) {
    // Roll back running status
    const rollbackRow = repos.stageOutputs.getBySessionAndStage(sessionId, stage);
    if (rollbackRow) {
      repos.stageOutputs.update({
        id: rollbackRow.id,
        status: 'failed',
        prompt_used: null,
        raw_output: null,
        parsed_output: null,
        error: 'No LLM endpoint configured.',
      });
    }
    return NextResponse.json(
      { error: 'No LLM endpoint configured. Please configure an endpoint first.' },
      { status: 400 },
    );
  }

  const coordinatorEndpoint = { baseUrl: endpoint.base_url, apiKey: endpoint.api_key };
  const coordinatorModel = snapshot.coordinator?.model || 'gpt-4o';

  // Prompt templates: snapshot has kind→content
  const promptTemplates: Record<string, string> = {};
  for (const kind of ['review', 'filter', 'orchestrate', 'assemble'] as const) {
    promptTemplates[kind] = snapshot.prompts?.[kind] || '';
  }

  // Translation results (completed only)
  const resultRows = repos.translationResults.listBySession(sessionId);
  const completedTranslations: TranslationResult[] = resultRows
    .filter((r) => r.status === 'complete')
    .map((r) => ({
      id: r.id,
      session_id: r.session_id,
      agent_key: r.agent_key,
      agent_snapshot: r.agent_snapshot,
      status: r.status,
      output_text: r.output_text,
      error: r.error,
      latency_ms: r.latency_ms,
      attempt: r.attempt,
    }));

  // Prior stage outputs (excluding current stage)
  const priorStageOutputs = mapStageOutputs(
    allStages.filter((s) => s.stage !== stage),
  );

  const sessionContext: SessionContext = {
    sourceText: session.source_text,
    sourceLang: session.source_lang,
    targetLang: session.target_lang,
    translations: completedTranslations,
    priorStages: priorStageOutputs,
    coordinatorEndpoint,
    coordinatorModel,
    promptTemplates,
  };

  // ── 9. Build prompt_used for persistence ──────────────────────
  const stageTemplate = promptTemplates[stage] || '';
  const contextResult = buildStageContext(stage, {
    sourceText: sessionContext.sourceText,
    sourceLang: sessionContext.sourceLang,
    targetLang: sessionContext.targetLang,
    translations: sessionContext.translations,
    priorStages: sessionContext.priorStages,
  });
  const contextJson = JSON.stringify(contextResult.json);

  // Human-readable schema description for prompt_used
  const SCHEMA_DESCRIPTIONS: Record<Stage, string> = {
    review: 'reviewOutputSchema: { assessments: [{ agent_id, strengths, weaknesses, quality_score, keep }] }',
    filter: 'filterOutputSchema: { selected_agent_ids, rejected_agent_ids, rationale }',
    orchestrate: 'orchestrateOutputSchema: { structure_notes, segment_assignments: [{ segment_index, source_agent_id, source_segment, rationale }] }',
    assemble: 'assembleOutputSchema: { final_text, notes }',
  };

  const promptUsedText = buildPromptUsed(
    stageTemplate,
    contextJson,
    SCHEMA_DESCRIPTIONS[stage],
  );

  // ── 10. SSE Stream ────────────────────────────────────────────
  const abortSignal = req.signal;

  const stream = new ReadableStream({
    async start(controller) {
      let stageResult: StageRunResult | null = null;

      try {
        sseStream(controller, 'stage_start', { stage });

        // Run the stage with streaming callbacks → SSE
        stageResult = await runStage(
          stage,
          sessionContext,
          {
            onStageStart(s) {
              // Already emitted above
            },
            onDelta(s, content) {
              // Only emit for streaming stages (orchestrate, assemble)
              sseStream(controller, 'stage_delta', { stage: s, content });
            },
            onStageComplete(s, result) {
              // Handled after runStage returns
            },
            onSchemaError(s, rawText, zodError, attempt) {
              sseStream(controller, 'stage_schema_error', {
                stage: s,
                rawText,
                zodError,
                attempt,
              });
            },
            onError(s, error) {
              sseStream(controller, 'stage_error', {
                stage: s,
                error: error.message,
              });
            },
            onAssembled(_finalText) {
              // Handled in persistence below
            },
          },
          chatCompletion,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        sseStream(controller, 'stage_error', { stage, error: msg });
      }

      // ── 11. Persist result ────────────────────────────────────
      if (stageResult) {
        const parsedOutputStr =
          stageResult.parsed_output != null
            ? JSON.stringify(stageResult.parsed_output)
            : null;

        // UPSERT into stage_outputs
        const currentRow = repos.stageOutputs.getBySessionAndStage(sessionId, stage);
        const upsertStatus: StageOutput['status'] = stageResult.ok ? 'complete' : 'failed';

        if (currentRow) {
          repos.stageOutputs.update({
            id: currentRow.id,
            status: upsertStatus,
            prompt_used: promptUsedText,
            raw_output: stageResult.raw_text || null,
            parsed_output: parsedOutputStr,
            error: stageResult.ok ? null : stageResult.detail || null,
          });
        } else {
          repos.stageOutputs.insert({
            session_id: sessionId,
            stage,
            status: upsertStatus,
            prompt_used: promptUsedText,
            raw_output: stageResult.raw_text || null,
            parsed_output: parsedOutputStr,
            error: stageResult.ok ? null : stageResult.detail || null,
          });
        }

        // ── 11a. On success: mark downstream stale ────────────────
        if (stageResult.ok) {
          const downstreamStages = markDownstreamStale(stage);
          for (const ds of downstreamStages) {
            const dsRow = repos.stageOutputs.getBySessionAndStage(sessionId, ds);
            if (dsRow && dsRow.status !== 'pending') {
              repos.stageOutputs.update({
                id: dsRow.id,
                status: 'stale',
                prompt_used: dsRow.prompt_used,
                raw_output: dsRow.raw_output,
                parsed_output: dsRow.parsed_output,
                error: dsRow.error,
              });
            }
          }
        }

        // ── 11b. Assemble special: insert final_version + transition ─
        if (stage === 'assemble' && stageResult.ok && stageResult.parsed_output) {
          const data = stageResult.parsed_output as Record<string, unknown>;
          const finalText =
            typeof data.final_text === 'string' ? data.final_text : '';

          if (finalText) {
            // Determine next version_no (max + 1)
            const latestVersion = repos.finalVersions.getLatestBySession(sessionId);
            const nextVersionNo = (latestVersion?.version_no ?? 0) + 1;

            repos.finalVersions.insert({
              session_id: sessionId,
              version_no: nextVersionNo,
              text: finalText,
              source: 'assemble',
            });

            // Transition state → assembled
            try {
              service.transitionState(sessionId, 'assembled');
            } catch {
              // State transition may fail if not in coordinating — ignore
            }
          }
        }

        // ── 12. Emit final event ─────────────────────────────────
        if (stageResult.ok) {
          sseStream(controller, 'stage_complete', {
            stage,
            code: stageResult.code,
            parsed_output: stageResult.parsed_output,
            raw_text: stageResult.raw_text,
          });
        } else {
          // Emit appropriate error event
          if (stageResult.code === 'stage_schema_error') {
            sseStream(controller, 'stage_schema_error', {
              stage,
              detail: stageResult.detail,
              raw_text: stageResult.raw_text,
            });
          } else {
            sseStream(controller, 'stage_error', {
              stage,
              code: stageResult.code,
              detail: stageResult.detail,
            });
          }
        }
      }

      sseStream(controller, 'done', {});
      controller.close();
    },
    cancel() {
      // Stream was aborted by client — no cleanup needed beyond abort propagation
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
