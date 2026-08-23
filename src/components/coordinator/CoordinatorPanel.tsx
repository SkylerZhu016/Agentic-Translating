'use client'

// ---------------------------------------------------------------------------
// CoordinatorPanel —— 统筹视图容器（stepper + 四张阶段输出面板）
// 运行：点击节点 / run-stage-button → POST stages/[stage]/run（SSE）
// 完成/失败后一律重取服务端会话（不缓存前端阶段结果），stale 级联由服务端下发
// 全部 complete → 滚动至 final-text 并提示「可开始对话修改」
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Stage, StageOutputRow } from '@/src/lib/contracts/types'
import { useSessionFull } from './use-session'
import { emitSessionChanged } from './session-bus'
import { runStageStream } from './run-stage'
import {
  STAGES,
  allStagesComplete,
  canRunStage,
  toStageRowMap,
} from './stage-meta'
import { StageStepper } from './StageStepper'
import { StageOutputPanel } from './StageOutputPanel'
import { Badge, Button, Modal, Spinner } from '@/src/components/ui'
import { parseSemanticAgentOutput } from '@/src/lib/protocol/semantic-output'
import type { CandidateAnnotationMode } from '@/src/lib/contracts/vnext'
import { useI18n } from '@/src/i18n/LocaleProvider'
import { localizeDiagnosticError } from '@/src/i18n/diagnostic'
import type { Translator } from '@/src/i18n/types'
import { localizedStageMeta } from './localized-stage'

type StreamTextMap = Record<Stage, string>
type NoteMap = Partial<Record<Stage, string | null>>

const EMPTY_STREAM: StreamTextMap = { review: '', filter: '', orchestrate: '', assemble: '' }

function readableWorkflowError(error: string, t: Translator) {
  if (/504 Gateway Time-?out/i.test(error)) {
    return t('coordinator.error.gatewayTimeout')
  }
  if (/fetch failed/i.test(error)) {
    return t('coordinator.error.fetchFailed')
  }
  if (/<(?:!doctype|html|head|body)\b/i.test(error)) {
    return t('coordinator.error.htmlResponse')
  }
  return error
}

function AutomaticWorkflowProgress({
  data,
  action,
  actionError,
  onPause,
  onContinue,
  onContinueCurrent,
  regenerationAnnotationMode,
  onRegenerationAnnotationModeChange,
  onRegenerate,
  onRegenerateCurrent,
  onRestart,
}: {
  data: NonNullable<ReturnType<typeof useSessionFull>['data']>
  action: string | null
  actionError: string | null
  onPause: () => void
  onContinue: () => void
  onContinueCurrent: () => void
  regenerationAnnotationMode: CandidateAnnotationMode
  onRegenerationAnnotationModeChange: (
    mode: CandidateAnnotationMode,
  ) => void
  onRegenerate: () => void
  onRegenerateCurrent: () => void
  onRestart: () => void
}) {
  const { t } = useI18n()
  const snapshot = JSON.parse(data.session.config_snapshot) as {
    orchestrationPolicy?: { reviewMode?: 'main_editor' | 'four_stage' }
    agentVariantSnapshots?: Array<{
      id: string
      catalogName: string
    }>
  }
  const reviewMode =
    snapshot.orchestrationPolicy?.reviewMode ??
    data.session.review_mode ??
    'main_editor'
  const invocations = data.invocations ?? []
  const isContextAnalysis = (item: typeof invocations[number]) => {
    try {
      return (
        (JSON.parse(item.agent_snapshot) as { roleKind?: string }).roleKind ===
        'context_analysis'
      )
    } catch {
      return false
    }
  }
  const contextInvocations = invocations.filter(isContextAnalysis)
  const translationInvocations = invocations.filter(
    (item) => !isContextAnalysis(item),
  )
  const completedContext = contextInvocations.filter(
    (item) => item.status === 'complete',
  ).length
  const contextSettled =
    contextInvocations.length > 0 &&
    contextInvocations.every((item) =>
      ['complete', 'failed', 'interrupted'].includes(item.status),
    )
  const completedTranslations = translationInvocations.filter(
    (item) => item.status === 'complete',
  ).length
  const translationsSettled =
    translationInvocations.length > 0 &&
    translationInvocations.every((item) =>
      ['complete', 'failed', 'interrupted'].includes(item.status),
    )
  const latestRun = data.runs?.[data.runs.length - 1]
  const runActive =
    latestRun?.status === 'queued' || latestRun?.status === 'running'
  const runRecoverable =
    latestRun?.status === 'failed' || latestRun?.status === 'interrupted'
  const canContinue =
    ['draft', 'translated', 'translating', 'coordinating'].includes(
      data.session.state,
    ) &&
    !runActive &&
    data.finalVersion == null &&
    (
      completedTranslations > 0 ||
      completedContext > 0 ||
      runRecoverable
    )
  const continueFromCandidates = completedTranslations >= 2
  const canRegenerate =
    completedTranslations >= 2 &&
    !runActive &&
    ['translated', 'assembled', 'refining'].includes(data.session.state)
  const teamDecision = (() => {
    const decisionEvent = [...(data.events ?? [])]
      .reverse()
      .find((event) => {
        if (event.event_type !== 'tool.called') return false
        try {
          return (
            (JSON.parse(event.payload_json) as { name?: string }).name ===
            'call_agents'
          )
        } catch {
          return false
        }
      })
    if (!decisionEvent) return []
    try {
      const payload = JSON.parse(decisionEvent.payload_json) as {
        calls?: Array<{
          agentVariantId: string
          selectionReason?: string
        }>
      }
      return (payload.calls ?? []).map((call) => ({
        id: call.agentVariantId,
        name:
          snapshot.agentVariantSnapshots?.find(
            (variant) => variant.id === call.agentVariantId,
          )?.catalogName ?? call.agentVariantId,
        reason: call.selectionReason ?? t('coordinator.team.defaultReason'),
      }))
    } catch {
      return []
    }
  })()
  const preAnalysisStep = {
    label: t('coordinator.step.context'),
    complete: contextSettled && completedContext > 0,
    failed: contextSettled && completedContext === 0,
  }
  const candidateStep = {
    label: t('coordinator.step.candidates'),
    complete: translationsSettled && completedTranslations >= 2,
    failed: translationsSettled && completedTranslations < 2,
  }
  const mainSteps = [
    preAnalysisStep,
    {
      label: t('coordinator.step.team'),
      complete: translationInvocations.length > 0,
      showTeamDecision: true,
    },
    candidateStep,
    {
      label: t('coordinator.step.draft'),
      complete: data.versions.length > 0,
    },
    {
      label: t('coordinator.step.submit'),
      complete: data.finalVersion != null,
    },
  ]
  const fourSteps = STAGES.map((meta) => {
    const row = data.stages.find((item) => item.stage === meta.key)
    return {
      label: localizedStageMeta(meta.key, t).label,
      complete: row?.status === 'complete',
      failed: row?.status === 'failed',
      row,
    }
  })
  const steps =
    reviewMode === 'four_stage'
      ? [preAnalysisStep, candidateStep, ...fourSteps]
      : mainSteps

  return (
    <div className="space-y-3">
      <div className="rounded-sm border border-line bg-paper/55 px-3 py-2 text-xs leading-5 text-ink-3">
        {t('coordinator.auto.description')}
      </div>
      <div className="flex flex-wrap gap-2">
        {runActive && (
          <Button
            size="sm"
            variant="outline"
            disabled={action != null}
            onClick={onPause}
          >
            {action === 'pause'
              ? <><Spinner size="sm" /> {t('coordinator.action.pausing')}</>
              : t('coordinator.action.pause')}
          </Button>
        )}
        {canContinue && (
          <>
            <Button
              size="sm"
              disabled={action != null}
              onClick={onContinue}
            >
              {action === 'continue'
                ? <><Spinner size="sm" /> {t('coordinator.action.resuming')}</>
                : continueFromCandidates
                  ? t('coordinator.action.continueFrozen')
                  : t('coordinator.action.continueCheckpoint')}
            </Button>
            {continueFromCandidates && (
              <Button
                size="sm"
                variant="outline"
                disabled={action != null}
                onClick={onContinueCurrent}
                title={t('coordinator.action.continueCurrentTitle')}
              >
                {action === 'continue-current'
                  ? <><Spinner size="sm" /> {t('coordinator.action.resuming')}</>
                  : t('coordinator.action.continueCurrent')}
              </Button>
            )}
          </>
        )}
        {canRegenerate && (
          <div className="flex flex-wrap items-center gap-2 rounded-sm border border-line bg-paper/55 px-2 py-1.5">
            <label className="flex items-center gap-2 text-xs text-ink-3">
              {t('coordinator.regenerate.context')}
              <select
                value={regenerationAnnotationMode}
                disabled={action != null}
                onChange={(event) =>
                  onRegenerationAnnotationModeChange(
                    event.target.value as CandidateAnnotationMode,
                  )
                }
                className="h-8 rounded-sm border border-line-2 bg-paper-raise px-2 text-xs text-ink"
              >
                <option value="body_only">{t('coordinator.regenerate.bodyOnly')}</option>
                <option value="body_and_annotation">{t('coordinator.regenerate.withAnnotation')}</option>
              </select>
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={action != null}
              onClick={onRegenerate}
            >
              {action === 'regenerate'
                ? <><Spinner size="sm" /> {t('coordinator.regenerate.running')}</>
                : t('coordinator.regenerate.frozen')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={action != null}
              onClick={onRegenerateCurrent}
              title={t('coordinator.regenerate.currentTitle')}
            >
              {action === 'regenerate-current'
                ? <><Spinner size="sm" /> {t('coordinator.regenerate.running')}</>
                : t('coordinator.regenerate.current')}
            </Button>
          </div>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={action != null || runActive}
          onClick={onRestart}
          title={runActive ? t('coordinator.restart.pauseFirst') : undefined}
        >
          {action === 'restart'
            ? <><Spinner size="sm" /> {t('coordinator.restart.running')}</>
            : t('coordinator.restart.action')}
        </Button>
      </div>
      {data.runControl?.candidates_stale === 1 && (
        <p className="rounded-sm border border-amber/40 bg-amber/5 px-3 py-2 text-xs leading-5 text-ink-2">
          {t('coordinator.candidatesStale')}
        </p>
      )}
      {actionError && (
        <p role="alert" className="rounded-sm border border-cinnabar/40 bg-cinnabar/5 px-3 py-2 text-xs text-cinnabar">
          {actionError}
        </p>
      )}
      <ol className="space-y-2">
        {steps.map((step, index) => {
          const stageRow =
            'row' in step
              ? (step.row as StageOutputRow | undefined)
              : undefined
          const failed = 'failed' in step && step.failed
          const running =
            !step.complete &&
            !failed &&
            index === steps.findIndex((item) => !item.complete)
          return (
            <li
              key={step.label}
              className="rounded-sm border border-line bg-paper-raise px-3 py-2.5"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-ink">
                  {index + 1}. {step.label}
                </span>
                <Badge
                  variant={step.complete ? 'outline' : failed ? 'subtle' : 'subtle'}
                >
                  {step.complete
                    ? t('stage.status.complete')
                    : failed
                      ? t('stage.status.failed')
                      : running && latestRun?.status === 'running'
                        ? t('stage.status.running')
                        : t('coordinator.status.waiting')}
                </Badge>
              </div>
              {stageRow?.raw_output && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-ink-3">
                    {t('coordinator.output.open')}
                  </summary>
                  <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-ink-2">
                    {parseSemanticAgentOutput(stageRow.raw_output).body}
                  </p>
                </details>
              )}
              {'showTeamDecision' in step &&
                step.showTeamDecision &&
                teamDecision.length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-ink-3">
                      {t('coordinator.team.open')}
                    </summary>
                    <ul className="mt-2 space-y-2">
                      {teamDecision.map((item) => (
                        <li
                          key={item.id}
                          className="rounded-sm border border-line/70 bg-paper/60 px-2.5 py-2"
                        >
                          <p className="text-xs font-medium text-ink-2">
                            {item.name}
                          </p>
                          <p className="mt-1 text-xs leading-5 text-ink-3">
                            {item.reason}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              {stageRow?.error && (
                <p className="mt-2 text-xs text-cinnabar">{stageRow.error}</p>
              )}
            </li>
          )
        })}
      </ol>
      {latestRun?.error && (
        <p className="rounded-sm border border-cinnabar/40 bg-cinnabar/5 px-3 py-2 text-xs text-cinnabar">
          {readableWorkflowError(latestRun.error, t)}
        </p>
      )}
    </div>
  )
}

export function CoordinatorPanel() {
  const { t } = useI18n()
  const { data, sessionId, refresh } = useSessionFull()
  const router = useRouter()
  const [runningStage, setRunningStage] = useState<Stage | null>(null)
  const [streamText, setStreamText] = useState<StreamTextMap>(EMPTY_STREAM)
  const [notes, setNotes] = useState<NoteMap>({})
  const [completionNotice, setCompletionNotice] = useState<string | null>(null)
  const [workflowAction, setWorkflowAction] = useState<string | null>(null)
  const [regenerationAnnotationMode, setRegenerationAnnotationMode] =
    useState<CandidateAnnotationMode>('body_only')
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false)
  const [workflowActionError, setWorkflowActionError] =
    useState<string | null>(null)

  useEffect(() => {
    if (!data) return
    try {
      const snapshot = JSON.parse(data.session.config_snapshot) as {
        orchestrationPolicy?: {
          candidateAnnotationMode?: CandidateAnnotationMode
        }
      }
      setRegenerationAnnotationMode(
        snapshot.orchestrationPolicy?.candidateAnnotationMode ?? 'body_only',
      )
    } catch {
      setRegenerationAnnotationMode('body_only')
    }
  }, [data?.session.id, data?.session.config_snapshot])

  const postWorkflowAction = useCallback(async (
    action:
      | 'pause'
      | 'continue'
      | 'continue-current'
      | 'regenerate'
      | 'regenerate-current'
      | 'restart',
  ) => {
    if (!sessionId || workflowAction) return
    setWorkflowAction(action)
    setWorkflowActionError(null)
    try {
      const path =
        action === 'pause'
          ? 'control'
          : action === 'continue' || action === 'continue-current'
            ? 'run'
            : action === 'regenerate-current'
              ? 'regenerate'
              : action
      const response = await fetch(`/api/sessions/${sessionId}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...(action === 'pause'
          ? { body: JSON.stringify({ action: 'pause' }) }
          : action === 'continue-current'
            ? { body: JSON.stringify({ configMode: 'current' }) }
            : action === 'regenerate' || action === 'regenerate-current'
              ? {
                  body: JSON.stringify({
                    candidateAnnotationMode: regenerationAnnotationMode,
                    configMode:
                      action === 'regenerate-current' ? 'current' : 'frozen',
                  }),
                }
            : {}),
      })
      const payload = await response.json().catch(() => ({})) as {
        error?: string
        sessionId?: string
      }
      if (!response.ok) {
        throw new Error(localizeDiagnosticError(
          t,
          payload.error,
          t('coordinator.error.action'),
        ))
      }
      if (action === 'restart' && payload.sessionId) {
        router.push(`/?session=${encodeURIComponent(payload.sessionId)}`)
        return
      }
      await refresh()
      emitSessionChanged(sessionId)
    } catch (error) {
      setWorkflowActionError(
        error instanceof Error ? error.message : String(error),
      )
    } finally {
      setWorkflowAction(null)
    }
  }, [
    refresh,
    regenerationAnnotationMode,
    router,
    sessionId,
    workflowAction,
    t,
  ])

  // 仅在「本次运行后达成全部完成」时滚动+提示（挂载即完成不打扰）
  const justRanRef = useRef(false)

  const stageRows = useMemo(() => toStageRowMap(data?.stages), [data?.stages])
  const sessionState = data?.session?.state ?? null
  const allComplete = useMemo(() => allStagesComplete(stageRows), [stageRows])
  const isVNext = useMemo(() => {
    try {
      return data
        ? (JSON.parse(data.session.config_snapshot) as { version?: number })
            .version === 3
        : false
    } catch {
      return false
    }
  }, [data])

  const run = useCallback(
    async (stage: Stage) => {
      if (!sessionId || runningStage !== null) return
      if (!canRunStage(stage, stageRows, sessionState, null)) return

      justRanRef.current = true
      setRunningStage(stage)
      setCompletionNotice(null)
      setStreamText((prev) => ({ ...prev, [stage]: '' }))
      setNotes((prev) => ({ ...prev, [stage]: null }))

      await runStageStream(sessionId, stage, {
        onDelta: (s, content) =>
          setStreamText((prev) => ({ ...prev, [s]: prev[s] + content })),
        onError: (s, message) => setNotes((prev) => ({ ...prev, [s]: message })),
        messages: {
          network: t('stage.error.network'),
          request: (status) => t('stage.error.request', { status }),
          stage: t('stage.error.run'),
          connection: t('stage.error.connection'),
        },
        localizeError: (value, fallback) =>
          localizeDiagnosticError(t, value, fallback),
      })

      // 服务端为准：重取全量会话（含 stale 级联与 assemble 产生的新版本）
      await refresh()
      emitSessionChanged(sessionId)
      setRunningStage(null)
    },
    [sessionId, runningStage, stageRows, sessionState, refresh, t],
  )

  // 全部完成 → 滚动到最终文本区 + 对话提示
  useEffect(() => {
    if (!allComplete || !justRanRef.current) return
    justRanRef.current = false
    setCompletionNotice(t('coordinator.complete'))
    document
      .querySelector('[data-testid="final-text"]')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [allComplete, t])

  if (data && isVNext) {
    return (
      <>
        <AutomaticWorkflowProgress
          data={data}
          action={workflowAction}
          actionError={workflowActionError}
          onPause={() => void postWorkflowAction('pause')}
          onContinue={() => void postWorkflowAction('continue')}
          onContinueCurrent={() => void postWorkflowAction('continue-current')}
          regenerationAnnotationMode={regenerationAnnotationMode}
          onRegenerationAnnotationModeChange={setRegenerationAnnotationMode}
          onRegenerate={() => void postWorkflowAction('regenerate')}
          onRegenerateCurrent={() =>
            void postWorkflowAction('regenerate-current')
          }
          onRestart={() => setRestartConfirmOpen(true)}
        />
        <Modal
          open={restartConfirmOpen}
          onClose={() => setRestartConfirmOpen(false)}
          title={t('coordinator.restart.title')}
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => setRestartConfirmOpen(false)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                onClick={() => {
                  setRestartConfirmOpen(false)
                  void postWorkflowAction('restart')
                }}
              >
                {t('coordinator.restart.confirm')}
              </Button>
            </>
          }
        >
          <p className="text-sm leading-6 text-ink-2">
            {t('coordinator.restart.description')}
          </p>
        </Modal>
      </>
    )
  }

  return (
    <div className="space-y-4">
      <StageStepper
        stageRows={stageRows}
        runningStage={runningStage}
        sessionState={sessionState}
        transientNotes={notes}
        onRun={run}
      />

      {/* 完成提示：墨绿纸条 */}
      {completionNotice && (
        <p
          role="status"
          className="animate-rise rounded-xs border border-pine/40 bg-pine/10 px-3 py-2 text-xs text-pine"
        >
          ✓ {completionNotice}
        </p>
      )}

      {/* 无会话 / 翻译未就绪引导 */}
      {!data && (
        <p className="rounded-sm border border-dashed border-line-2 bg-paper/60 px-4 py-4 text-center text-xs leading-5 text-ink-4">
          {t('coordinator.noSession')}
        </p>
      )}
      {data && (sessionState === 'draft' || sessionState === 'translating') && (
        <p className="rounded-sm border border-dashed border-line-2 bg-paper/60 px-4 py-3 text-center text-xs text-ink-4">
          {t('coordinator.translationRunning')}
        </p>
      )}

      {/* 四张输出面板常驻渲染（R3：中间产物全部可见，不折叠） */}
      <div className="space-y-3">
        {STAGES.map((meta) => (
          <StageOutputPanel
            key={meta.key}
            stage={meta.key}
            row={stageRows[meta.key]}
            running={runningStage === meta.key}
            streamText={streamText[meta.key]}
            canRun={canRunStage(meta.key, stageRows, sessionState, runningStage)}
            onRun={run}
          />
        ))}
      </div>
    </div>
  )
}
