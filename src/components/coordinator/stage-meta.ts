// ---------------------------------------------------------------------------
// 四阶段元数据 + 顺序守卫（C5 UI 化，纯函数可测）
// ---------------------------------------------------------------------------

import type { Stage, StageOutputRow } from '@/src/lib/contracts/types'

export interface StageMeta {
  key: Stage
  label: string
  hint: string
}

/** 与 contracts/types.ts 的 Stage 一一对应（顺序即前置链） */
export const STAGES: readonly StageMeta[] = [
  { key: 'review', label: '审查', hint: '评析各 Agent 译文优劣' },
  { key: 'filter', label: '筛选', hint: '择优保留候选译文' },
  { key: 'orchestrate', label: '编排', hint: '规划整合与修订策略' },
  { key: 'assemble', label: '组装', hint: '合成最终译文' },
] as const

export const STAGE_INDEX: Record<Stage, number> = {
  review: 0,
  filter: 1,
  orchestrate: 2,
  assemble: 3,
}

/** 允许运行统筹阶段的会话状态（与服务端 COORDINATION_RUN_STATES 一致） */
export const COORDINATION_RUN_STATES: ReadonlySet<string> = new Set([
  'translated',
  'coordinating',
  'assembled',
  'refining',
])

export type StageStatus = 'pending' | 'running' | 'complete' | 'failed' | 'stale'

export type StageRowMap = Record<Stage, StageOutputRow | null>

/** DB 行数组 → 按阶段索引（每阶段至多一条，服务端唯一约束保证） */
export function toStageRowMap(rows: StageOutputRow[] | undefined | null): StageRowMap {
  const map: StageRowMap = { review: null, filter: null, orchestrate: null, assemble: null }
  for (const row of rows ?? []) {
    if (row.stage in map) map[row.stage] = row
  }
  return map
}

/** 节点显示状态：本地运行标记优先于服务端行（覆盖在飞窗口期） */
export function nodeStatus(
  stage: Stage,
  rows: StageRowMap,
  runningStage: Stage | null,
): StageStatus {
  if (runningStage === stage) return 'running'
  return rows[stage]?.status ?? 'pending'
}

/**
 * 顺序守卫：仅当——
 *  1. 会话处于可统筹状态（翻译已完成）
 *  2. 无其他阶段在飞（禁止跨节点并发运行）
 *  3. 前置阶段 status === 'complete'（stale 不算完成，不可跳过）
 * 才允许运行本阶段。
 */
export function canRunStage(
  stage: Stage,
  rows: StageRowMap,
  sessionState: string | null,
  runningStage: Stage | null,
): boolean {
  if (sessionState == null || !COORDINATION_RUN_STATES.has(sessionState)) return false
  if (runningStage !== null) return false
  const idx = STAGE_INDEX[stage]
  if (idx === 0) return true
  const prereq = STAGES[idx - 1].key
  return rows[prereq]?.status === 'complete'
}

/** 不可运行时的原因文案（用于禁用按钮 tooltip / 节点提示行） */
export function stageBlockReason(
  stage: Stage,
  rows: StageRowMap,
  sessionState: string | null,
  runningStage: Stage | null,
): string | null {
  if (canRunStage(stage, rows, sessionState, runningStage)) return null
  if (runningStage !== null) {
    return runningStage === stage ? null : '另一阶段正在运行'
  }
  if (sessionState == null) return '暂无会话'
  if (!COORDINATION_RUN_STATES.has(sessionState)) return '等待翻译完成'
  const idx = STAGE_INDEX[stage]
  if (idx > 0) {
    const prereqMeta = STAGES[idx - 1]
    const prereqStatus = rows[prereqMeta.key]?.status ?? 'pending'
    if (prereqStatus === 'stale') return `「${prereqMeta.label}」已过期，需先重跑`
    if (prereqStatus === 'failed') return `「${prereqMeta.label}」运行失败，需先重跑`
    if (prereqStatus !== 'complete') return `需先完成「${prereqMeta.label}」`
  }
  return null
}

/** 全部四阶段均完成（触发最终译文滚动 + 对话提示的前置条件） */
export function allStagesComplete(rows: StageRowMap): boolean {
  return STAGES.every((s) => rows[s.key]?.status === 'complete')
}
