'use client'

// ---------------------------------------------------------------------------
// StageOutputPanel —— 每阶段一张输出面板（TID stage-output-panel，data-stage 区分）
// 四张面板常驻不折叠（R3 中间可见）；统一渲染原始文本：
//   review / filter / orchestrate → raw_output 原始文本
//   assemble                      → FSBP 正文 + raw_output 原始文本
//   failed                        → 错误详情 + 重跑按钮；原始输出折叠
//   stale                         → 琥珀提醒条 + 旧内容保持可见
// ---------------------------------------------------------------------------

import type { Stage, StageOutputRow } from '@/src/lib/contracts/types'
import { TID } from '@/src/lib/testids'
import { Badge, Button, Spinner } from '@/src/components/ui'
import { STAGE_INDEX, type StageStatus } from './stage-meta'
import { parseSemanticAgentOutput } from '@/src/lib/protocol/semantic-output'
import { useI18n } from '@/src/i18n/LocaleProvider'
import { localizedStageMeta, localizedStageStatus } from './localized-stage'
import { localizeDiagnosticError } from '@/src/i18n/diagnostic'

export interface StageOutputPanelProps {
  stage: Stage
  row: StageOutputRow | null
  running: boolean
  /** orchestrate/assemble 的流式 delta 累积文本 */
  streamText: string
  canRun: boolean
  onRun: (stage: Stage) => void
}

export function StageOutputPanel({
  stage,
  row,
  running,
  streamText,
  canRun,
  onRun,
}: StageOutputPanelProps) {
  const { t } = useI18n()
  const meta = localizedStageMeta(stage, t)
  const localizedError = row?.error
    ? localizeDiagnosticError(t, row.error, t('stage.error.run'))
    : null
  const status: StageStatus = running ? 'running' : (row?.status ?? 'pending')
  const isStreamingStage = stage === 'orchestrate' || stage === 'assemble'

  return (
    <section
      data-stage={stage}
      data-testid={TID.stage.outputPanel}
      aria-label={t('stage.output.aria', { stage: meta.label })}
      className="rounded-sm border border-line bg-paper-raise/70 px-4 py-3"
    >
      {/* 面板头：阶段名 + 状态 */}
      <header className="flex items-center justify-between gap-2">
        <p className="overline-label">
          {String(STAGE_INDEX[stage] + 1).padStart(2, '0')} · {meta.label}
        </p>
        <span className="flex items-center gap-1.5">
          {status === 'complete' && <Badge className="bg-pine text-paper">{t('stage.status.complete')}</Badge>}
          {status === 'failed' && <Badge className="bg-cinnabar text-paper">{t('stage.status.failed')}</Badge>}
          {status === 'stale' && (
            <Badge
              variant="outline"
              title={t('stage.stale.title')}
              className="border-amber/60 text-amber"
            >
              {t('stage.status.stale')}
            </Badge>
          )}
          {status === 'running' && (
            <Badge variant="subtle">
              <Spinner size="sm" /> {localizedStageStatus('running', t)}
            </Badge>
          )}
        </span>
      </header>

      {/* stale 提醒条：内容保持可见（R3），仅提示需重跑 */}
      {status === 'stale' && (
        <p className="mt-2 rounded-xs border border-amber/40 bg-amber/10 px-2.5 py-1.5 text-xs text-amber">
          {t('stage.output.stale')}
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
                  <Spinner size="sm" /> {t('stage.output.streaming', { stage: meta.label })}
                </p>
              )}
            </div>
          ) : (
            <p className="flex items-center gap-2 py-3 text-xs text-ink-3">
              <Spinner size="sm" /> {t('stage.output.processing', { stage: meta.label })}
            </p>
          ))}

        {/* 失败：错误详情 + 解析细节折叠 + 重跑 */}
        {status === 'failed' && (
          <div className="rounded-xs border border-cinnabar/40 bg-cinnabar/5 px-3 py-2.5">
            <p className="text-xs font-medium text-cinnabar">{t('stage.output.failed')}</p>
            {localizedError && (
              <p className="mt-1 text-xs leading-5 text-cinnabar/90">{localizedError}</p>
            )}
            {(row?.error || row?.raw_output) && (
              <details className="mt-2">
                <summary className="cursor-pointer select-none text-xs text-ink-3 hover:text-ink-2">
                  {t('stage.output.rawDetails')}
                </summary>
                <div className="mt-1.5 space-y-1.5">
                  {localizedError && (
                    <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-xs bg-paper px-2 py-1.5 font-mono text-[0.6875rem] leading-4 text-cinnabar/80">
                      {localizedError}
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
              {t('stage.output.rerun')}
            </Button>
          </div>
        )}

        {/* 完成 / 过期：自由文本内容（stale 时保持可见） */}
        {(status === 'complete' || status === 'stale') && (
          <StageStructuredBody stage={stage} row={row} />
        )}

        {/* 未运行占位 */}
        {status === 'pending' && (
          <p className="py-2 text-xs text-ink-4">{t('stage.output.pending', { hint: meta.hint })}</p>
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// 自由文本内容分发
// ---------------------------------------------------------------------------

function StageStructuredBody({ stage, row }: { stage: Stage; row: StageOutputRow | null }) {
  const raw = row?.raw_output ?? null
  switch (stage) {
    case 'review':
      return <ReviewBody raw={raw} />
    case 'filter':
      return <FilterBody raw={raw} />
    case 'orchestrate':
      return <OrchestrateBody raw={raw} />
    case 'assemble':
      return <AssembleBody raw={raw} />
  }
}

function UnparsedFallback({ raw }: { raw: string | null }) {
  const { t } = useI18n()
  if (!raw) return <p className="py-1 text-xs text-ink-4">{t('stage.output.empty')}</p>
  return (
    <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-xs bg-paper px-2.5 py-2 font-mono text-[0.6875rem] leading-4 text-ink-3">
      {raw}
    </pre>
  )
}

// ---- review：raw text ----

function ReviewBody({ raw }: { raw: string | null }) {
  return <UnparsedFallback raw={raw} />
}

// ---- filter：raw text ----

function FilterBody({ raw }: { raw: string | null }) {
  return <UnparsedFallback raw={raw} />
}

// ---- orchestrate：raw text ----

function OrchestrateBody({ raw }: { raw: string | null }) {
  return <UnparsedFallback raw={raw} />
}

// ---- assemble：final_text + raw output ----

function AssembleBody({ raw }: { raw: string | null }) {
  const finalText = raw ? parseSemanticAgentOutput(raw).body : null
  return (
    <div className="space-y-2.5">
      {finalText && (
        <div className="rounded-xs border border-line bg-paper px-3.5 py-3">
          <p className="poem-text">{finalText}</p>
        </div>
      )}
      <UnparsedFallback raw={raw} />
    </div>
  )
}
