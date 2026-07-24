'use client'

// ---------------------------------------------------------------------------
// StageStepper —— 四节点统筹步进器（TID stage-stepper）
// 节点状态：pending 灰 / running 脉冲 / complete 墨绿 / failed 朱红 /
//           stale 琥珀 + stage-stale-badge「已过期」
// 顺序守卫 UI 化：仅前置 complete 且全局无在飞阶段时可点（不可跨节点运行）
// ---------------------------------------------------------------------------

import type { Stage } from '@/src/lib/contracts/types'
import { TID } from '@/src/lib/testids'
import { Badge, Button, Spinner } from '@/src/components/ui'
import {
  STAGES,
  canRunStage,
  nodeStatus,
  stageBlockReason,
  type StageRowMap,
  type StageStatus,
} from './stage-meta'

export interface StageStepperProps {
  stageRows: StageRowMap
  runningStage: Stage | null
  sessionState: string | null
  /** 各节点的瞬态提示（模型重试 / POST 守卫错误） */
  transientNotes?: Partial<Record<Stage, string | null>>
  onRun: (stage: Stage) => void
}

// ---- 状态视觉映射（全部取自设计 tokens：ink/line/pine/cinnabar/amber） ----

const circleClass: Record<StageStatus, string> = {
  pending: 'border-line-2 bg-paper-raise text-ink-4',
  running: 'border-ink bg-ink text-paper animate-pulse',
  complete: 'border-pine bg-pine text-paper',
  failed: 'border-cinnabar bg-cinnabar text-paper',
  stale: 'border-amber bg-amber/15 text-amber',
}

const circleGlyph: Record<StageStatus, 'number' | 'check' | 'cross'> = {
  pending: 'number',
  running: 'number',
  complete: 'check',
  failed: 'cross',
  stale: 'number',
}

const statusTextClass: Record<StageStatus, string> = {
  pending: 'text-ink-4',
  running: 'text-ink-2',
  complete: 'text-pine',
  failed: 'text-cinnabar',
  stale: 'text-amber',
}

const statusLabel: Record<StageStatus, string> = {
  pending: '待运行',
  running: '运行中……',
  complete: '完成',
  failed: '失败',
  stale: '已过期',
}

export function StageStepper({
  stageRows,
  runningStage,
  sessionState,
  transientNotes,
  onRun,
}: StageStepperProps) {
  return (
    <ol data-testid={TID.stage.stepper} className="space-y-0">
      {STAGES.map((meta, i) => {
        const status = nodeStatus(meta.key, stageRows, runningStage)
        const runnable = canRunStage(meta.key, stageRows, sessionState, runningStage)
        const blockReason = runnable
          ? null
          : stageBlockReason(meta.key, stageRows, sessionState, runningStage)
        const note = transientNotes?.[meta.key] ?? null
        const row = stageRows[meta.key]
        const hasRunBefore = row != null && row.status !== 'pending'

        return (
          <li
            key={meta.key}
            data-stage={meta.key}
            aria-current={runnable ? 'step' : undefined}
            className="flex gap-3"
          >
            {/* 左轨：状态圆 + 连接线 */}
            <div className="flex flex-col items-center">
              <button
                type="button"
                disabled={!runnable}
                onClick={() => onRun(meta.key)}
                title={
                  runnable
                    ? `运行「${meta.label}」`
                    : (blockReason ?? undefined)
                }
                aria-label={`运行${meta.label}`}
                className={[
                  'flex h-7 w-7 shrink-0 items-center justify-center rounded-xs border font-serif text-sm transition-colors duration-150',
                  circleClass[status],
                  runnable
                    ? 'cursor-pointer hover:shadow-card'
                    : 'cursor-not-allowed',
                ].join(' ')}
              >
                {circleGlyph[status] === 'check' ? (
                  <span aria-hidden>✓</span>
                ) : circleGlyph[status] === 'cross' ? (
                  <span aria-hidden>✕</span>
                ) : (
                  i + 1
                )}
              </button>
              {i < STAGES.length - 1 && (
                <span
                  aria-hidden
                  className={[
                    'my-1 w-px flex-1',
                    status === 'complete' ? 'bg-pine/40' : 'bg-line',
                  ].join(' ')}
                />
              )}
            </div>

            {/* 本体：标签 + 状态行 + 操作 */}
            <div className={i < STAGES.length - 1 ? 'min-w-0 flex-1 pb-5' : 'min-w-0 flex-1'}>
              <div className="flex items-center justify-between gap-2">
                <p
                  className={[
                    'text-sm font-medium leading-7',
                    status === 'pending' ? 'text-ink-3' : 'text-ink',
                  ].join(' ')}
                >
                  {meta.label}
                </p>
                <Button
                  testId={TID.stage.runStageButton}
                  variant={runnable ? 'primary' : 'outline'}
                  size="sm"
                  disabled={!runnable}
                  title={runnable ? undefined : (blockReason ?? undefined)}
                  onClick={() => onRun(meta.key)}
                  className="h-7 px-2.5 text-xs"
                >
                  {status === 'running' ? (
                    <>
                      <Spinner size="sm" /> 运行中
                    </>
                  ) : hasRunBefore ? (
                    '重跑'
                  ) : (
                    '运行'
                  )}
                </Button>
              </div>

              <p className="text-xs leading-5 text-ink-3">{meta.hint}</p>

              {/* 状态行：文案 + stale 徽章 */}
              <p className={`mt-1 flex items-center gap-1.5 text-xs ${statusTextClass[status]}`}>
                {status === 'running' && <Spinner size="sm" />}
                {blockReason && status === 'pending' ? blockReason : statusLabel[status]}
                {status === 'stale' && (
                  <Badge
                    testId={TID.stage.staleBadge}
                    variant="outline"
                    title="上游已重跑，需重新运行"
                    className="border-amber/60 text-amber"
                  >
                    已过期
                  </Badge>
                )}
              </p>

              {/* failed 节点：错误摘要与原始输出细节在面板内 */}
              {status === 'failed' && row?.error && (
                <p className="mt-1 truncate text-xs text-cinnabar" title={row.error}>
                  {row.error}
                </p>
              )}

              {/* 瞬态提示：模型自动重试 / 守卫拒绝 */}
              {note && (
                <p className="mt-1 text-xs text-amber" role="status">
                  {note}
                </p>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
