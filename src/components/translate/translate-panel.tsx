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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Button, Card, Modal, Spinner, Textarea, Toast } from '@/src/components/ui'
import { TID } from '@/src/lib/testids'
import { estimateTokens } from '@/src/lib/guards/tokens'
import { AgentStreamCard } from './agent-stream-card'
import {
  useTranslation,
  type RestoredTranslationState,
} from './use-translation'
import { useDirection } from '@/src/components/direction/DirectionProvider'
import { onSessionChanged } from '@/src/components/coordinator/session-bus'
import type {
  AgentDirectionVariant,
  MainEditorRunMode,
  ReviewMode,
  TranslationConstraints,
  WorkspaceDraft,
  WorkflowPreset,
  WorkflowPresetRevision,
} from '@/src/lib/contracts/vnext'
import type {
  ProjectSnapshot,
  TranslationProject,
} from '@/src/lib/contracts/projects'
import { useI18n } from '@/src/i18n/LocaleProvider'
import {
  DEFAULT_POETRY_CONSTRAINTS,
  hasMeaningfulDraft,
} from './workspace-draft-state'

export interface TranslatePanelProps {
  className?: string
  /** 全部卡片 complete 状态变化时上抛（驱动右栏统筹亮起） */
  onAllCompleteChange?: (allComplete: boolean) => void
}

const emptyBox =
  'rounded-sm border border-dashed border-line-2 bg-paper/60 px-4 py-6 text-center text-sm leading-6 text-ink-4'

interface ProjectSelectionSummary {
  name: string
  snapshotRevisionNo: number | null
  approvedResourceCount: number
  tokenEstimate: number
  frozen: boolean
}

async function findPresetIdForRevision(
  presetList: WorkflowPreset[],
  revisionId: string | null,
): Promise<string> {
  if (!revisionId) return ''
  const outcomes = await Promise.allSettled(
    presetList.map(async (preset) => {
      const response = await fetch(
        `/api/workflow-presets/${encodeURIComponent(preset.id)}`,
      )
      if (!response.ok) {
        throw new Error(`workspace_preset_lookup_failed:${response.status}`)
      }
      const detail = await response.json() as {
        revisions: WorkflowPresetRevision[]
      }
      return detail.revisions.some((revision) => revision.id === revisionId)
        ? preset.id
        : null
    }),
  )
  const match = outcomes.find(
    (outcome): outcome is PromiseFulfilledResult<string> =>
      outcome.status === 'fulfilled' && outcome.value != null,
  )
  if (match) return match.value
  const failure = outcomes.find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
  )
  if (failure) throw failure.reason
  throw new Error('workspace_preset_revision_unresolved')
}

export function TranslatePanel({ className = '', onAllCompleteChange }: TranslatePanelProps) {
  const { t, formatDate, formatNumber } = useI18n()
  const searchParams = useSearchParams()
  const { direction, registerDraftController } = useDirection()
  const {
    configStatus,
    phase,
    sessionId,
    cards,
    langPair,
    globalError,
    retryingKey,
    preflight,
    preflightErrorCode,
    preflightActions,
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
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [projects, setProjects] = useState<TranslationProject[]>([])
  const [selectedProjectSummary, setSelectedProjectSummary] =
    useState<ProjectSelectionSummary | null>(null)
  const [projectSummaryLoading, setProjectSummaryLoading] = useState(false)
  const [projectSummaryError, setProjectSummaryError] = useState<string | null>(null)
  const [restoredProjectState, setRestoredProjectState] =
    useState<RestoredTranslationState | null>(null)
  const [reviewMode, setReviewMode] = useState<ReviewMode>('main_editor')
  const [mainEditorRunMode, setMainEditorRunMode] =
    useState<MainEditorRunMode>('fixed_pipeline')
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
  const [draftLoadError, setDraftLoadError] = useState<string | null>(null)
  const [draftLoadRevision, setDraftLoadRevision] = useState(0)
  const [draftSaveError, setDraftSaveError] = useState<string | null>(null)
  const [presetLookupError, setPresetLookupError] = useState<string | null>(null)
  const [presetSelectionBusy, setPresetSelectionBusy] = useState(false)
  const [draftResolutionBusy, setDraftResolutionBusy] = useState(false)
  const [submitPreparing, setSubmitPreparing] = useState(false)
  const [retryAllOpen, setRetryAllOpen] = useState(false)
  const [timelineOpen, setTimelineOpen] = useState(false)
  const pendingDraftSavesRef = useRef<Set<Promise<void>>>(new Set())
  const draftSaveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const draftSaveTimerRef = useRef<number | null>(null)
  const submitPreparingRef = useRef(false)
  const draftResolutionBusyRef = useRef(false)
  const presetSelectionBusyRef = useRef(false)
  const presetLookupErrorRef = useRef<string | null>(null)
  const presetLookupTokenRef = useRef(0)
  const directionRef = useRef(direction)
  const recoverableDraftRef = useRef<WorkspaceDraft | null>(null)
  directionRef.current = direction
  recoverableDraftRef.current = recoverableDraft
  const updatePresetLookupError = useCallback((error: string | null) => {
    presetLookupErrorRef.current = error
    setPresetLookupError(error)
  }, [])
  const routeSessionId = searchParams.get('session')
  const freshWorkspace = searchParams.get('fresh') === '1' && !routeSessionId
  const draftInteractionLocked =
    busy || restoredSession || submitPreparing || draftResolutionBusy

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
    const presetLookupToken = ++presetLookupTokenRef.current
    setDraftLoaded(false)
    setDraftLoadError(null)
    updatePresetLookupError(null)
    presetSelectionBusyRef.current = false
    setPresetSelectionBusy(false)
    setRecoverableDraft(null)
    const activeSessionId = routeSessionId
    void Promise.all([
      activeSessionId
        ? restoreSession(activeSessionId)
        : fetch(`/api/workspace-drafts/${direction}`).then((response) => {
            if (!response.ok) {
              throw new Error(`workspace_draft_load_failed:${response.status}`)
            }
            return response.json() as Promise<WorkspaceDraft | null>
          }),
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
      fetch(`/api/projects?status=active&direction=${direction}`).then(
        (response) =>
          response.ok
            ? response.json() as Promise<{ projects: TranslationProject[] }>
            : { projects: [] },
      ),
    ]).then(([
      draftOrSession,
      catalogue,
      presetList,
      bundleList,
      projectList,
    ]) => {
      if (cancelled) return
      const variants = catalogue?.variants ?? []
      setCatalog(variants)
      setPresets(presetList)
      setPromptBundles(bundleList)
      setProjects(projectList.projects)
      const restoredState = activeSessionId
        ? (draftOrSession as RestoredTranslationState | null)
        : null
      const savedDraft =
        !activeSessionId && draftOrSession
          ? (draftOrSession as WorkspaceDraft)
          : null
      const hasSavedDraft = hasMeaningfulDraft(savedDraft, variants)
      setRecoverableDraft(
        freshWorkspace && hasSavedDraft ? savedDraft : null,
      )
      const visibleState =
        freshWorkspace && !activeSessionId
          ? null
          : (draftOrSession as
              | WorkspaceDraft
              | RestoredTranslationState
              | null)
      setSource(visibleState?.sourceText ?? '')
      setTaskBrief(visibleState?.taskBrief ?? '')
      setSelectedProjectId(visibleState?.selectedProjectId ?? null)
      setRestoredProjectState(restoredState)
      setReviewMode(visibleState?.reviewMode ?? 'main_editor')
      setMainEditorRunMode(
        visibleState?.mainEditorRunMode ?? 'fixed_pipeline',
      )
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
        void findPresetIdForRevision(presetList, draftRevisionId)
          .then((presetId) => {
            if (
              !cancelled &&
              presetLookupToken === presetLookupTokenRef.current
            ) {
              setSelectedPresetId(presetId)
              updatePresetLookupError(null)
            }
          })
          .catch((error: unknown) => {
            if (
              !cancelled &&
              presetLookupToken === presetLookupTokenRef.current
            ) {
              updatePresetLookupError(
                error instanceof Error
                  ? error.message
                  : 'workspace_preset_lookup_failed',
              )
            }
          })
      }
      setRestoredSession(Boolean(activeSessionId))
      setDraftLoadError(null)
      setDraftLoaded(true)
    }).catch((error: unknown) => {
      if (cancelled) return
      setDraftLoadError(
        error instanceof Error ? error.message : 'workspace_draft_load_failed',
      )
      setDraftLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [
    direction,
    draftLoadRevision,
    freshWorkspace,
    restoreSession,
    routeSessionId,
    updatePresetLookupError,
  ])

  useEffect(() => {
    if (sessionId) setRestoredSession(true)
  }, [sessionId])

  useEffect(() => {
    if (!selectedProjectId) {
      setSelectedProjectSummary(null)
      setProjectSummaryLoading(false)
      setProjectSummaryError(null)
      return
    }

    let cancelled = false
    const frozenState =
      restoredProjectState?.selectedProjectId === selectedProjectId
        ? restoredProjectState
        : null
    setProjectSummaryLoading(true)
    setProjectSummaryError(null)
    void Promise.all([
      fetch(`/api/projects/${encodeURIComponent(selectedProjectId)}`).then(
        async (response) => {
          if (!response.ok) throw new Error(t('translate.project.detailError'))
          return response.json() as Promise<{
            project: TranslationProject
            resourceCount: number
            tokenEstimate: number
          }>
        },
      ),
      fetch(
        `/api/projects/${encodeURIComponent(selectedProjectId)}/snapshots`,
      ).then(async (response) => {
        if (!response.ok) throw new Error(t('translate.project.snapshotError'))
        return response.json() as Promise<{ snapshots: ProjectSnapshot[] }>
      }),
    ])
      .then(([detail, snapshotPayload]) => {
        if (cancelled) return
        const snapshotId =
          frozenState?.projectSnapshotId ?? detail.project.currentSnapshotId
        const snapshot = snapshotPayload.snapshots.find(
          (item) => item.id === snapshotId,
        )
        setSelectedProjectSummary({
          name: detail.project.name,
          snapshotRevisionNo:
            snapshot?.revisionNo ?? detail.project.currentSnapshotRevisionNo,
          approvedResourceCount:
            frozenState?.projectApprovedResourceCount ??
            detail.resourceCount,
          tokenEstimate:
            frozenState?.projectTokenEstimate ??
            detail.tokenEstimate,
          frozen: Boolean(frozenState),
        })
      })
      .catch((error) => {
        if (!cancelled) {
          setSelectedProjectSummary(null)
          setProjectSummaryError(
            error instanceof Error ? error.message : t('translate.project.summaryError'),
          )
        }
      })
      .finally(() => {
        if (!cancelled) setProjectSummaryLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [restoredProjectState, selectedProjectId, t])

  const removeFreshMarker = useCallback(() => {
    const url = new URL(window.location.href)
    url.searchParams.delete('fresh')
    window.history.replaceState(null, '', url)
  }, [])

  const restoreSavedDraft = useCallback(() => {
    if (!recoverableDraft || draftResolutionBusyRef.current) return
    const lookupDirection = direction
    const presetLookupToken = ++presetLookupTokenRef.current
    updatePresetLookupError(null)
    setSource(recoverableDraft.sourceText)
    setTaskBrief(recoverableDraft.taskBrief)
    setSelectedProjectId(recoverableDraft.selectedProjectId)
    setRestoredProjectState(null)
    setReviewMode(recoverableDraft.reviewMode)
    setMainEditorRunMode(
      recoverableDraft.mainEditorRunMode ?? 'fixed_pipeline',
    )
    setConstraints({
      ...DEFAULT_POETRY_CONSTRAINTS,
      ...(recoverableDraft.constraints ?? {}),
    })
    setAllowedAgentVariantIds(recoverableDraft.allowedAgentVariantIds)
    setSelectedPresetRevisionId(recoverableDraft.selectedPresetRevisionId)
    setSelectedPresetId('')
    void findPresetIdForRevision(
      presets,
      recoverableDraft.selectedPresetRevisionId,
    ).then((presetId) => {
      if (
        presetLookupToken === presetLookupTokenRef.current &&
        directionRef.current === lookupDirection
      ) {
        setSelectedPresetId(presetId)
        updatePresetLookupError(null)
      }
    }).catch((error: unknown) => {
      if (
        presetLookupToken === presetLookupTokenRef.current &&
        directionRef.current === lookupDirection
      ) {
        updatePresetLookupError(
          error instanceof Error
            ? error.message
            : 'workspace_preset_lookup_failed',
        )
      }
    })
    setPromptBundleRevisionId(
      recoverableDraft.promptBundleRevisionId ?? null,
    )
    setRecoverableDraft(null)
    removeFreshMarker()
  }, [
    direction,
    presets,
    recoverableDraft,
    removeFreshMarker,
    updatePresetLookupError,
  ])

  const ignoreSavedDraft = useCallback(async () => {
    if (
      !recoverableDraft ||
      draftResolutionBusy ||
      draftResolutionBusyRef.current
    ) return
    const ignoredDraft = recoverableDraft
    const ignoredDirection = direction
    draftResolutionBusyRef.current = true
    setDraftResolutionBusy(true)
    const request = draftSaveQueueRef.current.catch(() => undefined).then(async () => {
      const response = await fetch(`/api/workspace-drafts/${direction}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceText: source,
          taskBrief,
          selectedProjectId,
          selectedPresetRevisionId,
          promptBundleRevisionId,
          allowedAgentVariantIds,
          reviewMode,
          mainEditorRunMode,
          constraints,
        }),
      })
      if (!response.ok) {
        throw new Error(`workspace_draft_discard_failed:${response.status}`)
      }
      setDraftSaveError(null)
    })
    draftSaveQueueRef.current = request
    pendingDraftSavesRef.current.add(request)
    void request.then(
      () => pendingDraftSavesRef.current.delete(request),
      () => pendingDraftSavesRef.current.delete(request),
    )
    try {
      await request
      if (
        directionRef.current !== ignoredDirection ||
        recoverableDraftRef.current !== ignoredDraft
      ) {
        return
      }
      setRecoverableDraft(null)
      removeFreshMarker()
    } catch (error: unknown) {
      setDraftSaveError(
        error instanceof Error
          ? error.message
          : 'workspace_draft_discard_failed',
      )
    } finally {
      draftResolutionBusyRef.current = false
      setDraftResolutionBusy(false)
    }
  }, [
    allowedAgentVariantIds,
    constraints,
    direction,
    draftResolutionBusy,
    mainEditorRunMode,
    promptBundleRevisionId,
    recoverableDraft,
    removeFreshMarker,
    reviewMode,
    selectedPresetRevisionId,
    selectedProjectId,
    source,
    taskBrief,
  ])

  const continueWithoutPreset = useCallback(() => {
    presetLookupTokenRef.current += 1
    presetSelectionBusyRef.current = false
    setPresetSelectionBusy(false)
    setSelectedPresetId('')
    setSelectedPresetRevisionId(null)
    updatePresetLookupError(null)
  }, [updatePresetLookupError])

  const flushDraft = useCallback((): Promise<void> => {
    if (
      !draftLoaded ||
      draftLoadError ||
      presetLookupError ||
      presetSelectionBusy ||
      busy ||
      restoredSession ||
      recoverableDraft
    ) {
      return Promise.resolve()
    }
    const body = JSON.stringify({
      sourceText: source,
      taskBrief,
      selectedProjectId,
      selectedPresetRevisionId,
      promptBundleRevisionId,
      allowedAgentVariantIds,
      reviewMode,
      mainEditorRunMode,
      constraints,
    })
    const request = draftSaveQueueRef.current.catch(() => undefined).then(
      async () => {
        const response = await fetch(`/api/workspace-drafts/${direction}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body,
        })
        if (!response.ok) {
          throw new Error(`workspace_draft_save_failed:${response.status}`)
        }
        setDraftSaveError(null)
      },
    ).catch((error: unknown) => {
      const message = error instanceof Error
        ? error.message
        : 'workspace_draft_save_failed'
      setDraftSaveError(message)
      throw error
    })
    draftSaveQueueRef.current = request
    pendingDraftSavesRef.current.add(request)
    void request.then(
      () => pendingDraftSavesRef.current.delete(request),
      () => pendingDraftSavesRef.current.delete(request),
    )
    return request
  }, [
    allowedAgentVariantIds,
    busy,
    direction,
    draftLoadError,
    draftLoaded,
    promptBundleRevisionId,
    recoverableDraft,
    reviewMode,
    mainEditorRunMode,
    presetLookupError,
    presetSelectionBusy,
    constraints,
    restoredSession,
    selectedProjectId,
    selectedPresetRevisionId,
    source,
    taskBrief,
  ])

  useEffect(() => {
    const currentDraft = {
      sourceText: source,
      taskBrief,
      selectedProjectId,
      selectedPresetRevisionId,
      allowedAgentVariantIds,
      reviewMode,
      mainEditorRunMode,
      promptBundleRevisionId,
      constraints,
    }
    registerDraftController({
      dirty:
        !restoredSession &&
        hasMeaningfulDraft(currentDraft, catalog),
      flush: flushDraft,
      isInteractionLocked: () =>
        submitPreparingRef.current ||
        draftResolutionBusyRef.current ||
        presetSelectionBusyRef.current ||
        presetLookupErrorRef.current != null,
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
    mainEditorRunMode,
    constraints,
    selectedProjectId,
    selectedPresetRevisionId,
    source,
    taskBrief,
  ])

  useEffect(() => {
    if (
      !draftLoaded ||
      busy ||
      restoredSession ||
      submitPreparing ||
      draftResolutionBusy ||
      presetSelectionBusy
    ) return
    const timer = window.setTimeout(() => {
      if (draftSaveTimerRef.current === timer) {
        draftSaveTimerRef.current = null
      }
      void flushDraft().catch(() => undefined)
    }, 500)
    draftSaveTimerRef.current = timer
    return () => {
      window.clearTimeout(timer)
      if (draftSaveTimerRef.current === timer) {
        draftSaveTimerRef.current = null
      }
    }
  }, [
    allowedAgentVariantIds,
    busy,
    draftLoaded,
    flushDraft,
    reviewMode,
    mainEditorRunMode,
    draftResolutionBusy,
    restoredSession,
    source,
    submitPreparing,
    presetSelectionBusy,
    taskBrief,
  ])

  useEffect(() => {
    if (!presetLookupError) return
    const preventUnresolvedPresetExit = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', preventUnresolvedPresetExit)
    return () => {
      window.removeEventListener('beforeunload', preventUnresolvedPresetExit)
    }
  }, [presetLookupError])

  // 全部完成 → 上抛右栏
  useEffect(() => {
    onAllCompleteChange?.(allComplete)
  }, [allComplete, onAllCompleteChange])

  const charCount = source.length
  const tokenCount = useMemo(() => estimateTokens(source), [source])
  const empty = source.trim().length === 0
  const canSubmit =
    !draftInteractionLocked &&
    !presetSelectionBusy &&
    !presetLookupError &&
    recoverableDraft == null &&
    !empty &&
    allowedAgentVariantIds.filter(
      (id) =>
        catalog.find((variant) => variant.id === id)?.archetypeId !==
        'cultural-context',
    ).length >= 2 &&
    configStatus === 'ready'

  const handleTranslate = async () => {
    if (!canSubmit || submitPreparingRef.current) return
    submitPreparingRef.current = true
    setSubmitPreparing(true)
    if (draftSaveTimerRef.current != null) {
      window.clearTimeout(draftSaveTimerRef.current)
      draftSaveTimerRef.current = null
    }
    try {
      await Promise.all([...pendingDraftSavesRef.current])
      await flushDraft()
      await start({
        sourceText: source,
        direction,
        taskBrief,
        reviewMode,
        mainEditorRunMode,
        constraints,
        allowedAgentVariantIds: Array.from(new Set([
          ...allowedAgentVariantIds,
          ...catalog
            .filter((variant) => variant.archetypeId === 'cultural-context')
            .map((variant) => variant.id),
        ])),
        presetRevisionId: selectedPresetRevisionId,
        promptBundleRevisionId,
        projectId: selectedProjectId,
      })
    } finally {
      submitPreparingRef.current = false
      setSubmitPreparing(false)
    }
  }

  const loadPreset = async (presetId: string) => {
    const requestToken = ++presetLookupTokenRef.current
    const requestDirection = direction
    updatePresetLookupError(null)
    setSelectedPresetId(presetId)
    setSelectedPresetRevisionId(null)
    if (!presetId) {
      presetSelectionBusyRef.current = false
      setPresetSelectionBusy(false)
      return
    }
    presetSelectionBusyRef.current = true
    setPresetSelectionBusy(true)
    const isCurrentRequest = () =>
      requestToken === presetLookupTokenRef.current &&
      directionRef.current === requestDirection
    try {
      const response = await fetch(
        `/api/workflow-presets/${encodeURIComponent(presetId)}`,
      )
      if (!response.ok) {
        throw new Error(`workspace_preset_load_failed:${response.status}`)
      }
      const payload = await response.json() as {
        preset: WorkflowPreset
        revisions: WorkflowPresetRevision[]
      }
      const revision = payload.revisions.find(
        (item) => item.revisionNo === payload.preset.currentRevisionNo,
      )
      if (!revision) throw new Error('workspace_preset_revision_unresolved')
      if (!isCurrentRequest()) return
      setSelectedPresetRevisionId(revision.id)
      setTaskBrief(revision.contract.taskBriefTemplate)
      setAllowedAgentVariantIds(revision.contract.agentVariantIds)
      setReviewMode(revision.contract.reviewMode)
      setMainEditorRunMode(
        revision.contract.mainEditorRunMode ?? 'fixed_pipeline',
      )
      setConstraints({
        ...DEFAULT_POETRY_CONSTRAINTS,
        ...(revision.contract.constraints ?? {}),
      })
      updatePresetLookupError(null)
    } catch (error: unknown) {
      if (!isCurrentRequest()) return
      setSelectedPresetId('')
      setSelectedPresetRevisionId(null)
      updatePresetLookupError(
        error instanceof Error ? error.message : 'workspace_preset_load_failed',
      )
    } finally {
      if (isCurrentRequest()) {
        presetSelectionBusyRef.current = false
        setPresetSelectionBusy(false)
      }
    }
  }

  const preflightFailureText = (code: string | null) => {
    if (code === 'preflight_context_exceeded') {
      return t('preflight.error.preflight_context_exceeded')
    }
    if (code === 'preflight_binding_missing') {
      return t('preflight.error.preflight_binding_missing')
    }
    if (code === 'preflight_snapshot_upgrade_required') {
      return t('preflight.error.preflight_snapshot_upgrade_required')
    }
    if (code === 'preflight_snapshot_changed') {
      return t('preflight.error.preflight_snapshot_changed')
    }
    return t('preflight.error.unknown')
  }

  const preflightActionText = (action: string) => {
    switch (action) {
      case 'configure_context_window_and_output_limit':
        return t('preflight.action.configure_context_window_and_output_limit')
      case 'choose_model_with_larger_context_window':
        return t('preflight.action.choose_model_with_larger_context_window')
      case 'reduce_optional_project_context_or_candidate_count':
        return t('preflight.action.reduce_optional_project_context_or_candidate_count')
      case 'configure_required_stage_model_binding':
        return t('preflight.action.configure_required_stage_model_binding')
      case 'repair_missing_endpoint_binding':
        return t('preflight.action.repair_missing_endpoint_binding')
      case 'configure_at_least_two_candidate_agent_variants':
        return t('preflight.action.configure_at_least_two_candidate_agent_variants')
      case 'create_new_session_with_current_configuration':
        return t('preflight.action.create_new_session_with_current_configuration')
      case 'retry_session_preflight':
        return t('preflight.action.retry_session_preflight')
      default:
        return t('preflight.action.inspect_preflight_failures')
    }
  }

  const preflightAssumptionText = (
    assumption: NonNullable<typeof preflight>['assumptions'][number],
  ) => {
    const values = {
      role: assumption.bindingRole ?? '—',
      value: formatNumber(Number(assumption.value)),
    }
    switch (assumption.code) {
      case 'context_window_defaulted':
        return t('preflight.assumption.context_window_defaulted', values)
      case 'max_output_tokens_defaulted':
        return t('preflight.assumption.max_output_tokens_defaulted', values)
      case 'dynamic_team_all_variants_checked':
        return t('preflight.assumption.dynamic_team_all_variants_checked', values)
      default:
        return t('preflight.assumption.candidate_output_reserved', values)
    }
  }

  // ── 配置检测中 ────────────────────────────────────────────────
  if (configStatus === 'loading' || !draftLoaded) {
    return (
      <Card overline={t('translate.source.overline')} title={t('translate.source.title')} className={className}>
        <div className="flex min-h-56 items-center justify-center text-ink-3">
          <Spinner size="lg" />
        </div>
      </Card>
    )
  }

  if (draftLoadError) {
    return (
      <Card overline={t('translate.source.overline')} title={t('translate.source.title')} className={className}>
        <div
          role="alert"
          data-testid={TID.translate.draftLoadError}
          className="flex min-h-56 flex-col items-center justify-center gap-3 text-center"
        >
          <p className="text-sm font-medium text-ink">
            {t('translate.draft.loadFailedTitle')}
          </p>
          <p className="max-w-md text-sm leading-6 text-ink-3">
            {t('translate.draft.loadFailedDescription')}
          </p>
          <p className="font-mono text-xs text-ink-4">{draftLoadError}</p>
          <Button
            className="mt-2"
            testId={TID.translate.draftLoadRetry}
            onClick={() => setDraftLoadRevision((revision) => revision + 1)}
          >
            {t('translate.draft.retryLoad')}
          </Button>
        </div>
      </Card>
    )
  }

  // ── 未配置端点 / Agent → 引导 CTA ─────────────────────────────
  if (configStatus === 'unconfigured') {
    return (
      <Card overline={t('translate.setup.overline')} title={t('translate.setup.title')} className={className}>
        <div className="flex min-h-56 flex-col items-center justify-center gap-3 text-center">
          <p className="max-w-md text-sm leading-6 text-ink-3">
            {t('translate.setup.description')}
          </p>
          <Button href="/config#compatibility-doctor" className="mt-2">
            {t('translate.setup.open')}
          </Button>
        </div>
      </Card>
    )
  }

  // ── 翻译视图 ──────────────────────────────────────────────────
  return (
    <Card
      overline={t('translate.source.overline')}
      title={t('translate.source.title')}
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
          <p className="font-medium text-ink">{t('translate.draft.found')}</p>
          <p className="mt-1 text-xs text-ink-3">
            {t('translate.draft.updatedAt', {
              date: formatDate(recoverableDraft.updatedAt, {
                dateStyle: 'medium',
                timeStyle: 'short',
              }),
            })}
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="outline"
              testId={TID.translate.draftRestoreButton}
              disabled={draftResolutionBusy}
              onClick={restoreSavedDraft}
            >
              {t('translate.draft.restore')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              testId={TID.translate.draftIgnoreButton}
              disabled={draftResolutionBusy}
              onClick={() => void ignoreSavedDraft()}
            >
              {t('common.ignore')}
            </Button>
          </div>
        </div>
      )}
      {draftSaveError && (
        <div className="fixed bottom-5 right-5 z-[70] max-w-sm">
          <Toast
            role="alert"
            tone="inverted"
            testId={TID.translate.draftSaveError}
            title={t('translate.draft.saveFailed')}
            message={draftSaveError}
            onClose={() => setDraftSaveError(null)}
          />
        </div>
      )}
      {presetLookupError && (
        <div className="fixed bottom-5 left-5 z-[70] max-w-sm">
          <Toast
            role="alert"
            tone="inverted"
            testId={TID.translate.draftPresetLookupError}
            title={t('translate.draft.presetLookupFailed')}
            message={presetLookupError}
            action={
              <Button
                size="sm"
                variant="outline"
                testId={TID.translate.draftPresetContinueWithout}
                onClick={continueWithoutPreset}
              >
                {t('translate.draft.continueWithoutPreset')}
              </Button>
            }
          />
        </div>
      )}
      <Textarea
        testId={TID.translate.sourceInput}
        rows={9}
        value={source}
        onChange={(e) => setSource(e.target.value)}
        disabled={draftInteractionLocked}
        placeholder={t('translate.source.placeholder')}
        aria-label={t('translate.source.aria')}
      />

      <details
        data-testid={TID.translate.requirementsDetails}
        className="responsive-form mt-3 min-w-0 rounded-sm border border-line bg-paper/55"
      >
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-ink-2">
          {t('translate.requirements.summary')}
        </summary>
        <div className="min-w-0 space-y-4 border-t border-line px-3 py-3">
          <div className="min-w-0 rounded-sm border border-line bg-paper/70 px-3 py-3">
            <label className="block text-xs font-medium text-ink-3">
              {t('translate.project.label')}
              <select
                aria-label={t('translate.project.label')}
                value={selectedProjectId ?? ''}
                disabled={draftInteractionLocked}
                onChange={(event) => {
                  setSelectedProjectId(event.target.value || null)
                  setRestoredProjectState(null)
                }}
                className="mt-1 block w-full rounded-sm border border-line-2 bg-paper-raise px-2 py-2 text-sm text-ink"
              >
                <option value="">{t('translate.project.none')}</option>
                {selectedProjectId &&
                  !projects.some((project) => project.id === selectedProjectId) && (
                    <option value={selectedProjectId}>
                      {selectedProjectSummary?.name ?? t('translate.project.unavailable')}
                    </option>
                  )}
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name} · snapshot r
                    {project.currentSnapshotRevisionNo ?? '—'}
                  </option>
                ))}
              </select>
            </label>
            {projectSummaryLoading && (
              <p className="mt-2 text-xs text-ink-4">{t('translate.project.loading')}</p>
            )}
            {projectSummaryError && (
              <p className="mt-2 text-xs text-ink-3">
                {projectSummaryError}
              </p>
            )}
            {selectedProjectSummary && !projectSummaryLoading && (
              <p className="mt-2 text-xs leading-5 text-ink-2">
                {t('translate.project.summary', {
                  name: selectedProjectSummary.name,
                  revision: selectedProjectSummary.snapshotRevisionNo ?? '—',
                  count: formatNumber(selectedProjectSummary.approvedResourceCount),
                  tokens: formatNumber(selectedProjectSummary.tokenEstimate),
                })}
              </p>
            )}
            <p className="mt-2 text-xs leading-5 text-ink-4">
              {selectedProjectSummary?.frozen
                ? t('translate.project.frozen')
                : t('translate.project.freezeOnCreate')}
            </p>
          </div>
          <label className="block text-xs font-medium text-ink-3">
            {t('translate.preset.label')}
            <select
              data-testid={TID.translate.currentPreset}
              value={selectedPresetId}
              disabled={draftInteractionLocked}
              onChange={(event) => void loadPreset(event.target.value)}
              className="mt-1 block w-full rounded-sm border border-line-2 bg-paper-raise px-2 py-2 text-sm text-ink"
            >
              <option value="">{t('translate.preset.none')}</option>
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name} · revision {preset.currentRevisionNo}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-medium text-ink-3">
            {t('translate.promptBundle.label')}
            <select
              value={promptBundleRevisionId ?? ''}
              disabled={draftInteractionLocked}
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
            disabled={draftInteractionLocked}
            aria-label={t('translate.taskBrief.aria')}
            placeholder={t('translate.taskBrief.placeholder')}
          />
          <details className="min-w-0 rounded-sm border border-line bg-paper/70">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-ink-2">
              {t('translate.poetry.summary')}
            </summary>
            <div className="min-w-0 space-y-3 border-t border-line px-3 py-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="text-xs font-medium text-ink-3">
                  {t('translate.poetry.mode')}
                  <select
                    value={constraints.poetryMode ?? 'auto'}
                    disabled={draftInteractionLocked}
                    onChange={(event) =>
                      setConstraints((current) => ({
                        ...current,
                        poetryMode: event.target
                          .value as TranslationConstraints['poetryMode'],
                      }))
                    }
                    className="mt-1 block w-full rounded-sm border border-line-2 bg-paper-raise px-2 py-1.5 text-sm text-ink"
                  >
                    <option value="auto">{t('translate.option.autoDetect')}</option>
                    <option value="on">{t('translate.option.enable')}</option>
                    <option value="off">{t('translate.option.off')}</option>
                  </select>
                </label>
                <label className="text-xs font-medium text-ink-3">
                  {t('translate.poetry.targetForm')}
                  <select
                    value={constraints.poetryTargetForm ?? 'preserve'}
                    disabled={
                      draftInteractionLocked ||
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
                    <option value="preserve">{t('translate.poetry.form.preserve')}</option>
                    <option value="free_verse">{t('translate.poetry.form.freeVerse')}</option>
                    <option value="classical">{t('translate.poetry.form.classical')}</option>
                    <option value="regulated">{t('translate.poetry.form.regulated')}</option>
                    <option value="custom">{t('translate.option.custom')}</option>
                  </select>
                </label>
                {direction === 'en_to_zh' ? (
                  <label className="text-xs font-medium text-ink-3">
                    {t('translate.poetry.chineseRhyme')}
                    <select
                      value={constraints.chineseRhymeSystem ?? 'mandarin'}
                      disabled={
                        draftInteractionLocked ||
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
                      <option value="mandarin">{t('translate.poetry.rhyme.mandarin')}</option>
                      <option value="pingshui">{t('translate.poetry.rhyme.pingshui')}</option>
                      <option value="dual">{t('translate.poetry.rhyme.dual')}</option>
                    </select>
                  </label>
                ) : (
                  <label className="text-xs font-medium text-ink-3">
                    {t('translate.poetry.englishRhyme')}
                    <select
                      value={constraints.englishRhymeMode ?? 'natural'}
                      disabled={
                        draftInteractionLocked ||
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
                      <option value="natural">{t('translate.poetry.english.natural')}</option>
                      <option value="near">{t('translate.poetry.english.near')}</option>
                      <option value="exact">{t('translate.poetry.english.exact')}</option>
                      <option value="none">{t('translate.poetry.english.none')}</option>
                    </select>
                  </label>
                )}
                <label className="text-xs font-medium text-ink-3">
                  {t('translate.poetry.positions')}
                  <select
                    value={constraints.rhymePositions ?? 'auto'}
                    disabled={
                      draftInteractionLocked ||
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
                    <option value="auto">{t('translate.poetry.positions.auto')}</option>
                    <option value="even_lines">{t('translate.poetry.positions.even')}</option>
                    <option value="all_lines">{t('translate.poetry.positions.all')}</option>
                    <option value="custom">{t('translate.poetry.positions.custom')}</option>
                  </select>
                </label>
                <label className="text-xs font-medium text-ink-3">
                  {t('translate.poetry.firstLine')}
                  <select
                    value={constraints.firstLineRhyme ?? 'auto'}
                    disabled={
                      draftInteractionLocked ||
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
                    <option value="auto">{t('translate.option.auto')}</option>
                    <option value="yes">{t('translate.option.yes')}</option>
                    <option value="no">{t('translate.option.no')}</option>
                  </select>
                </label>
                <label className="text-xs font-medium text-ink-3">
                  {t('translate.poetry.change')}
                  <select
                    value={constraints.rhymeChange ?? 'source'}
                    disabled={
                      draftInteractionLocked ||
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
                    <option value="source">{t('translate.poetry.change.source')}</option>
                    <option value="single">{t('translate.poetry.change.single')}</option>
                    <option value="by_stanza">{t('translate.poetry.change.stanza')}</option>
                    <option value="custom">{t('translate.option.custom')}</option>
                  </select>
                </label>
                <label className="text-xs font-medium text-ink-3">
                  {t('translate.poetry.priority')}
                  <select
                    value={constraints.poetryPriority ?? 'balanced'}
                    disabled={
                      draftInteractionLocked ||
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
                    <option value="balanced">{t('translate.poetry.priority.balanced')}</option>
                    <option value="meaning">{t('translate.poetry.priority.meaning')}</option>
                    <option value="form">{t('translate.poetry.priority.form')}</option>
                  </select>
                </label>
              </div>
              <label className="block text-xs font-medium text-ink-3">
                {t('translate.poetry.scheme')}
                <input
                  value={constraints.rhymeScheme ?? ''}
                  disabled={
                    draftInteractionLocked ||
                    constraints.poetryMode === 'off'
                  }
                  onChange={(event) =>
                    setConstraints((current) => ({
                      ...current,
                      rhymeScheme: event.target.value,
                    }))
                  }
                  placeholder={t('translate.poetry.scheme.placeholder')}
                  className="mt-1 block w-full rounded-sm border border-line-2 bg-paper-raise px-2 py-1.5 text-sm text-ink"
                />
              </label>
              <p className="text-xs leading-5 text-ink-4">
                {t('translate.poetry.scope')}
              </p>
            </div>
          </details>
          <div>
            <p className="mb-2 text-xs font-medium text-ink-3">{t('translate.agents.allowed')}</p>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {catalog.map((variant) => (
                <label
                  key={variant.id}
                  className="flex min-w-0 items-start gap-2 rounded-xs border border-line px-2 py-1.5 text-xs text-ink-2"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-ink"
                    checked={allowedAgentVariantIds.includes(variant.id)}
                    disabled={
                      draftInteractionLocked ||
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
                  <span className="min-w-0">
                    <span className="block font-medium text-ink">{variant.catalogName}</span>
                    {variant.archetypeId === 'cultural-context' && (
                      <span className="mb-0.5 block text-[0.6875rem] text-pine">
                        {t('translate.agents.fixedContext')}
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
              <p className="mt-2 text-xs text-cinnabar">{t('translate.agents.minimum')}</p>
            )}
          </div>
          <label className="flex min-w-0 flex-col items-stretch gap-2 text-sm text-ink-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            {t('translate.reviewMode.label')}
            <select
              value={reviewMode}
              disabled={draftInteractionLocked}
              onChange={(event) => setReviewMode(event.target.value as ReviewMode)}
              className="min-w-0 max-w-full rounded-sm border border-line-2 bg-paper-raise px-2 py-1.5 text-sm text-ink"
            >
              <option value="main_editor">{t('translate.reviewMode.mainEditor')}</option>
              <option value="four_stage">{t('translate.reviewMode.fourStage')}</option>
            </select>
          </label>
          {reviewMode === 'main_editor' && (
            <fieldset className="min-w-0 rounded-sm border border-line bg-paper/55 px-3 py-3">
              <legend className="px-1 text-xs font-medium text-ink-3">
                {t('translate.mainEditorRunMode.label')}
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {([
                  [
                    'fixed_pipeline',
                    'translate.mainEditorRunMode.fixed',
                    'translate.mainEditorRunMode.fixedDescription',
                  ],
                  [
                    'tool_enabled',
                    'translate.mainEditorRunMode.tools',
                    'translate.mainEditorRunMode.toolsDescription',
                  ],
                ] as const).map(([value, titleKey, descriptionKey]) => (
                  <label
                    key={value}
                    className={[
                      'flex min-w-0 cursor-pointer items-start gap-2 rounded-sm border px-3 py-2.5',
                      mainEditorRunMode === value
                        ? 'border-ink bg-paper-sink'
                        : 'border-line bg-paper-raise',
                      draftInteractionLocked ? 'cursor-not-allowed opacity-60' : '',
                    ].join(' ')}
                  >
                    <input
                      type="radio"
                      name="main-editor-run-mode"
                      value={value}
                      data-testid={
                        value === 'tool_enabled'
                          ? TID.translate.mainEditorToolMode
                          : TID.translate.mainEditorFixedMode
                      }
                      checked={mainEditorRunMode === value}
                      disabled={draftInteractionLocked}
                      onChange={() => setMainEditorRunMode(value)}
                      className="mt-0.5 accent-ink"
                    />
                    <span className="min-w-0">
                      <span className="block text-xs font-medium text-ink">
                        {t(titleKey)}
                      </span>
                      <span className="mt-0.5 block text-xs leading-5 text-ink-4">
                        {t(descriptionKey)}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
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
          {t('translate.counts', {
            characters: formatNumber(charCount),
            tokens: formatNumber(tokenCount),
          })}
        </p>
        <Button
          testId={TID.translate.translateButton}
          disabled={!canSubmit}
          onClick={handleTranslate}
        >
          {busy || submitPreparing ? (
            <>
              <Spinner size="sm" /> {t('translate.action.running')}
            </>
          ) : (
            t('translate.action.start')
          )}
        </Button>
      </div>

      {preflight && (
        <details
          className={[
            'mt-3 rounded-sm border px-3 py-2.5',
            preflight.status === 'blocked'
              ? 'border-cinnabar/40 bg-cinnabar/5'
              : 'border-pine/40 bg-pine/5',
          ].join(' ')}
          open={preflight.status === 'blocked' ? true : undefined}
        >
          <summary
            className="cursor-pointer text-sm font-medium text-ink"
          >
            {preflight.status === 'blocked'
              ? t('preflight.blocked')
              : t('preflight.pass')}
          </summary>
          <div className="mt-2 space-y-3 border-t border-line pt-2 text-xs leading-5 text-ink-2">
            {preflight.status === 'blocked' && (
              <div role="alert">
                <p className="font-medium text-cinnabar">
                  {preflightFailureText(
                    preflightErrorCode ?? preflight.failures[0]?.code ?? null,
                  )}
                </p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {Array.from(new Set([
                    ...preflightActions,
                    ...preflight.failures.flatMap((failure) => failure.actions),
                  ])).map((action) => (
                    <li key={action}>{preflightActionText(action)}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="font-medium text-ink-3">{t('preflight.details')}</p>
            {preflight.assumptions.length > 0 && (
              <ul className="list-disc space-y-1 pl-5">
                {preflight.assumptions.map((assumption, index) => (
                  <li key={`${assumption.code}-${assumption.bindingRole}-${index}`}>
                    {preflightAssumptionText(assumption)}
                  </li>
                ))}
              </ul>
            )}
            <ul className="space-y-1 font-mono text-[0.6875rem] text-ink-3">
              {preflight.stages.map((stage) => (
                <li key={`${stage.stage}-${stage.bindingRole}-${stage.model}`}>
                  {t('preflight.stage', {
                    stage: stage.stage,
                    model: stage.model,
                    used: formatNumber(stage.totalReservedTokens),
                    limit: formatNumber(stage.contextWindowTokens),
                    calls: formatNumber(stage.callsWorstCase),
                  })}
                </li>
              ))}
            </ul>
          </div>
        </details>
      )}

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
            <span className="font-medium text-pine">
              {t('translate.summary.success', { count: summary.succeeded })}
            </span>
            <span className="mx-1.5 text-ink-4">/</span>
            <span className={summary.failed > 0 ? 'font-medium text-cinnabar' : 'text-ink-3'}>
              {t('translate.summary.failed', { count: summary.failed })}
            </span>
          </span>
          {allComplete ? (
            <span className="text-xs text-pine">{t('translate.summary.complete')}</span>
          ) : (
            summary.failed > 0 && <span className="text-xs text-ink-3">{t('translate.summary.retryHint')}</span>
          )}
        </div>
      )}

      {translationCards.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-y border-line py-2">
          <p className="text-xs font-medium text-ink-2">
            {t('translate.candidates.summary', {
              success: translationCards.filter((card) => card.status === 'complete').length,
              failed: translationCards.filter((card) => card.status === 'error').length,
            })}
          </p>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setTimelineOpen(true)}
            >
              {t('translate.timeline.open')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={
                busy || !translationCards.some((card) => card.status === 'error')
              }
              onClick={() => setRetryAllOpen(true)}
            >
              {t('translate.retryAll.open')}
            </Button>
          </div>
        </div>
      )}

      {contextAnalysisCards.length > 0 && (
        <section className="mt-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-ink-2">
              {t('translate.context.title', { count: contextAnalysisCards.length })}
            </p>
            <span className="text-xs text-ink-4">{t('translate.context.hint')}</span>
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
              {t('translate.poetryPlan.title')}
            </p>
            <span className="text-xs text-ink-4">
              {t('translate.poetryPlan.hint')}
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
          {phase === 'creating'
            ? t('translate.empty.creating')
            : t('translate.empty.waiting')}
        </div>
      )}

      {/* 全局错误通知（会话创建失败 / 管道级错误） */}
      {globalError && (
        <div className="fixed bottom-5 right-5 z-50">
          <Toast
            role="alert"
            tone="inverted"
            title={t('translate.error.title')}
            message={globalError}
            onClose={dismissError}
          />
        </div>
      )}
      <Modal
        open={retryAllOpen}
        onClose={() => setRetryAllOpen(false)}
        title={t('translate.retryAll.title')}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setRetryAllOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setRetryAllOpen(false)
                void retryAll('frozen')
              }}
            >
              {t('translate.retryAll.frozen')}
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                setRetryAllOpen(false)
                void retryAll('current')
              }}
            >
              {t('translate.retryAll.current')}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-6 text-ink-2">
          {t('translate.retryAll.description', {
            count: cards.filter((card) => card.status === 'error').length,
          })}
        </p>
      </Modal>
      <Modal
        open={timelineOpen}
        onClose={() => setTimelineOpen(false)}
        title={t('translate.timeline.title')}
        footer={
          <Button size="sm" onClick={() => setTimelineOpen(false)}>
            {t('common.close')}
          </Button>
        }
      >
        <ol className="space-y-2 text-sm leading-6 text-ink-2">
          {cards.map((card) => (
            <li key={card.chainId ?? card.agentKey}>
              <span className="font-medium text-ink">{card.name}</span>
              {' · '}{card.model}{' · '}{card.status}
              {(card.attempts?.length ?? 0) > 1
                ? t('translate.timeline.attempts', { count: card.attempts!.length })
                : ''}
            </li>
          ))}
        </ol>
      </Modal>
    </Card>
  )
}
