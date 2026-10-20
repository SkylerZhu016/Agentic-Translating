'use client'

// ---------------------------------------------------------------------------
// useTranslation — 翻译视图状态机（客户端）
//
// 职责：
// - 配置检测（agents/endpoints 是否就绪，决定 CTA 或翻译视图）
// - 会话创建（POST /api/sessions）→ 从 config_snapshot 播种卡片
// - 翻译 SSE 消费（POST translate / 单卡 retry，fetch + ReadableStream
//   + parseSSEChunk 增量缓冲模式）
// - 断流兜底：流结束未见 done / 网络异常 → 在飞卡片转 error，绝不永远 streaming
// - 卸载AbortController 取消在飞流
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  parseSSEChunk,
  takeCompleteSSEText,
  type SSEEvent,
} from '@/src/lib/contracts/sse'
import type { ConfigSnapshot, SessionRow } from '@/src/lib/contracts/types'
import { emitSessionChanged } from '@/src/components/coordinator/session-bus'
import type {
  BuiltinDirection,
  MainEditorRunMode,
  ReviewMode,
  TranslationConstraints,
} from '@/src/lib/contracts/vnext'
import type { TranslationEvidenceReport } from '@/src/lib/evidence/checker'
import { parseSemanticAgentOutput } from '@/src/lib/protocol/semantic-output'
import type { SessionProjectContext } from '@/src/lib/contracts/projects'
import type { SessionPreflightSnapshot } from '@/src/lib/contracts/vnext'
import { useI18n } from '@/src/i18n/LocaleProvider'
import { localizeDiagnosticError } from '@/src/i18n/diagnostic'
import type { Translator } from '@/src/i18n/types'
import { emitStageStreamEvent } from '@/src/lib/client/stage-stream-bus'

// ── Public types ────────────────────────────────────────────────

export type AgentCardStatus = 'pending' | 'streaming' | 'complete' | 'error'

export interface AgentCardState {
  agentKey: string
  chainId?: string
  kind?: 'translation' | 'context_analysis' | 'poetry_plan'
  name: string
  model: string
  status: AgentCardStatus
  /** 已累积的流式文本（complete 后以服务端 content 为准） */
  text: string
  error: string | null
  lastActivityAt?: string
  reasoningPreview?: string
  reasoningCharacters?: number
  reasoningTruncated?: boolean
  annotation?: string | null
  evidence?: TranslationEvidenceReport | null
  attempts?: RestorableInvocation[]
}

export type TranslatePhase = 'idle' | 'creating' | 'streaming' | 'done'

export type ConfigStatus = 'loading' | 'ready' | 'unconfigured'

export interface LangPair {
  source: string
  target: string
}

export interface StartTranslationInput {
  sourceText: string
  direction: BuiltinDirection
  taskBrief: string
  reviewMode: ReviewMode
  mainEditorRunMode: MainEditorRunMode
  allowedAgentVariantIds: string[]
  constraints: TranslationConstraints
  presetRevisionId?: string | null
  promptBundleRevisionId?: string | null
  projectId?: string | null
}

interface CreateSessionErrorPayload {
  error?: string
  message?: string
  actions?: string[]
  preflight?: SessionPreflightSnapshot
}

export interface RestoredTranslationState {
  sourceText: string
  taskBrief: string
  reviewMode: ReviewMode
  mainEditorRunMode: MainEditorRunMode
  selectedPresetRevisionId: string | null
  promptBundleRevisionId: string | null
  constraints: TranslationConstraints
  allowedAgentVariantIds: string[]
  selectedProjectId: string | null
  projectSnapshotId: string | null
  projectTokenEstimate: number | null
  projectApprovedResourceCount: number | null
}

interface RestorableInvocation {
  id: string
  agent_variant_id: string
  agent_snapshot: string
  model: string
  status: 'queued' | 'running' | 'complete' | 'failed' | 'interrupted'
  raw_output: string | null
  body_output: string | null
  annotation_output: string | null
  error: string | null
}

interface RestorableSessionPayload {
  session: SessionRow
  projectContext?: SessionProjectContext | null
  invocations?: RestorableInvocation[]
  invocationChains?: Array<{
    rootInvocationId: string
    currentInvocation: RestorableInvocation
    attempts: RestorableInvocation[]
    attemptCount: number
  }>
  runs?: Array<{ status: string }>
  events?: Array<{
    id: number
    event_type: string
    payload_json: string
  }>
}

// ── SSE 消费（仅保留未完成帧，避免反复解析整段历史） ────────────

async function consumeSSE(
  response: Response,
  onEvent: (event: SSEEvent) => void,
  missingStreamMessage: string,
): Promise<void> {
  if (!response.body) throw new Error(missingStreamMessage)

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let rawBuffer = ''

  const flush = () => {
    const { completeText, remainder } = takeCompleteSSEText(rawBuffer)
    rawBuffer = remainder
    for (const event of parseSSEChunk(completeText)) {
      onEvent(event)
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      rawBuffer += decoder.decode(value, { stream: true })
      flush()
    }
    rawBuffer += decoder.decode()
    flush()
  } finally {
    reader.releaseLock()
  }
}

/** 从失败响应中提炼错误文案（兼容 {error} 与 {error, message} 两种形状） */
async function readErrorBody(
  response: Response,
  fallback: string,
  t: Translator,
): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; message?: string } | null
    return localizeDiagnosticError(
      t,
      body?.error,
      fallback,
    )
  } catch {
    return fallback
  }
}

// ── Hook ────────────────────────────────────────────────────────

/**
 * Keep callback identity stable while always dispatching to the latest render.
 * Consumers can use the result as an effect dependency without turning a
 * display-only update (such as locale) into a data reload.
 */
function useLatestCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const callbackRef = useRef(callback)
  useEffect(() => {
    callbackRef.current = callback
  }, [callback])
  return useCallback((...args: Args) => callbackRef.current(...args), [])
}

export function useTranslation(direction: BuiltinDirection = 'en_to_zh') {
  const { t } = useI18n()
  const [configStatus, setConfigStatus] = useState<ConfigStatus>('loading')
  const [phase, setPhase] = useState<TranslatePhase>('idle')
  const [cards, setCards] = useState<AgentCardState[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [langPair, setLangPair] = useState<LangPair>(() => ({
    source: t('language.english'),
    target: t('language.chinese'),
  }))
  const [preflight, setPreflight] = useState<SessionPreflightSnapshot | null>(null)
  const [preflightErrorCode, setPreflightErrorCode] = useState<string | null>(null)
  const [preflightActions, setPreflightActions] = useState<string[]>([])
  const [globalError, setGlobalError] = useState<string | null>(null)
  const [retryingKey, setRetryingKey] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const clientRequestIdRef = useRef<string | null>(null)
  const mountedRef = useRef(true)
  const sessionIdRef = useRef<string | null>(null)
  const startingRef = useRef<AbortController | null>(null)
  const restoringRef = useRef<AbortController | null>(null)
  const restorePromiseRef = useRef<{
    id: string
    direction: BuiltinDirection
    controller: AbortController | null
    promise: Promise<RestoredTranslationState>
  } | null>(null)
  const retryingKeyRef = useRef<string | null>(null)
  const pendingUpdatesRef = useRef(
    new Map<string, {
      text: string
      annotation?: string
      lastActivityAt?: string
      reasoningPreview?: string
      reasoningCharacters?: number
      reasoningTruncated?: boolean
    }>(),
  )
  const updateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const discardPendingUpdates = useCallback(() => {
    if (updateTimerRef.current !== null) {
      clearTimeout(updateTimerRef.current)
      updateTimerRef.current = null
    }
    pendingUpdatesRef.current.clear()
  }, [])

  // A token burst produces at most one text render every 50 ms. Terminal
  // events flush first so a delayed token can never overwrite a final body.
  const flushPendingUpdates = useCallback(() => {
    if (updateTimerRef.current !== null) {
      clearTimeout(updateTimerRef.current)
      updateTimerRef.current = null
    }
    const updates = pendingUpdatesRef.current
    if (updates.size === 0) return
    pendingUpdatesRef.current = new Map()
    if (!mountedRef.current) return
    setCards((previous) => {
      let changed = false
      const next = previous.map((card) => {
        const update = updates.get(card.agentKey)
        if (!update) return card
        changed = true
        return {
          ...card,
          ...(update.text
            ? { status: 'streaming' as const, text: card.text + update.text }
            : {}),
          ...(update.lastActivityAt
            ? { lastActivityAt: update.lastActivityAt }
            : {}),
          ...(update.annotation
            ? { annotation: (card.annotation ?? '') + update.annotation }
            : {}),
          ...(update.reasoningCharacters !== undefined
            ? {
                reasoningPreview: update.reasoningPreview ?? card.reasoningPreview,
                reasoningCharacters: update.reasoningCharacters,
                reasoningTruncated: update.reasoningTruncated,
              }
            : {}),
        }
      })
      return changed ? next : previous
    })
  }, [])

  const queueCardUpdate = useCallback((
    agentKey: string,
    text: string,
    lastActivityAt?: string,
  ) => {
    if (!text && !lastActivityAt) return
    const pending = pendingUpdatesRef.current.get(agentKey)
    pendingUpdatesRef.current.set(agentKey, {
      ...pending,
      text: (pending?.text ?? '') + text,
      lastActivityAt: lastActivityAt ?? pending?.lastActivityAt,
    })
    if (updateTimerRef.current === null) {
      updateTimerRef.current = setTimeout(flushPendingUpdates, 50)
    }
  }, [flushPendingUpdates])

  const isCurrentRequest = useCallback((controller: AbortController) =>
    mountedRef.current &&
    abortRef.current === controller &&
    !controller.signal.aborted,
  [])

  const beginRequest = useCallback(() => {
    abortRef.current?.abort()
    discardPendingUpdates()
    const controller = new AbortController()
    abortRef.current = controller
    startingRef.current = null
    restoringRef.current = null
    retryingKeyRef.current = null
    setRetryingKey(null)
    return controller
  }, [discardPendingUpdates])

  useEffect(() => {
    abortRef.current?.abort()
    abortRef.current = null
    discardPendingUpdates()
    clientRequestIdRef.current = null
    sessionIdRef.current = null
    startingRef.current = null
    restoringRef.current = null
    retryingKeyRef.current = null
    setPhase('idle')
    setCards([])
    setSessionId(null)
    setGlobalError(null)
    setRetryingKey(null)
    setPreflight(null)
    setPreflightErrorCode(null)
    setPreflightActions([])
  }, [direction, discardPendingUpdates])

  useEffect(() => {
    setLangPair(
      direction === 'en_to_zh'
        ? { source: t('language.english'), target: t('language.chinese') }
        : { source: t('language.chinese'), target: t('language.english') },
    )
  }, [direction, t])

  // 卸载：取消在飞 SSE（AbortController），此后一切 setState 静默
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
      discardPendingUpdates()
    }
  }, [discardPendingUpdates])

  // ── 配置检测（首访一次性，非轮询） ─────────────────────────────
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [agentsRes, endpointsRes] = await Promise.all([
          fetch(`/api/agent-catalog?direction=${direction}`),
          fetch('/api/endpoints'),
        ])
        const catalog = agentsRes.ok
          ? ((await agentsRes.json()) as { variants?: unknown[] })
          : {}
        const endpoints = endpointsRes.ok ? ((await endpointsRes.json()) as unknown[]) : []
        if (cancelled) return
        setConfigStatus(
          (catalog.variants?.length ?? 0) >= 2 && endpoints.length > 0
            ? 'ready'
            : 'unconfigured',
        )
      } catch {
        if (!cancelled) setConfigStatus('unconfigured')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [direction])

  // ── 卡片局部更新 ───────────────────────────────────────────────
  const patchCard = useCallback((agentKey: string, patch: Partial<AgentCardState>) => {
    setCards((prev) => prev.map((c) => (c.agentKey === agentKey ? { ...c, ...patch } : c)))
  }, [])

  /** 断流兜底：在飞（pending/streaming）卡片一律转 error */
  const failInFlight = useCallback((message: string) => {
    setCards((prev) =>
      prev.map((c) =>
        c.status === 'streaming' || c.status === 'pending'
          ? { ...c, status: 'error', error: message }
          : c,
      ),
    )
    setPhase((p) => (p === 'creating' || p === 'streaming' ? 'done' : p))
  }, [])

  /** 将一条 SSE 事件应用到卡片状态 */
  const applyEvent = useCallback(
    (event: SSEEvent) => {
      if (!event.data) return
      let data: Record<string, unknown>
      try {
        data = JSON.parse(event.data) as Record<string, unknown>
      } catch {
        return
      }
      if (sessionIdRef.current && event.event.startsWith('stage.')) {
        emitStageStreamEvent(sessionIdRef.current, event, data)
      }

      if (
        event.event !== 'agent.delta' &&
        event.event !== 'token' &&
        event.event !== 'agent.annotation' &&
        event.event !== 'agent.reasoning' &&
        event.event !== 'agent.activity'
      ) {
        flushPendingUpdates()
      }

      switch (event.event) {
        case 'agent.started': {
          const invocationId = data.invocationId as string
          const variantId = data.agentVariantId as string
          const replacesInvocationId =
            typeof data.replacesInvocationId === 'string'
              ? data.replacesInvocationId
              : null
          setCards((previous) => {
            if (replacesInvocationId) {
              return previous.map((card) =>
                card.agentKey === replacesInvocationId
                  ? {
                      ...card,
                      agentKey: invocationId,
                      name:
                        typeof data.name === 'string' ? data.name : variantId,
                      model:
                        typeof data.model === 'string' ? data.model : card.model,
                      status: 'streaming',
                      text: '',
                      annotation: null,
                      reasoningPreview: '',
                      reasoningCharacters: 0,
                      reasoningTruncated: false,
                      error: null,
                    }
                  : card,
              )
            }
            if (previous.some((card) => card.agentKey === invocationId)) {
              return previous
            }
            return [
              ...previous,
              {
                agentKey: invocationId,
                kind:
                  data.roleKind === 'context_analysis' ||
                  data.roleKind === 'poetry_plan'
                    ? data.roleKind
                    : 'translation',
                name:
                  typeof data.name === 'string' ? data.name : variantId,
                model:
                  typeof data.model === 'string' ? data.model : '',
                status: 'streaming',
                text: '',
                error: null,
              },
            ]
          })
          break
        }
        case 'agent.delta': {
          const invocationId = data.invocationId as string
          const delta = typeof data.delta === 'string' ? data.delta : ''
          queueCardUpdate(invocationId, delta)
          break
        }
        case 'agent.annotation': {
          const invocationId = data.invocationId as string
          const delta = typeof data.delta === 'string' ? data.delta : ''
          const pending = pendingUpdatesRef.current.get(invocationId)
          pendingUpdatesRef.current.set(invocationId, {
            ...pending,
            text: pending?.text ?? '',
            annotation: (pending?.annotation ?? '') + delta,
          })
          if (updateTimerRef.current === null) {
            updateTimerRef.current = setTimeout(flushPendingUpdates, 50)
          }
          break
        }
        case 'agent.reasoning':
        case 'agent.reasoning.completed': {
          const invocationId = data.invocationId as string
          const pending = pendingUpdatesRef.current.get(invocationId)
          pendingUpdatesRef.current.set(invocationId, {
            ...pending,
            text: pending?.text ?? '',
            reasoningPreview: typeof data.reasoningPreview === 'string'
              ? data.reasoningPreview.slice(-4_000)
              : pending?.reasoningPreview,
            reasoningCharacters: typeof data.reasoningCharacters === 'number'
              ? data.reasoningCharacters
              : 0,
            reasoningTruncated: data.reasoningTruncated === true,
          })
          if (updateTimerRef.current === null) {
            updateTimerRef.current = setTimeout(flushPendingUpdates, 50)
          }
          break
        }
        case 'agent.reset': {
          const invocationId = data.invocationId as string
          patchCard(invocationId, {
            text: '', annotation: null,
            reasoningPreview: '', reasoningCharacters: 0, reasoningTruncated: false,
          })
          break
        }
        case 'agent.activity': {
          const invocationId = data.invocationId as string
          queueCardUpdate(
            invocationId,
            '',
            typeof data.receivedAt === 'string'
              ? data.receivedAt
              : new Date().toISOString(),
          )
          break
        }
        case 'agent.completed': {
          const invocationId = data.invocationId as string
          patchCard(invocationId, {
            status: 'complete',
            text: typeof data.body === 'string' ? data.body : '',
            annotation:
              typeof data.annotation === 'string' ? data.annotation : null,
            error: null,
            ...(typeof data.reasoningCharacters === 'number'
              ? { reasoningCharacters: data.reasoningCharacters }
              : {}),
          })
          break
        }
        case 'evidence.checked': {
          const invocationId = data.invocationId as string
          patchCard(invocationId, {
            evidence:
              data.report && typeof data.report === 'object'
                ? data.report as unknown as TranslationEvidenceReport
                : null,
          })
          break
        }
        case 'agent.failed': {
          const invocationId = data.invocationId as string
          patchCard(invocationId, {
            status: 'error',
            error: localizeDiagnosticError(
              t,
              data.error,
              t('error.agent.callFailed'),
            ),
          })
          break
        }
        case 'session.completed': {
          setPhase('done')
          emitSessionChanged()
          break
        }
        case 'run.interrupted': {
          setPhase('done')
          setGlobalError(localizeDiagnosticError(
            t,
            data.error,
            t('error.run.interrupted'),
          ))
          emitSessionChanged()
          break
        }
        case 'run.paused': {
          setPhase('done')
          setGlobalError(null)
          emitSessionChanged()
          break
        }
        case 'agent_start': {
          const key = data.agent_key as string
          patchCard(key, { status: 'streaming' })
          break
        }
        case 'token': {
          const key = data.agent_key as string
          const delta = typeof data.delta === 'string' ? data.delta : ''
          queueCardUpdate(key, delta)
          break
        }
        case 'agent_complete': {
          const key = data.agent_key as string
          const content = typeof data.content === 'string' ? data.content : null
          const semantic = parseSemanticAgentOutput(content ?? '', { format: 'legacy' })
          setCards((prev) =>
            prev.map((c) =>
              c.agentKey === key
                ? {
                    ...c,
                    status: 'complete',
                    text: semantic.body || c.text,
                    annotation: semantic.annotation,
                    error: null,
                  }
                : c,
            ),
          )
          break
        }
        case 'agent_error': {
          const key = data.agent_key as string
          patchCard(key, {
            status: 'error',
            error: localizeDiagnosticError(t, data.error, t('error.unknown')),
          })
          break
        }
        case 'fanout_complete': {
          setPhase('done')
          // 通知统筹面板：会话已转入 translated，stepper 即时解锁
          emitSessionChanged()
          break
        }
        case 'error': {
          setGlobalError(localizeDiagnosticError(
            t,
            data.error,
            t('error.pipeline.failed'),
          ))
          break
        }
        // 'done' 由流收尾逻辑统一处理
      }
    },
    [flushPendingUpdates, patchCard, queueCardUpdate, t],
  )

  const restoreSessionImpl = useCallback(async (
    id: string,
    activeController?: AbortController,
  ) => {
    // Publishing a freshly created session in the URL triggers a form reload.
    // That read must leave the start request (including its /run POST) intact.
    const startingController = startingRef.current
    const preserveStartingRequest =
      !activeController &&
      sessionIdRef.current === id &&
      startingController !== null &&
      isCurrentRequest(startingController)
    const controller = preserveStartingRequest
      ? startingController
      : activeController ?? beginRequest()
    const assertCurrentRequest = () => {
      if (!isCurrentRequest(controller)) {
        throw new DOMException('Session restoration was superseded', 'AbortError')
      }
    }
    assertCurrentRequest()
    // Block actions on the previous session while its replacement is loading.
    if (!preserveStartingRequest) {
      restoringRef.current = controller
      setGlobalError(null)
    }
    let payload: RestorableSessionPayload
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
        cache: 'no-store',
        signal: controller.signal,
      })
      assertCurrentRequest()
      if (!response.ok) throw new Error(t('error.session.restore'))
      payload = await response.json() as RestorableSessionPayload
      assertCurrentRequest()
    } catch (error) {
      assertCurrentRequest()
      if (!preserveStartingRequest) {
        restoringRef.current = null
        failInFlight(t('error.connection.interrupted'))
        setGlobalError(
          error instanceof Error ? error.message : t('error.session.restore'),
        )
      }
      throw error
    }
    let snapshot: ConfigSnapshot | null = null
    try {
      snapshot = JSON.parse(payload.session.config_snapshot) as ConfigSnapshot
    } catch {
      snapshot = null
    }
    const restoredState = {
      sourceText: payload.session.source_text,
      taskBrief: payload.session.task_brief ?? '',
      reviewMode: payload.session.review_mode ?? 'main_editor',
      mainEditorRunMode:
        snapshot?.orchestrationPolicy?.mainEditorRunMode ?? 'fixed_pipeline',
      selectedPresetRevisionId: payload.session.preset_revision_id ?? null,
      promptBundleRevisionId: snapshot?.promptBundleRevisionId ?? null,
      constraints: snapshot?.constraints ?? {},
      allowedAgentVariantIds:
        snapshot?.agentVariantSnapshots?.map((variant) => variant.id) ?? [],
      selectedProjectId:
        payload.projectContext?.projectId ?? snapshot?.projectId ?? null,
      projectSnapshotId:
        payload.projectContext?.projectSnapshotId ??
        snapshot?.projectSnapshotId ??
        null,
      projectTokenEstimate: payload.projectContext?.tokenEstimate ?? null,
      projectApprovedResourceCount:
        payload.projectContext?.resourceRevisionIds.length ?? null,
    } satisfies RestoredTranslationState
    if (preserveStartingRequest) return restoredState
    restoringRef.current = null
    const chains =
      payload.invocationChains ??
      (payload.invocations ?? []).map((invocation) => ({
        rootInvocationId: invocation.id,
        currentInvocation: invocation,
        attempts: [invocation],
        attemptCount: 1,
      }))
    const evidenceByInvocation = new Map<string, TranslationEvidenceReport>()
    const reasoningByInvocation = new Map<string, number>()
    for (const event of payload.events ?? []) {
      if (event.event_type.startsWith('stage.')) {
        try {
          emitStageStreamEvent(id, {
            event: event.event_type,
            id: String(event.id),
            data: event.payload_json,
          }, JSON.parse(event.payload_json) as Record<string, unknown>)
        } catch {
          // Malformed historical preview events do not prevent restoration.
        }
      }
      if (event.event_type === 'agent.reasoning.completed' || event.event_type === 'agent.completed') {
        try {
          const value = JSON.parse(event.payload_json) as {
            invocationId?: string
            reasoningCharacters?: number
          }
          if (value.invocationId && typeof value.reasoningCharacters === 'number') {
            reasoningByInvocation.set(value.invocationId, value.reasoningCharacters)
          }
        } catch {
          // Historical reasoning statistics are optional diagnostics.
        }
      }
      if (event.event_type !== 'evidence.checked') continue
      try {
        const value = JSON.parse(event.payload_json) as {
          invocationId?: string
          report?: TranslationEvidenceReport
        }
        if (value.invocationId && value.report) {
          evidenceByInvocation.set(value.invocationId, value.report)
        }
      } catch {
        // Ignore malformed historical audit events.
      }
    }
    sessionIdRef.current = id
    setSessionId(id)
    setLangPair(
      direction === 'en_to_zh'
        ? { source: t('language.english'), target: t('language.chinese') }
        : { source: t('language.chinese'), target: t('language.english') },
    )
    setCards(
      chains.map((chain) => {
        const invocation = chain.currentInvocation
        let name = invocation.agent_variant_id
        let kind: AgentCardState['kind'] = 'translation'
        try {
          const snapshot = JSON.parse(invocation.agent_snapshot) as {
            catalogName?: string
            roleKind?: string
            analysisIndex?: number
          }
          name = snapshot.catalogName ?? name
          if (snapshot.roleKind === 'context_analysis') {
            kind = 'context_analysis'
            name = `${name} ${snapshot.analysisIndex ?? ''}`.trim()
          } else if (snapshot.roleKind === 'poetry_plan') {
            kind = 'poetry_plan'
          }
        } catch {
          // Preserve stable variant id when a legacy snapshot is malformed.
        }
        return {
          agentKey: invocation.id,
          chainId: chain.rootInvocationId,
          kind,
          name,
          model: invocation.model,
          status:
            invocation.status === 'complete'
              ? 'complete'
              : invocation.status === 'failed' ||
                  invocation.status === 'interrupted'
                ? 'error'
                : 'streaming',
          text: invocation.body_output ?? '',
          error: invocation.error
            ? localizeDiagnosticError(t, invocation.error, t('error.unknown'))
            : null,
          annotation: invocation.annotation_output,
          reasoningCharacters: reasoningByInvocation.get(invocation.id),
          evidence: evidenceByInvocation.get(invocation.id) ?? null,
          attempts: chain.attempts,
        }
      }),
    )
    const active = (payload.runs ?? []).some(
      (run) => run.status === 'queued' || run.status === 'running',
    )
    const afterEventId =
      payload.events && payload.events.length > 0
        ? payload.events[payload.events.length - 1].id
        : 0
    setPreflight(snapshot?.version === 3 ? snapshot.preflight ?? null : null)
    setPreflightErrorCode(null)
    setPreflightActions([])
    setPhase(active ? 'streaming' : 'done')
    if (active) {
      void (async () => {
        try {
          const events = await fetch(
            `/api/sessions/${encodeURIComponent(id)}/events?after=${afterEventId}`,
            { signal: controller.signal },
          )
          if (!isCurrentRequest(controller)) return
          if (!events.ok) {
            throw new Error(
              await readErrorBody(events, t('error.session.events'), t),
            )
          }
          await consumeSSE(events, (event) => {
            if (isCurrentRequest(controller)) applyEvent(event)
          }, t('error.stream.missing'))
          if (!isCurrentRequest(controller)) return
          flushPendingUpdates()
          failInFlight(t('error.connection.interrupted'))
        } catch (error) {
          if (isCurrentRequest(controller)) {
            flushPendingUpdates()
            failInFlight(t('error.connection.interrupted'))
            setGlobalError(
              error instanceof Error ? error.message : t('error.session.eventsInterrupted'),
            )
          }
        }
      })()
    }
    return restoredState
  }, [
    applyEvent,
    beginRequest,
    direction,
    failInFlight,
    flushPendingUpdates,
    isCurrentRequest,
    t,
  ])
  const restoreSession = useLatestCallback((id: string) => {
    const pending = restorePromiseRef.current
    if (
      pending?.id === id &&
      pending.direction === direction &&
      pending.controller !== null &&
      isCurrentRequest(pending.controller)
    ) {
      return pending.promise
    }
    const promise = restoreSessionImpl(id)
    const request = { id, direction, controller: abortRef.current, promise }
    restorePromiseRef.current = request
    const clearRequest = () => {
      if (restorePromiseRef.current === request) {
        restorePromiseRef.current = null
      }
    }
    // Handle both outcomes here without creating an unhandled rejected
    // finally-Promise. Every caller still receives the original result/error.
    void promise.then(clearRequest, clearRequest)
    return promise
  })

  // ── 主流程：创建会话 → 触发翻译 SSE ────────────────────────────
  const start = useCallback(
    async (input: StartTranslationInput) => {
      const controller = beginRequest()
      startingRef.current = controller

      sessionIdRef.current = null
      setSessionId(null)
      setGlobalError(null)
      setCards([])
      setPhase('creating')
      setPreflight(null)
      setPreflightErrorCode(null)
      setPreflightActions([])

      try {
        // 1. 创建会话（守卫在服务端：空原文/超长/无 Agent 均 400）
        const clientRequestId =
          clientRequestIdRef.current ?? crypto.randomUUID()
        clientRequestIdRef.current = clientRequestId
        const createRes = await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...input,
            clientRequestId,
          }),
          signal: controller.signal,
        })
        if (!isCurrentRequest(controller)) return
        if (!createRes.ok) {
          let errorPayload: CreateSessionErrorPayload | null = null
          try {
            errorPayload = await createRes.json() as CreateSessionErrorPayload
          } catch {
            errorPayload = null
          }
          if (!isCurrentRequest(controller)) return
          if (errorPayload?.preflight) {
            setPreflight(errorPayload.preflight)
            setPreflightErrorCode(errorPayload.error ?? null)
            setPreflightActions(errorPayload.actions ?? [])
          }
          const preflightMessage =
            errorPayload?.error === 'preflight_context_exceeded'
              ? t('preflight.error.preflight_context_exceeded')
              : errorPayload?.error === 'preflight_binding_missing'
                ? t('preflight.error.preflight_binding_missing')
                : errorPayload?.error === 'preflight_snapshot_upgrade_required'
                  ? t('preflight.error.preflight_snapshot_upgrade_required')
                  : errorPayload?.error === 'preflight_snapshot_changed'
                    ? t('preflight.error.preflight_snapshot_changed')
                    : null
          throw new Error(
            preflightMessage
              ?? localizeDiagnosticError(
                t,
                errorPayload?.error,
                t('error.session.create', { status: createRes.status }),
              ),
          )
        }
        const session = (await createRes.json()) as SessionRow & {
          public_config_snapshot?: ConfigSnapshot
        }
        if (!isCurrentRequest(controller)) return
        clientRequestIdRef.current = null

        // 2. 从配置快照播种卡片（快照即权威：名称+模型+数量）
        const snapshot = JSON.parse(session.config_snapshot) as ConfigSnapshot
        const publicSnapshot = session.public_config_snapshot
        setPreflight(
          publicSnapshot?.version === 3
            ? publicSnapshot.preflight ?? null
            : snapshot.version === 3
              ? snapshot.preflight ?? null
              : null,
        )
        sessionIdRef.current = session.id
        setSessionId(session.id)
        const sessionUrl = new URL(window.location.href)
        sessionUrl.search = ''
        sessionUrl.searchParams.set('session', session.id)
        window.history.replaceState(null, '', sessionUrl)
        // 通知统筹/译文面板锁定新会话（session-bus 松耦合集成）
        emitSessionChanged(session.id)
        setLangPair({ source: session.source_lang, target: session.target_lang })
        setCards(
          snapshot.version === 3
            ? []
            : snapshot.agents.map((a) => ({
                agentKey: a.name,
                name: a.name,
                model: a.model,
                status: 'pending' as const,
                text: '',
                error: null,
              })),
        )
        setPhase('streaming')

        // 3. vNext 运行由服务端持有；SSE 只订阅，不控制任务生命周期。
        const runRes = await fetch(
          snapshot.version === 3
            ? `/api/sessions/${session.id}/run`
            : `/api/sessions/${session.id}/translate`,
          { method: 'POST', signal: controller.signal },
        )
        if (!isCurrentRequest(controller)) return
        if (!runRes.ok) {
          throw new Error(
            await readErrorBody(
              runRes,
              t('error.translation.start', { status: runRes.status }),
              t,
            ),
          )
        }
        const sseRes =
          snapshot.version === 3
            ? await fetch(`/api/sessions/${session.id}/events`, {
                signal: controller.signal,
              })
            : runRes
        if (!isCurrentRequest(controller)) return
        if (!sseRes.ok) {
          throw new Error(await readErrorBody(
            sseRes,
            t('error.translation.request', { status: sseRes.status }),
            t,
          ))
        }
        await consumeSSE(sseRes, (event) => {
          if (isCurrentRequest(controller)) applyEvent(event)
        }, t('error.stream.missing'))

        // 4. 流正常关闭：仍未完结的卡片按断流处理（杀 mock 场景）
        if (!isCurrentRequest(controller)) return
        flushPendingUpdates()
        failInFlight(t('error.connection.interrupted'))
      } catch (err) {
        if (!isCurrentRequest(controller)) return
        flushPendingUpdates()
        failInFlight(t('error.connection.interrupted'))
        setGlobalError(err instanceof Error ? err.message : String(err))
      } finally {
        if (startingRef.current === controller) startingRef.current = null
      }
    },
    [
      applyEvent,
      beginRequest,
      failInFlight,
      flushPendingUpdates,
      isCurrentRequest,
      t,
    ],
  )

  // ── 单卡重试：仅该卡重置流式，其余卡片原样不动 ─────────────────
  const retry = useCallback(
    async (agentKey: string) => {
      const activeSessionId = sessionIdRef.current
      if (
        !activeSessionId ||
        restoringRef.current !== null ||
        retryingKeyRef.current !== null
      ) return
      flushPendingUpdates()
      const controller = beginRequest()
      retryingKeyRef.current = agentKey
      let retryInvocationId = agentKey

      setGlobalError(null)
      setRetryingKey(agentKey)
      patchCard(agentKey, {
        status: 'streaming', text: '', error: null, annotation: null,
        reasoningPreview: '', reasoningCharacters: 0, reasoningTruncated: false,
      })

      try {
        const res = await fetch(`/api/sessions/${activeSessionId}/retry`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ invocationId: agentKey }),
          signal: controller.signal,
        })
        if (!isCurrentRequest(controller)) return
        if (!res.ok) {
          throw new Error(await readErrorBody(
            res,
            t('error.retry.request', { status: res.status }),
            t,
          ))
        }
        const retryRun = await res.json() as {
          afterEventId: number
          invocationId: string
        }
        if (!isCurrentRequest(controller)) return
        retryInvocationId = retryRun.invocationId
        const events = await fetch(
          `/api/sessions/${activeSessionId}/events?after=${retryRun.afterEventId}`,
          { signal: controller.signal },
        )
        if (!isCurrentRequest(controller)) return
        if (!events.ok) {
          throw new Error(
            await readErrorBody(
              events,
              t('error.retry.events', { status: events.status }),
              t,
            ),
          )
        }
        await consumeSSE(events, (event) => {
          if (isCurrentRequest(controller)) applyEvent(event)
        }, t('error.stream.missing'))

        if (!isCurrentRequest(controller)) return
        flushPendingUpdates()
        // 流关闭后该卡仍在飞 → 断流
        setCards((prev) =>
          prev.map((c) =>
            (c.agentKey === agentKey || c.agentKey === retryRun.invocationId) &&
                (c.status === 'streaming' || c.status === 'pending')
              ? { ...c, status: 'error', error: t('error.connection.interrupted') }
              : c,
          ),
        )
      } catch (err) {
        if (!isCurrentRequest(controller)) return
        flushPendingUpdates()
        setCards((prev) =>
          prev.map((c) =>
            (c.agentKey === agentKey || c.agentKey === retryInvocationId) &&
              (c.status === 'streaming' || c.status === 'pending')
              ? { ...c, status: 'error', error: t('error.connection.interrupted') }
              : c,
          ),
        )
        setGlobalError(err instanceof Error ? err.message : String(err))
      } finally {
        if (isCurrentRequest(controller)) {
          retryingKeyRef.current = null
          setRetryingKey(null)
          emitSessionChanged(activeSessionId)
        }
      }
    },
    [
      applyEvent,
      beginRequest,
      flushPendingUpdates,
      isCurrentRequest,
      patchCard,
      t,
    ],
  )

  const retryAll = useCallback(
    async (configMode: 'frozen' | 'current') => {
      const activeSessionId = sessionIdRef.current
      if (
        !activeSessionId ||
        restoringRef.current !== null ||
        retryingKeyRef.current !== null
      ) return
      flushPendingUpdates()
      const controller = beginRequest()
      retryingKeyRef.current = '*'
      setGlobalError(null)
      setRetryingKey('*')
      try {
        const response = await fetch(`/api/sessions/${activeSessionId}/retry`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            target: { type: 'all_failed' },
            configMode,
          }),
          signal: controller.signal,
        })
        if (!isCurrentRequest(controller)) return
        if (!response.ok) {
          throw new Error(
            await readErrorBody(
              response,
              t('error.retry.all', { status: response.status }),
              t,
            ),
          )
        }
        const payload = (await response.json()) as {
          runs: Array<{ afterEventId: number }>
        }
        if (!isCurrentRequest(controller)) return
        if (payload.runs.length === 0) {
          await restoreSessionImpl(activeSessionId, controller)
          return
        }
        const after = Math.min(
          ...payload.runs.map((run) => run.afterEventId),
        )
        const events = await fetch(
          `/api/sessions/${activeSessionId}/events?after=${after}`,
          { signal: controller.signal },
        )
        if (!isCurrentRequest(controller)) return
        if (!events.ok) throw new Error(t('error.retry.subscribe'))
        await consumeSSE(events, (event) => {
          if (isCurrentRequest(controller)) applyEvent(event)
        }, t('error.stream.missing'))
        if (!isCurrentRequest(controller)) return
        flushPendingUpdates()
        await restoreSessionImpl(activeSessionId, controller)
      } catch (error) {
        if (isCurrentRequest(controller)) {
          flushPendingUpdates()
          failInFlight(t('error.connection.interrupted'))
          setGlobalError(
            error instanceof Error ? error.message : String(error),
          )
        }
      } finally {
        if (isCurrentRequest(controller)) {
          retryingKeyRef.current = null
          setRetryingKey(null)
          emitSessionChanged(activeSessionId)
        }
      }
    },
    [
      applyEvent,
      beginRequest,
      failInFlight,
      flushPendingUpdates,
      isCurrentRequest,
      restoreSessionImpl,
      t,
    ],
  )

  const dismissError = useCallback(() => setGlobalError(null), [])

  // ── 派生状态 ───────────────────────────────────────────────────
  const busy = phase === 'creating' || phase === 'streaming' || retryingKey != null
  const translationCards = useMemo(
    () => cards.filter(
      (card) =>
        card.kind !== 'context_analysis' && card.kind !== 'poetry_plan',
    ),
    [cards],
  )
  const summary = useMemo(() => {
    if (translationCards.length === 0 || phase !== 'done') return null
    return {
      succeeded: translationCards.filter((c) => c.status === 'complete').length,
      failed: translationCards.filter((c) => c.status === 'error').length,
    }
  }, [phase, translationCards])
  const allComplete =
    translationCards.length > 0 &&
    translationCards.every((card) => card.status === 'complete')

  return {
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
  }
}
