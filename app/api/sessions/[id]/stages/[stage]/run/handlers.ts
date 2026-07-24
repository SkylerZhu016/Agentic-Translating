// ---------------------------------------------------------------------------
// Stage SSE handlers — factory extracted from route.ts (Next 15.5 route
// modules may only export HTTP verbs + route config; tests import this).
// ---------------------------------------------------------------------------
// Wave 3 Task 18 — 单阶段 SSE 路由
//
// POST /api/sessions/[id]/stages/[stage]/run →
//   - 守卫: stage∈{review,filter,orchestrate,assemble}; state∈{translated,coordinating,assembled,refining}
//   - 前置守卫: runStage prereq missing→409
//   - 并发守卫: stage_already_running→409
//   - 读快照+prompts+buildStageContext→runStage(任务11)
//   - SSE: C1 事件 (stage_start/stage_delta/stage_complete/done)
//   - 完成: UPSERT stage_outputs; markDownstreamStale→下游stale; assemble→insert final_versions+transition assembled
// ---------------------------------------------------------------------------

import type Database from 'better-sqlite3'
import { NextResponse } from 'next/server'
import { createRepositories } from '@/src/lib/db/repositories'
import { createSessionService } from '@/src/lib/services/session-service'
import { runStage, markDownstreamStale } from '@/src/lib/orchestration/pipeline'
import { buildStageContext } from '@/src/lib/context/stage-context'
import { chatCompletion } from '@/src/lib/llm/client'
import { encodeSSE } from '@/src/lib/contracts/sse'
import type { Stage, StageOutput, TranslationResult } from '@/src/lib/contracts/types'
import type { SessionContext, StageRunResult } from '@/src/lib/orchestration/pipeline'

// =============================================================================
// Constants
// =============================================================================

const VALID_STAGES: Set<string> = new Set(['review', 'filter', 'orchestrate', 'assemble'])

/** States in which a session may run coordination stages */
const COORDINATION_RUN_STATES: Set<string> = new Set([
  'translated',
  'coordinating',
  'assembled',
  'refining',
])

// =============================================================================
// Helpers
// =============================================================================

function sseStream(
  controller: ReadableStreamDefaultController,
  event: string,
  data: unknown,
): void {
  controller.enqueue(new TextEncoder().encode(encodeSSE(event, data)))
}

/** Build StageOutput array from DB rows, mapping fields to contract types */
function mapStageOutputs(
  rows: Array<{
    id: number
    session_id: string
    stage: string
    status: string
    prompt_used: string | null
    raw_output: string | null
    error: string | null
  }>,
): StageOutput[] {
  return rows.map((r) => ({
    id: r.id,
    session_id: r.session_id,
    stage: r.stage as Stage,
    status: r.status as StageOutput['status'],
    prompt_used: r.prompt_used,
    raw_output: r.raw_output,
    error: r.error,
  }))
}

/** Get the prerequisite stage for a given stage, or null if none */
function getPrerequisite(stage: Stage): Stage | null {
  const PREREQS: Record<Stage, Stage | null> = {
    review: null,
    filter: 'review',
    orchestrate: 'filter',
    assemble: 'orchestrate',
  }
  return PREREQS[stage]
}

/** Build the prompt_used string for persisting (system + user content) */
function buildPromptUsed(
  stageTemplate: string,
  contextJson: string,
  promptLanguage: 'zh' | 'en' = 'zh',
): string {
  const system =
    promptLanguage === 'en'
      ? [
          'Write freely. If you add notes, put them after a standalone --- line.',
          'Downstream stages receive only the body before that boundary.',
        ].join('\n')
      : [
          '你可以自由输出。如需添加注释/理由，请在正文后用一行 ---（markdown 水平分割线）分隔，然后写注释。',
          '下游审查者只看正文不看注释，注释仅供人类归档参考。',
        ].join('\n')

  return `SYSTEM:\n${system}\n\nUSER:\n${stageTemplate.replace('{{context}}', contextJson)}`
}

// =============================================================================
// Handler factory
// =============================================================================

export function createHandlers(db: Database.Database) {
  const repos = createRepositories(db)
  const service = createSessionService(db, repos)

  async function POST(
    req: Request,
    { params }: { params: Promise<{ id: string; stage: string }> },
  ): Promise<Response> {
    const { id: sessionId, stage: stageParam } = await params

    // ── 0. Validate stage enum ────────────────────────────────────
    if (!VALID_STAGES.has(stageParam)) {
      return NextResponse.json(
        {
          error: `Invalid stage: ${stageParam}. Must be one of review, filter, orchestrate, assemble.`,
        },
        { status: 404 },
      )
    }
    const stage = stageParam as Stage

    // ── 1. Load session ───────────────────────────────────────────
    const session = repos.sessions.getById(sessionId)
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

    // ── 2. Guard: session state ───────────────────────────────────
    const currentState = session.state
    if (!COORDINATION_RUN_STATES.has(currentState)) {
      return NextResponse.json(
        {
          error: `Cannot run stage in state '${currentState}'. Allowed: translated, coordinating, assembled, refining.`,
        },
        { status: 409 },
      )
    }

    // ── 3. Transition translated → coordinating (first coordination) ─
    if (currentState === 'translated') {
      try {
        service.transitionState(sessionId, 'coordinating')
      } catch {
        return NextResponse.json(
          { error: 'Unable to transition to coordinating state.' },
          { status: 409 },
        )
      }
    }

    // ── 4. Guard: concurrency (no other stage running for this session) ──
    const allStages = repos.stageOutputs.listBySession(sessionId)
    const runningStage = allStages.find(
      (s) => s.stage !== stage && s.status === 'running',
    )
    if (runningStage) {
      return NextResponse.json(
        {
          error: `Stage '${runningStage.stage}' is already running for this session.`,
        },
        { status: 409 },
      )
    }

    // ── 5. Guard: prerequisite ────────────────────────────────────
    const prereq = getPrerequisite(stage)
    if (prereq) {
      const prereqRow = repos.stageOutputs.getBySessionAndStage(sessionId, prereq)
      if (!prereqRow || prereqRow.status !== 'complete') {
        const missing: string[] = []
        // Walk back to find all missing prerequisites
        let cur: Stage | null = stage
        while (cur) {
          const p = getPrerequisite(cur)
          if (!p) break
          const pRow = repos.stageOutputs.getBySessionAndStage(sessionId, p)
          if (!pRow || pRow.status !== 'complete') {
            missing.push(p)
            break // Stop at the first missing one
          }
          cur = p
        }
        return NextResponse.json(
          { error: 'Prerequisite stage not complete.', missing },
          { status: 409 },
        )
      }
    }

    // ── 6. Mark current stage as 'running' (UPSERT stage_outputs) ──
    const existingStageRow = repos.stageOutputs.getBySessionAndStage(sessionId, stage)
    if (existingStageRow) {
      repos.stageOutputs.update({
        id: existingStageRow.id,
        status: 'running',
        prompt_used: null,
        raw_output: null,
        error: null,
      })
    } else {
      repos.stageOutputs.insert({
        session_id: sessionId,
        stage,
        status: 'running',
        prompt_used: null,
        raw_output: null,
        error: null,
      })
    }

    // ── 7. Build session context from snapshot ────────────────────
    const snapshot = service.snapshotConfig(session.config_snapshot)
    const coordinatorEndpointId =
      snapshot.modelBindings?.mainAgent.endpointId ??
      snapshot.coordinator?.endpoint_id
    const endpoint =
      snapshot.endpointSnapshots?.find(
        (candidate) => candidate.id === coordinatorEndpointId,
      ) ??
      snapshot.endpoints?.find(
        (candidate) => candidate.id === coordinatorEndpointId,
      ) ??
      snapshot.endpoint
    if (!endpoint) {
      // Roll back running status
      const rollbackRow = repos.stageOutputs.getBySessionAndStage(sessionId, stage)
      if (rollbackRow) {
        repos.stageOutputs.update({
          id: rollbackRow.id,
          status: 'failed',
          prompt_used: null,
          raw_output: null,
          error: 'No LLM endpoint configured.',
        })
      }
      return NextResponse.json(
        {
          error: 'No LLM endpoint configured. Please configure an endpoint first.',
        },
        { status: 400 },
      )
    }

    const coordinatorEndpoint = {
      baseUrl: 'baseUrl' in endpoint ? endpoint.baseUrl : endpoint.base_url,
      apiKey: 'apiKey' in endpoint ? endpoint.apiKey : endpoint.api_key,
    }
    const coordinatorModel =
      snapshot.modelBindings?.mainAgent.model ||
      snapshot.coordinator?.model ||
      'gpt-4o'

    // Prompt templates: snapshot has kind→content
    const promptTemplates: Record<string, string> = {}
    for (const kind of ['review', 'filter', 'orchestrate', 'assemble'] as const) {
      promptTemplates[kind] =
        (kind === 'review' && snapshot.promptBundleSnapshot?.reviewPrompt) ||
        (kind === 'filter' && snapshot.promptBundleSnapshot?.filterPrompt) ||
        (kind === 'orchestrate' &&
          snapshot.promptBundleSnapshot?.orchestratePrompt) ||
        (kind === 'assemble' &&
          snapshot.promptBundleSnapshot?.assemblePrompt) ||
        snapshot.prompts?.[kind] ||
        ''
    }

    // Translation results (completed only)
    const resultRows = repos.translationResults.listBySession(sessionId)
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
      }))

    // Prior stage outputs (excluding current stage)
    const priorStageOutputs = mapStageOutputs(
      allStages.filter((s) => s.stage !== stage),
    )

    const sessionContext: SessionContext = {
      sessionId,
      sourceText: session.source_text,
      sourceLang: session.source_lang,
      targetLang: session.target_lang,
      taskBrief: session.task_brief ?? snapshot.taskBrief ?? '',
      promptLanguage: snapshot.promptBundleSnapshot?.promptLanguage ?? 'zh',
      translations: completedTranslations,
      priorStages: priorStageOutputs,
      coordinatorEndpoint,
      coordinatorModel,
      promptTemplates,
    }

    // ── 8. Build prompt_used for persistence ──────────────────────
    const stageTemplate = promptTemplates[stage] || ''
    const contextResult = buildStageContext(stage, {
      sourceText: sessionContext.sourceText,
      sourceLang: sessionContext.sourceLang,
      targetLang: sessionContext.targetLang,
      translations: sessionContext.translations,
      priorStages: sessionContext.priorStages,
      taskBrief: sessionContext.taskBrief,
    })
    const contextJson = JSON.stringify(contextResult.json)

    const promptUsedText = buildPromptUsed(
      stageTemplate,
      contextJson,
      sessionContext.promptLanguage,
    )

    // ── 9. SSE Stream ─────────────────────────────────────────────
    const stream = new ReadableStream({
      async start(controller) {
        let stageResult: StageRunResult | null = null

        try {
          sseStream(controller, 'stage_start', { stage })

          // Run the stage with streaming callbacks → SSE
          stageResult = await runStage(
            stage,
            sessionContext,
            {
              onStageStart(_s) {
                // Already emitted above
              },
              onDelta(s, content) {
                // Only emit for streaming stages (orchestrate, assemble)
                sseStream(controller, 'stage_delta', { stage: s, content })
              },
              onStageComplete(_s, _result) {
                // Handled after runStage returns
              },
              onError(s, error) {
                sseStream(controller, 'stage_error', {
                  stage: s,
                  error: error.message,
                })
              },
              onAssembled(_finalText) {
                // Handled in persistence below
              },
            },
            chatCompletion,
          )
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          sseStream(controller, 'stage_error', { stage, error: msg })
        }

        // ── 10. Persist result ────────────────────────────────────
        if (stageResult) {
          // ── Assemble: reject empty final_text ──────────────────
          if (stage === 'assemble' && stageResult.ok) {
            const finalText = stageResult.final_text
            if (!finalText || finalText.trim().length === 0) {
              stageResult = {
                ...stageResult,
                ok: false,
                code: 'assemble_empty',
                detail: 'assemble produced empty final_text',
              }
            }
          }

          // UPSERT into stage_outputs
          const currentRow = repos.stageOutputs.getBySessionAndStage(sessionId, stage)
          const upsertStatus: StageOutput['status'] = stageResult.ok
            ? 'complete'
            : 'failed'

          if (currentRow) {
            repos.stageOutputs.update({
              id: currentRow.id,
              status: upsertStatus,
              prompt_used: promptUsedText,
              raw_output: stageResult.raw_text || null,
              error: stageResult.ok ? null : stageResult.detail || null,
            })
          } else {
            repos.stageOutputs.insert({
              session_id: sessionId,
              stage,
              status: upsertStatus,
              prompt_used: promptUsedText,
              raw_output: stageResult.raw_text || null,
              error: stageResult.ok ? null : stageResult.detail || null,
            })
          }

          // ── 10a. On success: mark downstream stale ────────────────
          if (stageResult.ok) {
            const downstreamStages = markDownstreamStale(stage)
            for (const ds of downstreamStages) {
              const dsRow = repos.stageOutputs.getBySessionAndStage(sessionId, ds)
              if (dsRow && dsRow.status !== 'pending') {
                repos.stageOutputs.update({
                  id: dsRow.id,
                  status: 'stale',
                  prompt_used: dsRow.prompt_used,
                  raw_output: dsRow.raw_output,
                  error: dsRow.error,
                })
              }
            }
          }

          // ── 10b. Assemble special: insert final_version + transition ─
          if (stage === 'assemble' && stageResult.ok && stageResult.final_text) {
            const finalText = stageResult.final_text

            // Determine next version_no (max + 1)
            const latestVersion = repos.finalVersions.getLatestBySession(sessionId)
            const nextVersionNo = (latestVersion?.version_no ?? 0) + 1

            repos.finalVersions.insert({
              session_id: sessionId,
              version_no: nextVersionNo,
              text: finalText,
              source: 'assemble',
            })

            // Transition state → assembled
            try {
              service.transitionState(sessionId, 'assembled')
            } catch {
              // State transition may fail if not in coordinating — ignore
            }
          }

          // ── 11. Emit final event ─────────────────────────────────
          if (stageResult.ok) {
            sseStream(controller, 'stage_complete', {
              stage,
              code: stageResult.code,
              raw_text: stageResult.raw_text,
            })
          } else {
            // Emit appropriate error event
            sseStream(controller, 'stage_error', {
              stage,
              code: stageResult.code,
              detail: stageResult.detail,
            })
          }
        }

        sseStream(controller, 'done', {})
        controller.close()
      },
      cancel() {
        // Stream was aborted by client — no cleanup needed beyond abort propagation
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  }

  return { POST }
}
