'use client'

// ---------------------------------------------------------------------------
// AgentStreamCard — 单 Agent 流式卡片（R1 多模型并行可视化）
//
// 头部：agent 名 + 模型 + 状态徽章
//   streaming → 墨色呼吸点脉冲 / complete → 墨绿 / error → 朱红
// 体部：流式逐字渲染（等宽草稿 + 块光标）→ 完成后切换 .poem-text-sm 排版
// error 卡：错误摘要 + retry-agent-button（仅该卡重流式）
// ---------------------------------------------------------------------------

import { Badge, Button, Spinner } from '@/src/components/ui'
import { TID } from '@/src/lib/testids'
import type { AgentCardState } from './use-translation'

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
  if (status === 'streaming') {
    return (
      <span
        data-testid={TID.translate.agentStatusStreaming}
        className="inline-flex items-center gap-1.5 rounded-xs border border-line-2 px-1.5 py-0.5 text-[0.6875rem] font-medium leading-4 tracking-wide text-ink"
      >
        <span className="h-1.5 w-1.5 animate-breathe rounded-full bg-ink" aria-hidden />
        翻译中
      </span>
    )
  }
  if (status === 'complete') {
    return (
      <span
        data-testid={TID.translate.agentStatusComplete}
        className="inline-flex items-center gap-1.5 rounded-xs border border-pine/40 bg-pine/10 px-1.5 py-0.5 text-[0.6875rem] font-medium leading-4 tracking-wide text-pine"
      >
        完成
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span
        data-testid={TID.translate.agentStatusError}
        className="inline-flex items-center gap-1.5 rounded-xs border border-cinnabar/40 bg-cinnabar/10 px-1.5 py-0.5 text-[0.6875rem] font-medium leading-4 tracking-wide text-cinnabar"
      >
        失败
      </span>
    )
  }
  return <Badge variant="subtle">等待</Badge>
}

// ── 卡片 ────────────────────────────────────────────────────────

export function AgentStreamCard({
  card,
  enterDelayMs = 0,
  retrying,
  retryDisabled,
  onRetry,
}: AgentStreamCardProps) {
  const errorTone = card.status === 'error'

  return (
    <article
      data-testid={TID.translate.agentStreamCard}
      data-agent-key={card.agentKey}
      style={{ animationDelay: `${enterDelayMs}ms` }}
      className={[
        'flex min-h-40 animate-rise flex-col rounded-md border bg-paper-raise shadow-card transition-colors duration-200',
        errorTone ? 'border-cinnabar/45' : 'border-line',
      ].join(' ')}
    >
      {/* 头部：名 + 模型 + 状态 */}
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 pb-2.5 pt-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <h3 className="truncate font-serif text-sm font-semibold text-ink">{card.name}</h3>
          <span className="shrink-0 font-mono text-[0.6875rem] leading-4 text-ink-3">
            {card.model}
          </span>
        </div>
        <StatusBadge status={card.status} />
      </header>

      {/* 体部：流式草稿 → 译文排版 */}
      <div className="flex-1 px-4 py-3">
        {card.status === 'error' ? (
          <div className="flex h-full flex-col items-start gap-3">
            <p className="text-sm leading-6 text-cinnabar">{card.error ?? '未知错误'}</p>
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
                  <Spinner size="sm" /> 重试中…
                </>
              ) : (
                '重试此 Agent'
              )}
            </Button>
          </div>
        ) : card.text.length > 0 ? (
          card.status === 'complete' ? (
            <p className="poem-text-sm max-h-80 overflow-y-auto pr-1">{card.text}</p>
          ) : (
            <p className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words pr-1 font-mono text-[0.8125rem] leading-6 text-ink-2">
              {card.text}
              <span
                className="ml-0.5 inline-block h-3.5 w-[7px] animate-pulse bg-ink-2 align-[-2px]"
                aria-hidden
              />
            </p>
          )
        ) : (
          <p className="text-sm leading-6 text-ink-4">
            {card.status === 'streaming' ? '等待首个字词抵达…' : '排队等待开始…'}
          </p>
        )}
      </div>
    </article>
  )
}
