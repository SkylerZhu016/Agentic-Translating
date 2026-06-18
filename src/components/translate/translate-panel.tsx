'use client'

// ---------------------------------------------------------------------------
// TranslatePanel — 工作台左栏：原文输入 + Agent 流式卡片网格 + 汇总条
//
// - 语言对显示（会话快照 source_lang→target_lang，默认 英文→中文五言）
// - source-input：字数 / 估算 token 实时显示；超 8k 红字警告且禁提交
// - translate-button：创建会话并触发 SSE 翻译；进行中禁用输入与按钮
// - 卡片网格：每 agent 一卡，错开入场；error 卡可单独重试
// - fanout_complete 后汇总条（成功 N / 失败 M），全部完成提示可进统筹
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react'
import { Button, Card, Spinner, Textarea, Toast } from '@/src/components/ui'
import { TID } from '@/src/lib/testids'
import { estimateTokens } from '@/src/lib/guards/tokens'
import { SOURCE_TOKEN_LIMIT } from '@/src/lib/constants'
import { AgentStreamCard } from './agent-stream-card'
import { useTranslation } from './use-translation'

export interface TranslatePanelProps {
  className?: string
  /** 全部卡片 complete 状态变化时上抛（驱动右栏统筹亮起） */
  onAllCompleteChange?: (allComplete: boolean) => void
}

const emptyBox =
  'rounded-sm border border-dashed border-line-2 bg-paper/60 px-4 py-6 text-center text-sm leading-6 text-ink-4'

export function TranslatePanel({ className = '', onAllCompleteChange }: TranslatePanelProps) {
  const {
    configStatus,
    phase,
    cards,
    langPair,
    globalError,
    retryingKey,
    busy,
    summary,
    allComplete,
    start,
    retry,
    dismissError,
  } = useTranslation()

  const [source, setSource] = useState('')

  // 全部完成 → 上抛右栏
  useEffect(() => {
    onAllCompleteChange?.(allComplete)
  }, [allComplete, onAllCompleteChange])

  const charCount = source.length
  const tokenCount = useMemo(() => estimateTokens(source), [source])
  const overLimit = tokenCount > SOURCE_TOKEN_LIMIT
  const empty = source.trim().length === 0
  const canSubmit = !busy && !empty && !overLimit && configStatus === 'ready'

  const handleTranslate = () => {
    if (!canSubmit) return
    void start(source)
  }

  // ── 配置检测中 ────────────────────────────────────────────────
  if (configStatus === 'loading') {
    return (
      <Card overline="Source" title="原文" className={className}>
        <div className="flex min-h-56 items-center justify-center text-ink-3">
          <Spinner size="lg" />
        </div>
      </Card>
    )
  }

  // ── 未配置端点 / Agent → 引导 CTA ─────────────────────────────
  if (configStatus === 'unconfigured') {
    return (
      <Card overline="Get Started" title="从一次配置开始" className={className}>
        <div className="flex min-h-56 flex-col items-center justify-center gap-3 text-center">
          <p className="max-w-md text-sm leading-6 text-ink-3">
            工作台需要至少一个可用端点与一名翻译 Agent，才能开始并行翻译与统筹。
          </p>
          <Button href="/config" className="mt-2">
            请先配置端点与翻译 Agent
          </Button>
        </div>
      </Card>
    )
  }

  // ── 翻译视图 ──────────────────────────────────────────────────
  return (
    <Card
      overline="Source"
      title="原文"
      className={className}
      actions={
        <span className="inline-flex items-center gap-1.5 rounded-xs border border-line-2 bg-paper px-2 py-1 text-[0.6875rem] font-medium leading-4 tracking-wide text-ink-2">
          {langPair.source}
          <span className="text-ink-4" aria-hidden>
            →
          </span>
          {langPair.target}
        </span>
      }
    >
      <Textarea
        testId={TID.translate.sourceInput}
        rows={9}
        value={source}
        onChange={(e) => setSource(e.target.value)}
        disabled={busy}
        placeholder="粘贴或输入待译原文……"
        aria-label="原文输入"
        aria-invalid={overLimit}
        className={overLimit ? 'border-cinnabar focus:border-cinnabar' : ''}
      />

      {/* 计数 + 主 CTA */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p
          className={[
            'text-xs leading-5 tabular-nums',
            overLimit ? 'font-medium text-cinnabar' : 'text-ink-4',
          ].join(' ')}
        >
          {charCount.toLocaleString('zh-CN')} 字 · 约 {tokenCount.toLocaleString('zh-CN')} tokens
          {overLimit && (
            <span role="alert">
              {' '}
              — 已超 {SOURCE_TOKEN_LIMIT.toLocaleString('zh-CN')} tokens 上限，请删减后再译
            </span>
          )}
        </p>
        <Button
          testId={TID.translate.translateButton}
          disabled={!canSubmit}
          onClick={handleTranslate}
        >
          {busy ? (
            <>
              <Spinner size="sm" /> 翻译中…
            </>
          ) : (
            '开始翻译'
          )}
        </Button>
      </div>

      {/* 汇总条：fanout_complete 后常驻；计数由卡片态派生，重试后自动修正 */}
      {summary && (
        <div
          role="status"
          className={[
            'mt-4 flex items-center justify-between gap-3 rounded-sm border px-3 py-2 text-sm leading-6',
            summary.failed > 0
              ? 'border-cinnabar/40 bg-cinnabar/5 text-ink'
              : 'border-pine/40 bg-pine/5 text-ink',
          ].join(' ')}
        >
          <span className="tabular-nums">
            <span className="font-medium text-pine">成功 {summary.succeeded}</span>
            <span className="mx-1.5 text-ink-4">/</span>
            <span className={summary.failed > 0 ? 'font-medium text-cinnabar' : 'text-ink-3'}>
              失败 {summary.failed}
            </span>
          </span>
          {allComplete ? (
            <span className="text-xs text-pine">全部完成，可进入统筹 →</span>
          ) : (
            summary.failed > 0 && <span className="text-xs text-ink-3">失败卡片可单独重试</span>
          )}
        </div>
      )}

      {/* 卡片网格 */}
      {cards.length > 0 ? (
        <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
          {cards.map((card, i) => (
            <AgentStreamCard
              key={card.agentKey}
              card={card}
              enterDelayMs={i * 70}
              retrying={retryingKey === card.agentKey}
              retryDisabled={busy}
              onRetry={retry}
            />
          ))}
        </div>
      ) : (
        <div className={`mt-4 ${emptyBox}`}>
          {phase === 'creating' ? '正在创建会话…' : '各翻译 Agent 的流式输出将在此并列显示'}
        </div>
      )}

      {/* 全局错误通知（会话创建失败 / 管道级错误） */}
      {globalError && (
        <div className="fixed bottom-5 right-5 z-50">
          <Toast tone="inverted" title="翻译出错" message={globalError} onClose={dismissError} />
        </div>
      )}
    </Card>
  )
}
