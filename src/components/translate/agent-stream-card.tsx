'use client'

// ---------------------------------------------------------------------------
// AgentStreamCard — 单 Agent 流式卡片（R1 多模型并行可视化）
//
// 头部：agent 名 + 模型 + 状态徽章
//   streaming → 墨色呼吸点脉冲 / complete → 墨绿 / error → 朱红
// 体部：有界流式正文 → 完成后切换 .poem-text-sm 排版；思考与注释独立折叠
// error 卡：错误摘要 + retry-agent-button（仅该卡重流式）
// ---------------------------------------------------------------------------

import { memo, useState } from 'react'
import { Badge, Button, Spinner } from '@/src/components/ui'
import { BoundedText, CollapsibleText } from '@/src/components/ui/BoundedText'
import { TID } from '@/src/lib/testids'
import type { AgentCardState } from './use-translation'
import { useI18n } from '@/src/i18n/LocaleProvider'
import { localizeDiagnosticError } from '@/src/i18n/diagnostic'
import { localizeEvidenceSummary } from '@/src/i18n/evidence'

function evidenceHasFindings(report: NonNullable<AgentCardState['evidence']>) {
  return [
    report.requiredTermsMissing,
    report.forbiddenTermsFound,
    report.numberWarnings,
    report.structureWarnings,
    report.punctuationWarnings,
    report.rhymeWarnings,
    report.boundaryWarnings,
  ].some((warnings) => warnings.length > 0)
}

export interface AgentStreamCardProps {
  card: AgentCardState
  /** 卡片入场延迟（ stagger，秒） */
  enterDelayMs?: number
  retrying: boolean
  retryDisabled: boolean
  onRetry: (agentKey: string) => void
}

// ── 状态徽章 ────────────────────────────────────────────────────

function StatusBadge({ status }: { status: AgentCardState['status'] }) {
  const { t } = useI18n()
  if (status === 'streaming') {
    return (
      <span
        data-testid={TID.translate.agentStatusStreaming}
        className="inline-flex items-center gap-1.5 rounded-xs border border-line-2 px-1.5 py-0.5 text-[0.6875rem] font-medium leading-4 tracking-wide text-ink"
      >
        <Spinner size="sm" />
        {t('agent.status.streaming')}
      </span>
    )
  }
  if (status === 'complete') {
    return (
      <span
        data-testid={TID.translate.agentStatusComplete}
        className="inline-flex items-center gap-1.5 rounded-xs border border-pine/40 bg-pine/10 px-1.5 py-0.5 text-[0.6875rem] font-medium leading-4 tracking-wide text-pine"
      >
        {t('agent.status.complete')}
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span
        data-testid={TID.translate.agentStatusError}
        className="inline-flex items-center gap-1.5 rounded-xs border border-cinnabar/40 bg-cinnabar/10 px-1.5 py-0.5 text-[0.6875rem] font-medium leading-4 tracking-wide text-cinnabar"
      >
        {t('agent.status.error')}
      </span>
    )
  }
  return <Badge variant="subtle">{t('agent.status.pending')}</Badge>
}

// ── 卡片 ────────────────────────────────────────────────────────

export const AgentStreamCard = memo(function AgentStreamCard({
  card,
  enterDelayMs = 0,
  retrying,
  retryDisabled,
  onRetry,
}: AgentStreamCardProps) {
  const { t } = useI18n()
  const errorTone = card.status === 'error'
  const [attemptsOpen, setAttemptsOpen] = useState(false)

  return (
    <article
      data-testid={TID.translate.agentStreamCard}
      data-agent-key={card.agentKey}
      data-agent-kind={card.kind ?? 'translation'}
      style={{ animationDelay: `${enterDelayMs}ms` }}
      className={[
        'flex min-w-0 min-h-32 animate-rise flex-col rounded-lg border bg-paper-raise shadow-card transition-colors duration-200',
        errorTone ? 'border-cinnabar/45' : 'border-line',
      ].join(' ')}
    >
      {/* 头部：名 + 模型 + 状态 */}
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-4 pb-2.5 pt-3">
        <div className="min-w-0 flex-1">
          <h3 className="break-words text-sm font-semibold text-ink">{card.name}</h3>
          <span className="mt-0.5 block break-all font-mono text-[0.6875rem] leading-4 text-ink-4">
            {card.model}
          </span>
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-1.5">
          {(card.attempts?.length ?? 0) > 1 && (
            <Badge variant="subtle">{t('agent.attemptCount', { count: card.attempts!.length })}</Badge>
          )}
          {card.kind === 'context_analysis' && (
            <Badge variant="outline">{t('agent.kind.contextAnalysis')}</Badge>
          )}
          {card.kind === 'poetry_plan' && (
            <Badge variant="outline">{t('agent.kind.poetryPlan')}</Badge>
          )}
          {card.evidence && (
            <Badge variant={evidenceHasFindings(card.evidence) ? 'subtle' : 'outline'}>
              {localizeEvidenceSummary(t, card.evidence.summary)}
            </Badge>
          )}
          <StatusBadge status={card.status} />
        </div>
      </header>

      {/* 体部：流式草稿 → 译文排版 */}
      <div className="flex-1 px-4 py-3">
        {card.reasoningPreview ? (
          <CollapsibleText
            className="mb-3 rounded-sm border border-line bg-paper-sink/50 px-2.5 py-1.5"
            title={t('reasoning.preview')}
            meta={t('reasoning.received', { count: card.reasoningCharacters ?? card.reasoningPreview?.length ?? 0 })}
            description={t('reasoning.limited')}
            text={card.reasoningPreview ?? ''}
            tailPreview
            streaming={card.status === 'streaming'}
            viewportClassName="max-h-48"
            textClassName="font-mono text-xs leading-5 text-ink-3"
          />
        ) : (card.reasoningCharacters ?? 0) > 0 ? (
          <p className="mb-3 text-[0.6875rem] leading-5 text-ink-4">
            {t('reasoning.stats', { count: card.reasoningCharacters ?? 0 })}
          </p>
        ) : null}
        {card.status === 'error' ? (
          <div className="flex h-full flex-col items-start gap-3">
            <BoundedText
              text={localizeDiagnosticError(
                t,
                card.error,
                card.error ?? t('error.unknown'),
              )}
              viewportClassName="max-h-48"
              textClassName="text-sm leading-6 text-cinnabar"
            />
            <Button
              variant="outline"
              size="sm"
              testId={TID.translate.retryAgentButton}
              disabled={retryDisabled || retrying}
              onClick={() => onRetry(card.agentKey)}
              className="mt-auto"
            >
              {retrying ? (
                <>
                  <Spinner size="sm" /> {t('agent.retrying')}
                </>
              ) : (
                t('agent.retry')
              )}
            </Button>
          </div>
        ) : card.text.length > 0 ? (
          <BoundedText
            text={card.text}
            streaming={card.status === 'streaming'}
            downloadFileName={`${card.agentKey}-text.txt`}
            textClassName={card.status === 'complete'
              ? 'poem-text-sm'
              : 'font-mono text-[0.8125rem] leading-6 text-ink-2'}
          />
        ) : (
          card.status === 'streaming' ? (
            <div
              role="status"
              aria-label={t('agent.thinking.label', { name: card.name })}
              className="flex min-h-24 items-center justify-center gap-2 text-sm leading-6 text-ink-4"
            >
              <Spinner size="sm" />
              <span>
                {card.lastActivityAt
                  ? t('agent.thinking.active')
                  : t('agent.thinking.waiting')}
              </span>
            </div>
          ) : (
            <p className="text-sm leading-6 text-ink-4">{t('agent.queued')}</p>
          )
        )}
      </div>
      {card.status === 'complete' && card.kind === 'translation' && (
        <div className="flex justify-end border-t border-line px-4 py-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={retryDisabled || retrying}
            onClick={() => onRetry(card.agentKey)}
          >
            {retrying ? (
              <>
                <Spinner size="sm" /> {t('agent.refreshing')}
              </>
            ) : (
              t('agent.refresh')
            )}
          </Button>
        </div>
      )}
      {(card.annotation || card.evidence) && (
        <div className="border-t border-line px-4 py-2">
          {card.annotation && (
            <CollapsibleText
              title={t('agent.annotation')}
              text={card.annotation}
              streaming={card.status === 'streaming'}
              downloadFileName={`${card.agentKey}-annotation.txt`}
              viewportClassName="max-h-56"
              textClassName="text-xs leading-5 text-ink-3"
            />
          )}
          {card.evidence && (
            <CollapsibleText
              className={card.annotation ? 'mt-2' : ''}
              title={t('agent.evidenceDetails')}
              text={card.evidence.naturalLanguage}
              downloadFileName={`${card.agentKey}-evidence.txt`}
              viewportClassName="max-h-56"
              textClassName="text-xs leading-5 text-ink-3"
            />
          )}
        </div>
      )}
      {(card.attempts?.length ?? 0) > 1 && (
        <div className="border-t border-line px-4 py-2">
          <details onToggle={(event) => setAttemptsOpen(event.currentTarget.open)}>
            <summary className="cursor-pointer text-xs font-medium text-ink-3">
              {t('agent.attempts')}
            </summary>
            {attemptsOpen && <ol className="mt-2 max-h-64 space-y-1 overflow-y-auto text-xs leading-5 text-ink-3">
              {card.attempts!.map((attempt, index) => (
                <li key={attempt.id}>
                  {t('agent.attemptLine', {
                    number: index + 1,
                    model: attempt.model,
                    status: attempt.status,
                  })}
                  {attempt.error && (
                    <BoundedText
                      text={localizeDiagnosticError(t, attempt.error, t('error.unknown'))}
                      viewportClassName="max-h-32"
                      textClassName="text-xs leading-5 text-ink-3"
                    />
                  )}
                </li>
              ))}
            </ol>}
          </details>
        </div>
      )}
    </article>
  )
})
