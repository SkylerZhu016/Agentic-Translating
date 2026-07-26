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
import { useSearchParams } from 'next/navigation'
import { Button, Card, Modal, Spinner, Textarea, Toast } from '@/src/components/ui'
import { TID } from '@/src/lib/testids'
import { estimateTokens } from '@/src/lib/guards/tokens'
import { AgentStreamCard } from './agent-stream-card'
import { useTranslation } from './use-translation'
import { useDirection } from '@/src/components/direction/DirectionProvider'
import { onSessionChanged } from '@/src/components/coordinator/session-bus'
import type {
  AgentDirectionVariant,
  ReviewMode,
  TranslationConstraints,
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

const DEFAULT_POETRY_CONSTRAINTS: TranslationConstraints = {
  poetryMode: 'auto',
  poetryTargetForm: 'preserve',
  chineseRhymeSystem: 'mandarin',
  englishRhymeMode: 'natural',
  rhymePositions: 'auto',
  firstLineRhyme: 'auto',
  rhymeChange: 'source',
  poetryPriority: 'balanced',
  rhymeEvidence: true,
}

function hasNonDefaultPoetryConstraints(
  constraints: TranslationConstraints | undefined,
): boolean {
  if (!constraints) return false
  const merged = {
    ...DEFAULT_POETRY_CONSTRAINTS,
    ...constraints,
  }
  return (
    Object.entries(DEFAULT_POETRY_CONSTRAINTS).some(
      ([key, value]) =>
        merged[key as keyof TranslationConstraints] !== value,
    ) ||
    Object.keys(constraints).some(
      (key) => !(key in DEFAULT_POETRY_CONSTRAINTS),
    )
  )
}

export function TranslatePanel({ className = '', onAllCompleteChange }: TranslatePanelProps) {
  const searchParams = useSearchParams()
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
    retryAll,
    dismissError,
  } = useTranslation(direction)
  const contextAnalysisCards = cards.filter(
    (card) => card.kind === 'context_analysis',
  )
  const poetryPlanCards = cards.filter(
    (card) => card.kind === 'poetry_plan',
  )
  const translationCards = cards.filter(
    (card) => card.kind === 'translation' || card.kind == null,
  )

  const [source, setSource] = useState('')
  const [taskBrief, setTaskBrief] = useState('')
  const [reviewMode, setReviewMode] = useState<ReviewMode>('main_editor')
  const [constraints, setConstraints] = useState<TranslationConstraints>(
    DEFAULT_POETRY_CONSTRAINTS,
  )
  const [allowedAgentVariantIds, setAllowedAgentVariantIds] = useState<string[]>([])
  const [catalog, setCatalog] = useState<AgentDirectionVariant[]>([])
  const [presets, setPresets] = useState<WorkflowPreset[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState('')
  const [selectedPresetRevisionId, setSelectedPresetRevisionId] = useState<string | null>(null)
  const [promptBundleRevisionId, setPromptBundleRevisionId] =
    useState<string | null>(null)
  const [promptBundles, setPromptBundles] = useState<Array<{
    id: string
    name: string
    isBuiltin: boolean
    currentRevision: { id: string }
  }>>([])
  const [draftLoaded, setDraftLoaded] = useState(false)
  const [restoredSession, setRestoredSession] = useState(false)
  const [recoverableDraft, setRecoverableDraft] =
    useState<WorkspaceDraft | null>(null)
  const [retryAllOpen, setRetryAllOpen] = useState(false)
  const [timelineOpen, setTimelineOpen] = useState(false)
  const routeSessionId = searchParams.get('session')
  const freshWorkspace = searchParams.get('fresh') === '1' && !routeSessionId

  useEffect(() => {
    if (!routeSessionId) return
    return onSessionChanged((detail) => {
      if (!detail.sessionId || detail.sessionId === routeSessionId) {
        void restoreSession(routeSessionId)
      }
    })
  }, [restoreSession, routeSessionId])

  useEffect(() => {
    let cancelled = false
    setDraftLoaded(false)
    const activeSessionId = routeSessionId
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
      fetch(`/api/prompt-bundles?direction=${direction}`).then((response) =>
        response.ok
          ? response.json() as Promise<Array<{
              id: string
              name: string
              isBuiltin: boolean
              currentRevision: { id: string }
            }>>
          : [],
      ),
    ]).then(([draftOrSession, catalogue, presetList, bundleList]) => {
      if (cancelled) return
      const variants = catalogue?.variants ?? []
      setCatalog(variants)
      setPresets(presetList)
      setPromptBundles(bundleList)
      const savedDraft =
        !activeSessionId && draftOrSession
          ? (draftOrSession as WorkspaceDraft)
          : null
      const hasSavedDraft = Boolean(
        savedDraft &&
          (
            savedDraft.sourceText.trim() ||
            savedDraft.taskBrief.trim() ||
            savedDraft.selectedPresetRevisionId ||
            hasNonDefaultPoetryConstraints(savedDraft.constraints)
          ),
      )
      setRecoverableDraft(
        freshWorkspace && hasSavedDraft ? savedDraft : null,
      )
      const visibleState =
        freshWorkspace && !activeSessionId ? null : draftOrSession
      setSource(visibleState?.sourceText ?? '')
      setTaskBrief(visibleState?.taskBrief ?? '')
      setReviewMode(visibleState?.reviewMode ?? 'main_editor')
      setConstraints({
        ...DEFAULT_POETRY_CONSTRAINTS,
        ...(visibleState?.constraints ?? {}),
      })
      setAllowedAgentVariantIds(
        visibleState &&
        'allowedAgentVariantIds' in visibleState &&
        (visibleState as WorkspaceDraft).allowedAgentVariantIds.length
          ? (visibleState as WorkspaceDraft).allowedAgentVariantIds
          : variants.map((variant) => variant.id),
      )
      setSelectedPresetRevisionId(
        visibleState && 'selectedPresetRevisionId' in visibleState
          ? (visibleState as WorkspaceDraft).selectedPresetRevisionId
          : null,
      )
      setPromptBundleRevisionId(
        visibleState && 'promptBundleRevisionId' in visibleState
          ? (visibleState as WorkspaceDraft).promptBundleRevisionId ?? null
          : null,
      )
      setSelectedPresetId('')
      const draftRevisionId =
        visibleState && 'selectedPresetRevisionId' in visibleState
          ? (visibleState as WorkspaceDraft).selectedPresetRevisionId
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
  }, [direction, freshWorkspace, restoreSession, routeSessionId])

  const removeFreshMarker = useCallback(() => {
    const url = new URL(window.location.href)
    url.searchParams.delete('fresh')
    window.history.replaceState(null, '', url)
  }, [])

  const restoreSavedDraft = useCallback(() => {
    if (!recoverableDraft) return
    setSource(recoverableDraft.sourceText)
    setTaskBrief(recoverableDraft.taskBrief)
    setReviewMode(recoverableDraft.reviewMode)
    setConstraints({
      ...DEFAULT_POETRY_CONSTRAINTS,
      ...(recoverableDraft.constraints ?? {}),
    })
    setAllowedAgentVariantIds(recoverableDraft.allowedAgentVariantIds)
    setSelectedPresetRevisionId(recoverableDraft.selectedPresetRevisionId)
    setPromptBundleRevisionId(
      recoverableDraft.promptBundleRevisionId ?? null,
    )
    setRecoverableDraft(null)
    removeFreshMarker()
  }, [recoverableDraft, removeFreshMarker])

  const flushDraft = useCallback(async () => {
    if (!draftLoaded || busy || restoredSession) return
    await fetch(`/api/workspace-drafts/${direction}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceText: source,
        taskBrief,
        selectedPresetRevisionId,
        promptBundleRevisionId,
        allowedAgentVariantIds,
        reviewMode,
        constraints,
      }),
    })
  }, [
    allowedAgentVariantIds,
    busy,
    direction,
    draftLoaded,
    promptBundleRevisionId,
    reviewMode,
    constraints,
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
          promptBundleRevisionId != null ||
          reviewMode !== 'main_editor' ||
          JSON.stringify(constraints) !==
            JSON.stringify(DEFAULT_POETRY_CONSTRAINTS) ||
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
    promptBundleRevisionId,
    restoredSession,
    reviewMode,
    constraints,
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
    allowedAgentVariantIds.filter(
      (id) =>
        catalog.find((variant) => variant.id === id)?.archetypeId !==
        'cultural-context',
    ).length >= 2 &&
    configStatus === 'ready'

  const handleTranslate = () => {
    if (!canSubmit) return
    void start({
      sourceText: source,
      direction,
      taskBrief,
      reviewMode,
      constraints,
      allowedAgentVariantIds: Array.from(new Set([
        ...allowedAgentVariantIds,
        ...catalog
          .filter((variant) => variant.archetypeId === 'cultural-context')
          .map((variant) => variant.id),
      ])),
      presetRevisionId: selectedPresetRevisionId,
      promptBundleRevisionId,
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
    setConstraints({
      ...DEFAULT_POETRY_CONSTRAINTS,
      ...(revision.contract.constraints ?? {}),
    })
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
      {recoverableDraft && (
        <div className="mb-3 rounded-sm border border-line-2 bg-paper px-3 py-2.5 text-sm text-ink-2">
          <p className="font-medium text-ink">该方向有一份上次未提交的草稿</p>
          <p className="mt-1 text-xs text-ink-3">
            更新时间：{new Date(recoverableDraft.updatedAt).toLocaleString('zh-CN')}
          </p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="outline" onClick={restoreSavedDraft}>
              恢复上次草稿
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setRecoverableDraft(null)
                removeFreshMarker()
              }}
            >
              忽略
            </Button>
          </div>
        </div>
      )}
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
          <label className="block text-xs font-medium text-ink-3">
            提示词包
            <select
              value={promptBundleRevisionId ?? ''}
              disabled={busy || restoredSession}
              onChange={(event) =>
                setPromptBundleRevisionId(event.target.value || null)
              }
              className="mt-1 block w-full rounded-sm border border-line-2 bg-paper-raise px-2 py-2 text-sm text-ink"
            >
              {promptBundles.map((bundle) => (
                <option
                  key={bundle.id}
                  value={bundle.isBuiltin ? '' : bundle.currentRevision.id}
                >
                  {bundle.name}
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
          <details className="rounded-sm border border-line bg-paper/70">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-ink-2">
              诗歌形式与押韵
            </summary>
            <div className="space-y-3 border-t border-line px-3 py-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="text-xs font-medium text-ink-3">
                  诗歌专项
                  <select
                    value={constraints.poetryMode ?? 'auto'}
                    disabled={busy || restoredSession}
                    onChange={(event) =>
                      setConstraints((current) => ({
                        ...current,
                        poetryMode: event.target
                          .value as TranslationConstraints['poetryMode'],
                      }))
                    }
                    className="mt-1 block w-full rounded-sm border border-line-2 bg-paper-raise px-2 py-1.5 text-sm text-ink"
                  >
                    <option value="auto">自动识别</option>
                    <option value="on">强制启用</option>
                    <option value="off">关闭</option>
                  </select>
                </label>
                <label className="text-xs font-medium text-ink-3">
                  目标诗体
                  <select
                    value={constraints.poetryTargetForm ?? 'preserve'}
                    disabled={
                      busy ||
                      restoredSession ||
                      constraints.poetryMode === 'off'
                    }
                    onChange={(event) =>
                      setConstraints((current) => ({
                        ...current,
                        poetryTargetForm: event.target
                          .value as TranslationConstraints['poetryTargetForm'],
                      }))
                    }
                    className="mt-1 block w-full rounded-sm border border-line-2 bg-paper-raise px-2 py-1.5 text-sm text-ink"
                  >
                    <option value="preserve">尽量保留原体</option>
                    <option value="free_verse">自由诗</option>
                    <option value="classical">古体诗</option>
                    <option value="regulated">近体诗</option>
                    <option value="custom">自定义</option>
                  </select>
                </label>
                {direction === 'en_to_zh' ? (
                  <label className="text-xs font-medium text-ink-3">
                    中文韵部规则
                    <select
                      value={constraints.chineseRhymeSystem ?? 'mandarin'}
                      disabled={
                        busy ||
                        restoredSession ||
                        constraints.poetryMode === 'off'
                      }
                      onChange={(event) =>
                        setConstraints((current) => ({
                          ...current,
                          chineseRhymeSystem: event.target
                            .value as TranslationConstraints['chineseRhymeSystem'],
                        }))
                      }
                      className="mt-1 block w-full rounded-sm border border-line-2 bg-paper-raise px-2 py-1.5 text-sm text-ink"
                    >
                      <option value="mandarin">普通话〔默认〕</option>
                      <option value="pingshui">平水韵</option>
                      <option value="dual">双重校验</option>
                    </select>
                  </label>
                ) : (
                  <label className="text-xs font-medium text-ink-3">
                    英文押韵强度
                    <select
                      value={constraints.englishRhymeMode ?? 'natural'}
                      disabled={
                        busy ||
                        restoredSession ||
                        constraints.poetryMode === 'off'
                      }
                      onChange={(event) =>
                        setConstraints((current) => ({
                          ...current,
                          englishRhymeMode: event.target
                            .value as TranslationConstraints['englishRhymeMode'],
                        }))
                      }
                      className="mt-1 block w-full rounded-sm border border-line-2 bg-paper-raise px-2 py-1.5 text-sm text-ink"
                    >
                      <option value="natural">自然优先〔默认〕</option>
                      <option value="near">允许近似韵</option>
                      <option value="exact">严格同韵</option>
                      <option value="none">不要求押韵</option>
                    </select>
                  </label>
                )}
                <label className="text-xs font-medium text-ink-3">
                  韵位
                  <select
                    value={constraints.rhymePositions ?? 'auto'}
                    disabled={
                      busy ||
                      restoredSession ||
                      constraints.poetryMode === 'off'
                    }
                    onChange={(event) =>
                      setConstraints((current) => ({
                        ...current,
                        rhymePositions: event.target
                          .value as TranslationConstraints['rhymePositions'],
                      }))
                    }
                    className="mt-1 block w-full rounded-sm border border-line-2 bg-paper-raise px-2 py-1.5 text-sm text-ink"
                  >
                    <option value="auto">自动规划</option>
                    <option value="even_lines">偶数句</option>
                    <option value="all_lines">句句押韵</option>
                    <option value="custom">按下方韵式</option>
                  </select>
                </label>
                <label className="text-xs font-medium text-ink-3">
                  首句入韵
                  <select
                    value={constraints.firstLineRhyme ?? 'auto'}
                    disabled={
                      busy ||
                      restoredSession ||
                      constraints.poetryMode === 'off'
                    }
                    onChange={(event) =>
                      setConstraints((current) => ({
                        ...current,
                        firstLineRhyme: event.target
                          .value as TranslationConstraints['firstLineRhyme'],
                      }))
                    }
                    className="mt-1 block w-full rounded-sm border border-line-2 bg-paper-raise px-2 py-1.5 text-sm text-ink"
                  >
                    <option value="auto">自动</option>
                    <option value="yes">是</option>
                    <option value="no">否</option>
                  </select>
                </label>
                <label className="text-xs font-medium text-ink-3">
                  换韵
                  <select
                    value={constraints.rhymeChange ?? 'source'}
                    disabled={
                      busy ||
                      restoredSession ||
                      constraints.poetryMode === 'off'
                    }
                    onChange={(event) =>
                      setConstraints((current) => ({
                        ...current,
                        rhymeChange: event.target
                          .value as TranslationConstraints['rhymeChange'],
                      }))
                    }
                    className="mt-1 block w-full rounded-sm border border-line-2 bg-paper-raise px-2 py-1.5 text-sm text-ink"
                  >
                    <option value="source">跟随原文</option>
                    <option value="single">一韵到底</option>
                    <option value="by_stanza">逐节转韵</option>
                    <option value="custom">自定义</option>
                  </select>
                </label>
                <label className="text-xs font-medium text-ink-3">
                  形式与语义
                  <select
                    value={constraints.poetryPriority ?? 'balanced'}
                    disabled={
                      busy ||
                      restoredSession ||
                      constraints.poetryMode === 'off'
                    }
                    onChange={(event) =>
                      setConstraints((current) => ({
                        ...current,
                        poetryPriority: event.target
                          .value as TranslationConstraints['poetryPriority'],
                      }))
                    }
                    className="mt-1 block w-full rounded-sm border border-line-2 bg-paper-raise px-2 py-1.5 text-sm text-ink"
                  >
                    <option value="balanced">平衡〔默认〕</option>
                    <option value="meaning">语义优先</option>
                    <option value="form">形式优先</option>
                  </select>
                </label>
              </div>
              <label className="block text-xs font-medium text-ink-3">
                自定义韵式
                <input
                  value={constraints.rhymeScheme ?? ''}
                  disabled={
                    busy ||
                    restoredSession ||
                    constraints.poetryMode === 'off'
                  }
                  onChange={(event) =>
                    setConstraints((current) => ({
                      ...current,
                      rhymeScheme: event.target.value,
                    }))
                  }
                  placeholder="例如 AAxAxAxA、ABAB 或逐节说明"
                  className="mt-1 block w-full rounded-sm border border-line-2 bg-paper-raise px-2 py-1.5 text-sm text-ink"
                />
              </label>
              <p className="text-xs leading-5 text-ink-4">
                仅处理诗歌文本的诗行、韵位与节奏；暂不处理歌词的旋律适配、可唱性或音符级音节对齐。
              </p>
            </div>
          </details>
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
                    disabled={
                      busy ||
                      restoredSession ||
                      variant.archetypeId === 'cultural-context'
                    }
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
                    {variant.archetypeId === 'cultural-context' && (
                      <span className="mb-0.5 block text-[0.6875rem] text-pine">
                        固定前置 · 双模型并行
                      </span>
                    )}
                    <span className="line-clamp-2 text-ink-3">
                      {variant.catalogDescription}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {allowedAgentVariantIds.filter(
              (id) =>
                catalog.find((variant) => variant.id === id)?.archetypeId !==
                'cultural-context',
            ).length < 2 && (
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

      {translationCards.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-y border-line py-2">
          <p className="text-xs font-medium text-ink-2">
            候选译文 · 成功 {translationCards.filter((card) => card.status === 'complete').length}
            {' · '}失败 {translationCards.filter((card) => card.status === 'error').length}
          </p>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setTimelineOpen(true)}
            >
              查看调用时间线
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={
                busy || !translationCards.some((card) => card.status === 'error')
              }
              onClick={() => setRetryAllOpen(true)}
            >
              重试全部失败项
            </Button>
          </div>
        </div>
      )}

      {contextAnalysisCards.length > 0 && (
        <section className="mt-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-ink-2">
              前置意象分析 · {contextAnalysisCards.length} 个独立模型
            </p>
            <span className="text-xs text-ink-4">完整分析将传给后续 Agent</span>
          </div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {contextAnalysisCards.map((card, index) => (
              <AgentStreamCard
                key={card.chainId ?? card.agentKey}
                card={card}
                enterDelayMs={index * 70}
                retrying={retryingKey === card.agentKey}
                retryDisabled={busy}
                onRetry={retry}
              />
            ))}
          </div>
        </section>
      )}

      {poetryPlanCards.length > 0 && (
        <section className="mt-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-ink-2">
              诗体与韵律专项规划
            </p>
            <span className="text-xs text-ink-4">
              仅在诗歌任务中启用，不包含歌词旋律适配
            </span>
          </div>
          <div className="grid grid-cols-1 gap-4">
            {poetryPlanCards.map((card) => (
              <AgentStreamCard
                key={card.chainId ?? card.agentKey}
                card={card}
                onRetry={retry}
                retrying={retryingKey === card.agentKey}
                retryDisabled={busy && retryingKey !== card.agentKey}
              />
            ))}
          </div>
        </section>
      )}

      {/* 候选译文卡片网格 */}
      {translationCards.length > 0 ? (
        <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
          {translationCards.map((card, i) => (
            <AgentStreamCard
              key={card.chainId ?? card.agentKey}
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
      <Modal
        open={retryAllOpen}
        onClose={() => setRetryAllOpen(false)}
        title="重试全部失败项"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setRetryAllOpen(false)}>
              取消
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setRetryAllOpen(false)
                void retryAll('frozen')
              }}
            >
              按会话冻结配置重试
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                setRetryAllOpen(false)
                void retryAll('current')
              }}
            >
              使用当前配置重试
            </Button>
          </>
        }
      >
        <p className="text-sm leading-6 text-ink-2">
          将重试 {cards.filter((card) => card.status === 'error').length} 个失败 Agent。
          使用当前配置时，会采用当前端点、模型、Agent 和提示词版本。
        </p>
      </Modal>
      <Modal
        open={timelineOpen}
        onClose={() => setTimelineOpen(false)}
        title="Agent 调用时间线"
        footer={
          <Button size="sm" onClick={() => setTimelineOpen(false)}>
            关闭
          </Button>
        }
      >
        <ol className="space-y-2 text-sm leading-6 text-ink-2">
          {cards.map((card) => (
            <li key={card.chainId ?? card.agentKey}>
              <span className="font-medium text-ink">{card.name}</span>
              {' · '}{card.model}{' · '}{card.status}
              {(card.attempts?.length ?? 0) > 1
                ? ` · ${card.attempts!.length} 次尝试`
                : ''}
            </li>
          ))}
        </ol>
      </Modal>
    </Card>
  )
}
