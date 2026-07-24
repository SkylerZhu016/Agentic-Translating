'use client'

// ---------------------------------------------------------------------------
// TranslatePanel — 工作台左栏：原文输入 + Agent 流式卡片网格 + 汇总条
//
// - 语言对显示（会话快照 source_lang→target_lang，默认 英文→中文）
// - source-input：字数 / 估算 token 实时显示；超 8k 红字警告且禁提交
// - translate-button：创建会话并触发 SSE 翻译；进行中禁用输入与按钮
// - 卡片网格：每 agent 一卡，错开入场；error 卡可单独重试
// - fanout_complete 后汇总条（成功 N / 失败 M），全部完成提示可进统筹
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Card, Spinner, Textarea, Toast } from '@/src/components/ui'
import { TID } from '@/src/lib/testids'
import { estimateTokens } from '@/src/lib/guards/tokens'
import { AgentStreamCard } from './agent-stream-card'
import { useTranslation } from './use-translation'
import { useDirection } from '@/src/components/direction/DirectionProvider'
import type {
  AgentDirectionVariant,
  ReviewMode,
  WorkspaceDraft,
  WorkflowPreset,
  WorkflowPresetRevision,
} from '@/src/lib/contracts/vnext'

export interface TranslatePanelProps {
  className?: string
  /** 全部卡片 complete 状态变化时上抛（驱动右栏统筹亮起） */
  onAllCompleteChange?: (allComplete: boolean) => void
}

const emptyBox =
  'rounded-sm border border-dashed border-line-2 bg-paper/60 px-4 py-6 text-center text-sm leading-6 text-ink-4'

export function TranslatePanel({ className = '', onAllCompleteChange }: TranslatePanelProps) {
  const { direction, registerDraftController } = useDirection()
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
    restoreSession,
    retry,
    dismissError,
  } = useTranslation(direction)

  const [source, setSource] = useState('')
  const [taskBrief, setTaskBrief] = useState('')
  const [reviewMode, setReviewMode] = useState<ReviewMode>('main_editor')
  const [allowedAgentVariantIds, setAllowedAgentVariantIds] = useState<string[]>([])
  const [catalog, setCatalog] = useState<AgentDirectionVariant[]>([])
  const [presets, setPresets] = useState<WorkflowPreset[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState('')
  const [selectedPresetRevisionId, setSelectedPresetRevisionId] = useState<string | null>(null)
  const [draftLoaded, setDraftLoaded] = useState(false)
  const [restoredSession, setRestoredSession] = useState(false)

  useEffect(() => {
    let cancelled = false
    setDraftLoaded(false)
    const activeSessionId = new URLSearchParams(window.location.search).get('session')
    void Promise.all([
      activeSessionId
        ? restoreSession(activeSessionId)
        : fetch(`/api/workspace-drafts/${direction}`).then((response) =>
            response.ok
              ? response.json() as Promise<WorkspaceDraft | null>
              : null,
          ),
      fetch(`/api/agent-catalog?direction=${direction}`).then((response) =>
        response.ok
          ? response.json() as Promise<{ variants: AgentDirectionVariant[] }>
          : { variants: [] },
      ),
      fetch(`/api/workflow-presets?direction=${direction}`).then((response) =>
        response.ok ? response.json() as Promise<WorkflowPreset[]> : [],
      ),
    ]).then(([draftOrSession, catalogue, presetList]) => {
      if (cancelled) return
      const variants = catalogue?.variants ?? []
      setCatalog(variants)
      setPresets(presetList)
      setSource(draftOrSession?.sourceText ?? '')
      setTaskBrief(draftOrSession?.taskBrief ?? '')
      setReviewMode(draftOrSession?.reviewMode ?? 'main_editor')
      setAllowedAgentVariantIds(
        'allowedAgentVariantIds' in (draftOrSession ?? {}) &&
        (draftOrSession as WorkspaceDraft).allowedAgentVariantIds.length
          ? (draftOrSession as WorkspaceDraft).allowedAgentVariantIds
          : variants.map((variant) => variant.id),
      )
      setSelectedPresetRevisionId(
        'selectedPresetRevisionId' in (draftOrSession ?? {})
          ? (draftOrSession as WorkspaceDraft).selectedPresetRevisionId
          : null,
      )
      setSelectedPresetId('')
      const draftRevisionId =
        'selectedPresetRevisionId' in (draftOrSession ?? {})
          ? (draftOrSession as WorkspaceDraft).selectedPresetRevisionId
          : null
      if (draftRevisionId) {
        void Promise.all(
          presetList.map(async (preset) => {
            const response = await fetch(
              `/api/workflow-presets/${encodeURIComponent(preset.id)}`,
            )
            if (!response.ok) return null
            const detail = await response.json() as {
              revisions: WorkflowPresetRevision[]
            }
            return detail.revisions.some(
              (revision) => revision.id === draftRevisionId,
            )
              ? preset.id
              : null
          }),
        ).then((matches) => {
          if (!cancelled) {
            setSelectedPresetId(matches.find(Boolean) ?? '')
          }
        })
      }
      setRestoredSession(Boolean(activeSessionId))
      setDraftLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [direction, restoreSession])

  const flushDraft = useCallback(async () => {
    if (!draftLoaded || busy || restoredSession) return
    await fetch(`/api/workspace-drafts/${direction}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceText: source,
        taskBrief,
        selectedPresetRevisionId,
        allowedAgentVariantIds,
        reviewMode,
      }),
    })
  }, [
    allowedAgentVariantIds,
    busy,
    direction,
    draftLoaded,
    reviewMode,
    restoredSession,
    selectedPresetRevisionId,
    source,
    taskBrief,
  ])

  useEffect(() => {
    registerDraftController({
      dirty:
        !restoredSession &&
        (
          source.trim().length > 0 ||
          taskBrief.trim().length > 0 ||
          selectedPresetRevisionId != null ||
          reviewMode !== 'main_editor' ||
          allowedAgentVariantIds.length !== catalog.length ||
          allowedAgentVariantIds.some(
            (id) => !catalog.some((variant) => variant.id === id),
          )
        ),
      flush: flushDraft,
    })
    return () => registerDraftController(null)
  }, [
    allowedAgentVariantIds,
    catalog,
    flushDraft,
    registerDraftController,
    restoredSession,
    reviewMode,
    selectedPresetRevisionId,
    source,
    taskBrief,
  ])

  useEffect(() => {
    if (!draftLoaded || busy || restoredSession) return
    const timer = window.setTimeout(() => void flushDraft(), 500)
    return () => window.clearTimeout(timer)
  }, [
    allowedAgentVariantIds,
    busy,
    draftLoaded,
    flushDraft,
    reviewMode,
    restoredSession,
    source,
    taskBrief,
  ])

  // 全部完成 → 上抛右栏
  useEffect(() => {
    onAllCompleteChange?.(allComplete)
  }, [allComplete, onAllCompleteChange])

  const charCount = source.length
  const tokenCount = useMemo(() => estimateTokens(source), [source])
  const empty = source.trim().length === 0
  const canSubmit =
    !busy &&
    !restoredSession &&
    !empty &&
    allowedAgentVariantIds.length >= 2 &&
    configStatus === 'ready'

  const handleTranslate = () => {
    if (!canSubmit) return
    void start({
      sourceText: source,
      direction,
      taskBrief,
      reviewMode,
      allowedAgentVariantIds,
      presetRevisionId: selectedPresetRevisionId,
    })
  }

  const loadPreset = async (presetId: string) => {
    setSelectedPresetId(presetId)
    if (!presetId) {
      setSelectedPresetRevisionId(null)
      return
    }
    const response = await fetch(
      `/api/workflow-presets/${encodeURIComponent(presetId)}`,
    )
    if (!response.ok) return
    const payload = await response.json() as {
      preset: WorkflowPreset
      revisions: WorkflowPresetRevision[]
    }
    const revision = payload.revisions.find(
      (item) => item.revisionNo === payload.preset.currentRevisionNo,
    )
    if (!revision) return
    setSelectedPresetRevisionId(revision.id)
    setTaskBrief(revision.contract.taskBriefTemplate)
    setAllowedAgentVariantIds(revision.contract.agentVariantIds)
    setReviewMode(revision.contract.reviewMode)
  }

  // ── 配置检测中 ────────────────────────────────────────────────
  if (configStatus === 'loading' || !draftLoaded) {
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
        disabled={busy || restoredSession}
        placeholder="粘贴或输入待译原文……"
        aria-label="原文输入"
      />

      <details className="mt-3 rounded-sm border border-line bg-paper/55">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-ink-2">
          翻译要求与 Agent 范围
        </summary>
        <div className="space-y-4 border-t border-line px-3 py-3">
          <label className="block text-xs font-medium text-ink-3">
            当前预设
            <select
              value={selectedPresetId}
              disabled={busy || restoredSession}
              onChange={(event) => void loadPreset(event.target.value)}
              className="mt-1 block w-full rounded-sm border border-line-2 bg-paper-raise px-2 py-2 text-sm text-ink"
            >
              <option value="">不使用预设（动态编队）</option>
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name} · revision {preset.currentRevisionNo}
                </option>
              ))}
            </select>
          </label>
          <Textarea
            rows={4}
            value={taskBrief}
            onChange={(event) => setTaskBrief(event.target.value)}
            disabled={busy || restoredSession}
            aria-label="翻译任务要求"
            placeholder="说明翻译目标、文体、术语、结构及其他要求。内容将原样传给 Agent。"
          />
          <div>
            <p className="mb-2 text-xs font-medium text-ink-3">允许主 Agent 调用</p>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {catalog.map((variant) => (
                <label
                  key={variant.id}
                  className="flex items-start gap-2 rounded-xs border border-line px-2 py-1.5 text-xs text-ink-2"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-ink"
                    checked={allowedAgentVariantIds.includes(variant.id)}
                    disabled={busy || restoredSession}
                    onChange={(event) =>
                      setAllowedAgentVariantIds((current) =>
                        event.target.checked
                          ? [...current, variant.id]
                          : current.filter((id) => id !== variant.id),
                      )
                    }
                  />
                  <span>
                    <span className="block font-medium text-ink">{variant.catalogName}</span>
                    <span className="line-clamp-2 text-ink-3">
                      {variant.catalogDescription}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {allowedAgentVariantIds.length < 2 && (
              <p className="mt-2 text-xs text-cinnabar">至少选择两个不同角色。</p>
            )}
          </div>
          <label className="flex items-center justify-between gap-3 text-sm text-ink-2">
            审议方式
            <select
              value={reviewMode}
              disabled={busy || restoredSession}
              onChange={(event) => setReviewMode(event.target.value as ReviewMode)}
              className="rounded-sm border border-line-2 bg-paper-raise px-2 py-1.5 text-sm text-ink"
            >
              <option value="main_editor">主 Agent 证据化成稿</option>
              <option value="four_stage">经典四阶段</option>
            </select>
          </label>
        </div>
      </details>

      {/* 计数 + 主 CTA */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p
          className={[
            'text-xs leading-5 tabular-nums',
            'text-ink-4',
          ].join(' ')}
        >
          {charCount.toLocaleString('zh-CN')} 字 · 约 {tokenCount.toLocaleString('zh-CN')} tokens
          {' '}· 仅估算；配置上下文上限后会在调用前校验
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
