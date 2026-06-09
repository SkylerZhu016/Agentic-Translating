'use client'

// ---------------------------------------------------------------------------
// StageOutputPanel —— 每阶段一张输出面板（TID stage-output-panel，data-stage 区分）
// 四张面板常驻不折叠（R3 中间可见）；结构化渲染 C2 schema：
//   review      → assessments 表格（agent/优劣/score/keep）
//   filter      → 选中名单 + rationale + 淘汰灰显
//   orchestrate → structure_notes + segment_assignments 列表
//   assemble    → .poem-text 最终译文 + notes
//   failed      → 错误详情 + 重跑按钮；schema_error 解析细节折叠
//   stale       → 琥珀提醒条 + 旧内容保持可见
// ---------------------------------------------------------------------------

import type { z } from 'zod'
import type { Stage, StageOutputRow } from '@/src/lib/contracts/types'
import type {
  assembleOutputSchema,
  filterOutputSchema,
  orchestrateOutputSchema,
  reviewOutputSchema,
} from '@/src/lib/contracts/schemas'
import { TID } from '@/src/lib/testids'
import { Badge, Button, Spinner } from '@/src/components/ui'
import { STAGE_INDEX, STAGES, type StageStatus } from './stage-meta'

// ---- C2 输出类型（type-only 导入，零运行时漂移） ----
type ReviewOutput = z.infer<typeof reviewOutputSchema>
type FilterOutput = z.infer<typeof filterOutputSchema>
type OrchestrateOutput = z.infer<typeof orchestrateOutputSchema>
type AssembleOutput = z.infer<typeof assembleOutputSchema>

export interface StageOutputPanelProps {
  stage: Stage
  row: StageOutputRow | null
  running: boolean
  /** orchestrate/assemble 的流式 delta 累积文本 */
  streamText: string
  canRun: boolean
  onRun: (stage: Stage) => void
}

function parseOutput<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

const STAGE_STATUS_LABEL: Record<StageStatus, string> = {
  pending: '尚未运行',
  running: '运行中',
  complete: '完成',
  failed: '失败',
  stale: '已过期',
}

export function StageOutputPanel({
  stage,
  row,
  running,
  streamText,
  canRun,
  onRun,
}: StageOutputPanelProps) {
  const meta = STAGES[STAGE_INDEX[stage]]
  const status: StageStatus = running ? 'running' : (row?.status ?? 'pending')
  const isStreamingStage = stage === 'orchestrate' || stage === 'assemble'

  return (
    <section
      data-stage={stage}
      data-testid={TID.stage.outputPanel}
      aria-label={`${meta.label}阶段输出`}
      className="rounded-sm border border-line bg-paper-raise/70 px-4 py-3"
    >
      {/* 面板头：阶段名 + 状态 */}
      <header className="flex items-center justify-between gap-2">
        <p className="overline-label">
          {String(STAGE_INDEX[stage] + 1).padStart(2, '0')} · {meta.label}
        </p>
        <span className="flex items-center gap-1.5">
          {status === 'complete' && <Badge className="bg-pine text-paper">完成</Badge>}
          {status === 'failed' && <Badge className="bg-cinnabar text-paper">失败</Badge>}
          {status === 'stale' && (
            <Badge
              variant="outline"
              title="上游已重跑，需重新运行"
              className="border-amber/60 text-amber"
            >
              已过期
            </Badge>
          )}
          {status === 'running' && (
            <Badge variant="subtle">
              <Spinner size="sm" /> {STAGE_STATUS_LABEL.running}
            </Badge>
          )}
        </span>
      </header>

      {/* stale 提醒条：内容保持可见（R3），仅提示需重跑 */}
      {status === 'stale' && (
        <p className="mt-2 rounded-xs border border-amber/40 bg-amber/10 px-2.5 py-1.5 text-xs text-amber">
          此结果已过期——上游已重跑，需重新运行本阶段
        </p>
      )}

      <div className="mt-2.5">
        {/* 运行中：流式阶段渲染 delta，非流式阶段显示等待动画 */}
        {status === 'running' &&
          (isStreamingStage ? (
            <div className="rounded-xs border border-line bg-paper px-3 py-2">
              {streamText ? (
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs leading-5 text-ink-2">
                  {streamText}
                  <span aria-hidden className="animate-pulse text-ink">
                    ▍
                  </span>
                </pre>
              ) : (
                <p className="flex items-center gap-2 text-xs text-ink-3">
                  <Spinner size="sm" /> 统筹 Agent 正在{meta.label}……
                </p>
              )}
            </div>
          ) : (
            <p className="flex items-center gap-2 py-3 text-xs text-ink-3">
              <Spinner size="sm" /> 统筹 Agent 正在{meta.label}译文，请稍候……
            </p>
          ))}

        {/* 失败：错误详情 + 解析细节折叠 + 重跑 */}
        {status === 'failed' && (
          <div className="rounded-xs border border-cinnabar/40 bg-cinnabar/5 px-3 py-2.5">
            <p className="text-xs font-medium text-cinnabar">本阶段运行失败</p>
            {row?.error && (
              <p className="mt-1 text-xs leading-5 text-cinnabar/90">{row.error}</p>
            )}
            {(row?.error || row?.raw_output) && (
              <details className="mt-2">
                <summary className="cursor-pointer select-none text-xs text-ink-3 hover:text-ink-2">
                  解析细节 / 原始输出
                </summary>
                <div className="mt-1.5 space-y-1.5">
                  {row?.error && (
                    <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-xs bg-paper px-2 py-1.5 font-mono text-[0.6875rem] leading-4 text-cinnabar/80">
                      {row.error}
                    </pre>
                  )}
                  {row?.raw_output && (
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-xs bg-paper px-2 py-1.5 font-mono text-[0.6875rem] leading-4 text-ink-3">
                      {row.raw_output}
                    </pre>
                  )}
                </div>
              </details>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={!canRun}
              onClick={() => onRun(stage)}
              className="mt-2.5 border-cinnabar/50 text-cinnabar hover:bg-cinnabar/10"
            >
              重跑本阶段
            </Button>
          </div>
        )}

        {/* 完成 / 过期：结构化内容（stale 时保持可见） */}
        {(status === 'complete' || status === 'stale') && (
          <StageStructuredBody stage={stage} row={row} />
        )}

        {/* 未运行占位 */}
        {status === 'pending' && (
          <p className="py-2 text-xs text-ink-4">尚未运行——{meta.hint}</p>
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// 结构化内容分发
// ---------------------------------------------------------------------------

function StageStructuredBody({ stage, row }: { stage: Stage; row: StageOutputRow | null }) {
  switch (stage) {
    case 'review':
      return <ReviewBody data={parseOutput<ReviewOutput>(row?.parsed_output ?? null)} />
    case 'filter':
      return <FilterBody data={parseOutput<FilterOutput>(row?.parsed_output ?? null)} />
    case 'orchestrate':
      return (
        <OrchestrateBody data={parseOutput<OrchestrateOutput>(row?.parsed_output ?? null)} />
      )
    case 'assemble':
      return <AssembleBody data={parseOutput<AssembleOutput>(row?.parsed_output ?? null)} />
  }
}

function UnparsedFallback({ raw }: { raw: string | null }) {
  if (!raw) return <p className="py-1 text-xs text-ink-4">输出为空</p>
  return (
    <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-xs bg-paper px-2.5 py-2 font-mono text-[0.6875rem] leading-4 text-ink-3">
      {raw}
    </pre>
  )
}

// ---- review：assessments 表格（agent / 优劣 / score / keep） ----

function ReviewBody({ data }: { data: ReviewOutput | null }) {
  if (!data || !Array.isArray(data.assessments)) return <UnparsedFallback raw={null} />
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-line text-left text-ink-3">
            <th className="py-1.5 pr-3 font-medium">Agent</th>
            <th className="py-1.5 pr-3 font-medium">优势</th>
            <th className="py-1.5 pr-3 font-medium">劣势</th>
            <th className="py-1.5 pr-3 font-medium">评分</th>
            <th className="py-1.5 font-medium">取舍</th>
          </tr>
        </thead>
        <tbody>
          {data.assessments.map((a) => (
            <tr key={a.agent_id} className="border-b border-line/60 align-top last:border-0">
              <td className="py-2 pr-3 font-mono text-[0.6875rem] text-ink-2">{a.agent_id}</td>
              <td className="py-2 pr-3 leading-5 text-ink-2">{a.strengths.join('；')}</td>
              <td className="py-2 pr-3 leading-5 text-ink-3">{a.weaknesses.join('；')}</td>
              <td className="py-2 pr-3">
                <span className="font-serif text-sm text-ink">{a.quality_score}</span>
                <span className="text-ink-4"> / 10</span>
                <span
                  aria-hidden
                  className="mt-1 block h-0.5 w-12 rounded-full bg-paper-sink"
                >
                  <span
                    className="block h-full rounded-full bg-pine"
                    style={{ width: `${Math.min(100, Math.max(0, a.quality_score * 10))}%` }}
                  />
                </span>
              </td>
              <td className="py-2">
                {a.keep ? (
                  <Badge className="bg-pine text-paper">保留</Badge>
                ) : (
                  <Badge variant="subtle">淘汰</Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---- filter：选中名单 + rationale + 淘汰灰显 ----

function FilterBody({ data }: { data: FilterOutput | null }) {
  if (!data) return <UnparsedFallback raw={null} />
  const selected = data.selected_agent_ids ?? []
  const rejected = data.rejected_agent_ids ?? []
  return (
    <div className="space-y-2.5">
      <div>
        <p className="text-xs font-medium text-ink-3">选中译文</p>
        <p className="mt-1 flex flex-wrap gap-1.5">
          {selected.map((id) => (
            <Badge key={id} className="bg-pine text-paper">
              {id}
            </Badge>
          ))}
        </p>
      </div>
      {rejected.length > 0 && (
        <div>
          <p className="text-xs font-medium text-ink-3">淘汰</p>
          <p className="mt-1 flex flex-wrap gap-1.5">
            {rejected.map((id) => (
              <Badge
                key={id}
                variant="subtle"
                className="text-ink-4 line-through decoration-ink-4/60"
              >
                {id}
              </Badge>
            ))}
          </p>
        </div>
      )}
      {data.rationale && (
        <div>
          <p className="text-xs font-medium text-ink-3">筛选理由</p>
          <p className="mt-1 text-xs leading-5 text-ink-2">{data.rationale}</p>
        </div>
      )}
    </div>
  )
}

// ---- orchestrate：structure_notes + segment_assignments ----

function OrchestrateBody({ data }: { data: OrchestrateOutput | null }) {
  if (!data) return <UnparsedFallback raw={null} />
  const assignments = data.segment_assignments ?? []
  return (
    <div className="space-y-2.5">
      {data.structure_notes && (
        <div>
          <p className="text-xs font-medium text-ink-3">结构笔记</p>
          <p className="mt-1 text-xs leading-5 text-ink-2">{data.structure_notes}</p>
        </div>
      )}
      <div>
        <p className="text-xs font-medium text-ink-3">段落分配（{assignments.length}）</p>
        <ol className="mt-1.5 space-y-2">
          {assignments.map((seg) => (
            <li
              key={seg.segment_index}
              className="rounded-xs border border-line bg-paper px-2.5 py-2"
            >
              <p className="flex items-center gap-1.5 text-[0.6875rem] text-ink-3">
                <span className="font-mono">#{seg.segment_index}</span>
                <span aria-hidden>·</span>
                <span>
                  来源 <span className="font-mono">{seg.source_agent_id}</span>
                </span>
              </p>
              <blockquote className="poem-text-sm mt-1.5 border-l-2 border-line-2 pl-2.5">
                {seg.source_segment}
              </blockquote>
              <p className="mt-1.5 text-[0.6875rem] leading-4 text-ink-3">{seg.rationale}</p>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}

// ---- assemble：最终译文 .poem-text + notes ----

function AssembleBody({ data }: { data: AssembleOutput | null }) {
  if (!data) return <UnparsedFallback raw={null} />
  return (
    <div className="space-y-2.5">
      <div className="rounded-xs border border-line bg-paper px-3.5 py-3">
        <p className="poem-text">{data.final_text}</p>
      </div>
      {data.notes && (
        <div>
          <p className="text-xs font-medium text-ink-3">组装笔记</p>
          <p className="mt-1 text-xs leading-5 text-ink-2">{data.notes}</p>
        </div>
      )}
    </div>
  )
}
