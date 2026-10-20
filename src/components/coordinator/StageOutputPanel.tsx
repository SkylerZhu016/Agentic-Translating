'use client'

// ---------------------------------------------------------------------------
// StageOutputPanel —— 每阶段一张输出面板（TID stage-output-panel，data-stage 区分）
// 四张面板保持中间结果可见；JSON协议的正文与注释分区显示：
//   流式正文按有界窗口显示，思考、注释、原始响应默认折叠且卸载长文本
//   failed                        → 错误详情 + 重跑按钮；原始输出折叠
//   stale                         → 琥珀提醒条 + 旧内容保持可见
// ---------------------------------------------------------------------------

import { useMemo } from 'react'
import type { Stage, StageOutputRow } from '@/src/lib/contracts/types'
import { TID } from '@/src/lib/testids'
import { Badge, Button, Spinner } from '@/src/components/ui'
import { BoundedText, CollapsibleText } from '@/src/components/ui/BoundedText'
import { STAGE_INDEX, type StageStatus } from './stage-meta'
import { parseSemanticAgentOutput, semanticOutputFormatForPrompt } from '@/src/lib/protocol/semantic-output'
import { useI18n } from '@/src/i18n/LocaleProvider'
import { localizedStageMeta, localizedStageStatus } from './localized-stage'
import { localizeDiagnosticError } from '@/src/i18n/diagnostic'

export interface StageOutputPanelProps {
  stage: Stage
  row: StageOutputRow | null
  running: boolean
  /** orchestrate/assemble 的流式 delta 累积文本 */
  streamText: string
  streamAnnotation?: string
  reasoningPreview?: string
  reasoningCharacters?: number
  reasoningTruncated?: boolean
  canRun: boolean
  /** Automatic workflows rerun through their shared coordinator action. */
  showRunAction?: boolean
  onRun: (stage: Stage) => void
}

export function StageOutputPanel({
  stage,
  row,
  running,
  streamText,
  streamAnnotation = '',
  reasoningPreview = '',
  reasoningCharacters = 0,
  canRun,
  showRunAction = true,
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
        {reasoningPreview ? (
          <CollapsibleText
            className="mb-2 rounded-sm border border-line bg-paper-sink/50 px-2.5 py-1.5"
            title={t('reasoning.preview')}
            meta={t('reasoning.received', { count: reasoningCharacters })}
            description={t('reasoning.limited')}
            text={reasoningPreview}
            tailPreview
            streaming={running}
            viewportClassName="max-h-48"
            textClassName="font-mono text-xs leading-5 text-ink-3"
          />
        ) : reasoningCharacters > 0 ? (
          <p className="mb-2 text-[0.6875rem] leading-5 text-ink-4">
            {t('reasoning.stats', { count: reasoningCharacters })}
          </p>
        ) : null}
        {/* 运行中：流式阶段渲染 delta，非流式阶段显示等待动画 */}
        {status === 'running' &&
          (isStreamingStage || streamText ? (
            <div className="rounded-xs border border-line bg-paper px-3 py-2">
              {streamText ? (
                <BoundedText
                  text={streamText}
                  streaming
                  viewportClassName="max-h-56"
                  textClassName="text-sm leading-6 text-ink-2"
                  downloadFileName={`${stage}-text.txt`}
                />
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
        {status === 'running' && streamAnnotation && (
          <CollapsibleText
            className="mt-2"
            title={t('agent.annotation')}
            text={streamAnnotation}
            streaming
            viewportClassName="max-h-48"
            textClassName="text-xs leading-5 text-ink-3"
            downloadFileName={`${stage}-annotation.txt`}
          />
        )}

        {/* 失败：错误详情 + 解析细节折叠 + 重跑 */}
        {status === 'failed' && (
          <div className="rounded-xs border border-cinnabar/40 bg-cinnabar/5 px-3 py-2.5">
            <p className="text-xs font-medium text-cinnabar">{t('stage.output.failed')}</p>
            {localizedError && (
              <BoundedText
                className="mt-1"
                text={localizedError}
                viewportClassName="max-h-40"
                textClassName="text-xs leading-5 text-cinnabar/90"
              />
            )}
            {(row?.error || row?.raw_output) && (
              <CollapsibleText
                className="mt-2"
                title={t('stage.output.rawDetails')}
                text={row?.raw_output ?? localizedError ?? ''}
                viewportClassName="max-h-48"
                textClassName="font-mono text-[0.6875rem] leading-5 text-ink-3"
                downloadFileName={`${stage}-raw-response.txt`}
              />
            )}
            {showRunAction && (
              <Button
                variant="outline"
                size="sm"
                disabled={!canRun}
                onClick={() => onRun(stage)}
                className="mt-2.5 border-cinnabar/50 text-cinnabar hover:bg-cinnabar/10"
              >
                {t('stage.output.rerun')}
              </Button>
            )}
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
  const { t } = useI18n()
  const raw = row?.raw_output ?? null
  const parsed = useMemo(() => {
    if (!raw) return null
    try {
      return {
        output: parseSemanticAgentOutput(raw, {
          format: semanticOutputFormatForPrompt(row?.prompt_used ?? '') === 'json' ? 'json' : 'legacy',
        }),
        error: null,
      }
    } catch (error) {
      return {
        output: null,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }, [raw, row?.prompt_used])

  if (!raw) return <p className="py-1 text-xs text-ink-4">{t('stage.output.empty')}</p>
  return (
    <div className="space-y-2">
      {parsed?.error && (
        <p role="alert" className="text-xs leading-5 text-cinnabar">
          {localizeDiagnosticError(t, parsed.error, t('stage.error.run'))}
        </p>
      )}
      {parsed?.output?.body && (
        <div className="rounded-xs border border-line bg-paper px-3 py-2.5">
          <BoundedText
            text={parsed.output.body}
            textClassName={stage === 'assemble' ? 'poem-text' : 'text-sm leading-6 text-ink-2'}
            viewportClassName="max-h-64"
            downloadFileName={`${stage}-text.txt`}
          />
        </div>
      )}
      {parsed?.output?.annotation && (
        <CollapsibleText
          title={t('agent.annotation')}
          text={parsed.output.annotation}
          viewportClassName="max-h-48"
          textClassName="text-xs leading-5 text-ink-3"
          downloadFileName={`${stage}-annotation.txt`}
        />
      )}
      <CollapsibleText
        title={t('stage.output.rawResponse')}
        text={raw}
        viewportClassName="max-h-48"
        textClassName="font-mono text-[0.6875rem] leading-5 text-ink-3"
        downloadFileName={`${stage}-raw-response.txt`}
      />
    </div>
  )
}
