// ---------------------------------------------------------------------------
// 统筹顺序守卫（C5 UI 化）单元测试 —— Wave 4 Task 23
// canRunStage / stageBlockReason / nodeStatus / allStagesComplete / toStageRowMap
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import type { Stage, StageOutputRow } from '@/src/lib/contracts/types'
import {
  allStagesComplete,
  canRunStage,
  nodeStatus,
  stageBlockReason,
  toStageRowMap,
  type StageRowMap,
} from '@/src/components/coordinator/stage-meta'

function row(stage: Stage, status: StageOutputRow['status']): StageOutputRow {
  return {
    id: 1,
    session_id: 's1',
    stage,
    status,
    prompt_used: null,
    raw_output: null,
    parsed_output: null,
    error: null,
    created_at: '2026-01-01 00:00:00',
  }
}

const empty: StageRowMap = { review: null, filter: null, orchestrate: null, assemble: null }

describe('canRunStage — C5 顺序守卫', () => {
  it('翻译未完成（translating/draft）→ 全部不可运行', () => {
    expect(canRunStage('review', empty, 'translating', null)).toBe(false)
    expect(canRunStage('review', empty, 'draft', null)).toBe(false)
    expect(canRunStage('review', empty, null, null)).toBe(false)
  })

  it('translated 后仅 review 可运行（首节点无前置）', () => {
    expect(canRunStage('review', empty, 'translated', null)).toBe(true)
    expect(canRunStage('filter', empty, 'translated', null)).toBe(false)
    expect(canRunStage('orchestrate', empty, 'translated', null)).toBe(false)
    expect(canRunStage('assemble', empty, 'translated', null)).toBe(false)
  })

  it('前置 complete 才解锁下一节点（逐节点推进）', () => {
    const rows: StageRowMap = { ...empty, review: row('review', 'complete') }
    expect(canRunStage('filter', rows, 'coordinating', null)).toBe(true)
    expect(canRunStage('orchestrate', rows, 'coordinating', null)).toBe(false)
    expect(canRunStage('assemble', rows, 'coordinating', null)).toBe(false)
  })

  it('前置 stale → 不可跳过运行（stale 不算完成）', () => {
    const rows: StageRowMap = {
      ...empty,
      review: row('review', 'complete'),
      filter: row('filter', 'complete'),
      orchestrate: row('orchestrate', 'stale'),
    }
    expect(canRunStage('assemble', rows, 'coordinating', null)).toBe(false)
    expect(canRunStage('orchestrate', rows, 'coordinating', null)).toBe(true) // stale 可重跑
  })

  it('任一阶段在飞 → 其他节点全部禁止（禁跨节点并发）', () => {
    const rows: StageRowMap = { ...empty, review: row('review', 'complete') }
    expect(canRunStage('filter', rows, 'coordinating', 'review')).toBe(false)
    expect(canRunStage('review', rows, 'coordinating', 'review')).toBe(false)
  })

  it('assembled/refining 状态下允许重跑（服务端一致）', () => {
    expect(canRunStage('review', empty, 'assembled', null)).toBe(true)
    expect(canRunStage('review', empty, 'refining', null)).toBe(true)
    expect(canRunStage('review', empty, 'done', null)).toBe(false)
  })

  it('failed 节点可重跑；完成节点亦可重跑（触发下游 stale）', () => {
    const rows: StageRowMap = {
      ...empty,
      review: row('review', 'complete'),
      filter: row('filter', 'failed'),
    }
    expect(canRunStage('filter', rows, 'coordinating', null)).toBe(true)
    expect(canRunStage('review', rows, 'coordinating', null)).toBe(true)
  })
})

describe('stageBlockReason — 禁用原因文案', () => {
  it('可运行 → null', () => {
    expect(stageBlockReason('review', empty, 'translated', null)).toBeNull()
  })
  it('前置 stale → 提示需先重跑前置', () => {
    const rows: StageRowMap = { ...empty, review: row('review', 'stale') }
    expect(stageBlockReason('filter', rows, 'coordinating', null)).toContain('已过期')
  })
  it('前置未运行 → 提示需先完成', () => {
    expect(stageBlockReason('assemble', empty, 'coordinating', null)).toContain('需先完成')
  })
  it('翻译未完成 → 等待翻译完成', () => {
    expect(stageBlockReason('review', empty, 'translating', null)).toBe('等待翻译完成')
  })
})

describe('nodeStatus / allStagesComplete / toStageRowMap', () => {
  it('本地 running 覆盖服务端状态（在飞窗口期）', () => {
    const rows: StageRowMap = { ...empty, review: row('review', 'complete') }
    expect(nodeStatus('review', rows, 'review')).toBe('running')
    expect(nodeStatus('review', rows, null)).toBe('complete')
    expect(nodeStatus('filter', rows, null)).toBe('pending')
  })

  it('allStagesComplete 仅当四节点全部 complete', () => {
    const partial: StageRowMap = {
      review: row('review', 'complete'),
      filter: row('filter', 'complete'),
      orchestrate: row('orchestrate', 'complete'),
      assemble: null,
    }
    expect(allStagesComplete(partial)).toBe(false)
    expect(allStagesComplete({ ...partial, assemble: row('assemble', 'complete') })).toBe(true)
    expect(
      allStagesComplete({ ...partial, assemble: row('assemble', 'stale') }),
    ).toBe(false)
  })

  it('toStageRowMap 将行数组索引为阶段映射', () => {
    const map = toStageRowMap([row('filter', 'complete'), row('review', 'stale')])
    expect(map.review?.status).toBe('stale')
    expect(map.filter?.status).toBe('complete')
    expect(map.orchestrate).toBeNull()
    expect(toStageRowMap(undefined).assemble).toBeNull()
  })
})
