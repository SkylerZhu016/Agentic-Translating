'use client'

// ---------------------------------------------------------------------------
// CoordinatorPanel —— 统筹视图容器（stepper + 四张阶段输出面板）
// 运行：点击节点 / run-stage-button → POST stages/[stage]/run（SSE）
// 完成/失败后一律重取服务端会话（不缓存前端阶段结果），stale 级联由服务端下发
// 全部 complete → 滚动至 final-text 并提示「可开始对话修改」
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Stage } from '@/src/lib/contracts/types'
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

type StreamTextMap = Record<Stage, string>
type NoteMap = Partial<Record<Stage, string | null>>

const EMPTY_STREAM: StreamTextMap = { review: '', filter: '', orchestrate: '', assemble: '' }

export function CoordinatorPanel() {
  const { data, sessionId, refresh } = useSessionFull()
  const [runningStage, setRunningStage] = useState<Stage | null>(null)
  const [streamText, setStreamText] = useState<StreamTextMap>(EMPTY_STREAM)
  const [notes, setNotes] = useState<NoteMap>({})
  const [completionNotice, setCompletionNotice] = useState<string | null>(null)

  // 仅在「本次运行后达成全部完成」时滚动+提示（挂载即完成不打扰）
  const justRanRef = useRef(false)

  const stageRows = useMemo(() => toStageRowMap(data?.stages), [data?.stages])
  const sessionState = data?.session?.state ?? null
  const allComplete = useMemo(() => allStagesComplete(stageRows), [stageRows])

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
        onSchemaError: (info) =>
          setNotes((prev) => ({
            ...prev,
            [info.stage]: `输出未通过校验${info.attempt ? `（第 ${info.attempt} 次）` : ''}，正在自动重试……`,
          })),
        onError: (s, message) => setNotes((prev) => ({ ...prev, [s]: message })),
      })

      // 服务端为准：重取全量会话（含 stale 级联与 assemble 产生的新版本）
      await refresh()
      emitSessionChanged(sessionId)
      setRunningStage(null)
    },
    [sessionId, runningStage, stageRows, sessionState, refresh],
  )

  // 全部完成 → 滚动到最终文本区 + 对话提示
  useEffect(() => {
    if (!allComplete || !justRanRef.current) return
    justRanRef.current = false
    setCompletionNotice('四阶段全部完成——可开始对话修改')
    document
      .querySelector('[data-testid="final-text"]')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [allComplete])

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
          暂无会话——请先在左侧粘贴原文并开始翻译
        </p>
      )}
      {data && (sessionState === 'draft' || sessionState === 'translating') && (
        <p className="rounded-sm border border-dashed border-line-2 bg-paper/60 px-4 py-3 text-center text-xs text-ink-4">
          翻译进行中，完成后各阶段将解锁……
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
