'use client'

// ---------------------------------------------------------------------------
// useTranslation — 翻译视图状态机（客户端）
//
// 职责：
// - 配置检测（agents/endpoints 是否就绪，决定 CTA 或翻译视图）
// - 会话创建（POST /api/sessions）→ 从 config_snapshot 播种卡片
// - 翻译 SSE 消费（POST translate / 单卡 retry，fetch + ReadableStream
//   + parseSSEChunk 累积缓冲模式，与 src/lib/llm/client.ts 同款）
// - 断流兜底：流结束未见 done / 网络异常 → 在飞卡片转 error，绝不永远 streaming
// - 卸载AbortController 取消在飞流
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseSSEChunk, type SSEEvent } from '@/src/lib/contracts/sse'
import type { ConfigSnapshot, SessionRow } from '@/src/lib/contracts/types'
import { emitSessionChanged } from '@/src/components/coordinator/session-bus'
import type {
  BuiltinDirection,
  ReviewMode,
  TranslationConstraints,
} from '@/src/lib/contracts/vnext'
import type { TranslationEvidenceReport } from '@/src/lib/evidence/checker'
import { parseSemanticAgentOutput } from '@/src/lib/protocol/semantic-output'

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

const DEFAULT_LANG_PAIR: LangPair = { source: '英文', target: '中文' }

export interface StartTranslationInput {
  sourceText: string
  direction: BuiltinDirection
  taskBrief: string
  reviewMode: ReviewMode
  allowedAgentVariantIds: string[]
  constraints: TranslationConstraints
  presetRevisionId?: string | null
  promptBundleRevisionId?: string | null
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

const INTERRUPTED_MESSAGE = '连接已中断'

// ── SSE 消费（累积缓冲 + processedEventCount 跳过已处理事件） ────

async function consumeSSE(
  response: Response,
  onEvent: (event: SSEEvent) => void,
): Promise<void> {
  if (!response.body) throw new Error('响应不含事件流')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let rawBuffer = ''
  let processedEventCount = 0

  const flush = () => {
    const events = parseSSEChunk(rawBuffer)
    for (let i = processedEventCount; i < events.length; i++) {
      onEvent(events[i])
    }
    processedEventCount = events.length
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    rawBuffer += decoder.decode(value, { stream: true })
    flush()
  }
  rawBuffer += decoder.decode()
  flush()
}

/** 从失败响应中提炼错误文案（兼容 {error} 与 {error, message} 两种形状） */
async function readErrorBody(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; message?: string } | null
    return body?.message ?? body?.error ?? fallback
  } catch {
    return fallback
  }
}

// ── Hook ────────────────────────────────────────────────────────

export function useTranslation(direction: BuiltinDirection = 'en_to_zh') {
  const [configStatus, setConfigStatus] = useState<ConfigStatus>('loading')
  const [phase, setPhase] = useState<TranslatePhase>('idle')
  const [cards, setCards] = useState<AgentCardState[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [langPair, setLangPair] = useState<LangPair>(DEFAULT_LANG_PAIR)
  const [globalError, setGlobalError] = useState<string | null>(null)
  const [retryingKey, setRetryingKey] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const clientRequestIdRef = useRef<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    abortRef.current?.abort()
    abortRef.current = null
    clientRequestIdRef.current = null
    setPhase('idle')
    setCards([])
    setSessionId(null)
    setGlobalError(null)
    setRetryingKey(null)
    setLangPair(
      direction === 'en_to_zh'
        ? { source: '英文', target: '中文' }
        : { source: '中文', target: '英文' },
    )
  }, [direction])

  // 卸载：取消在飞 SSE（AbortController），此后一切 setState 静默
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [])

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
          setCards((previous) =>
            previous.map((card) =>
              card.agentKey === invocationId
                ? { ...card, status: 'streaming', text: card.text + delta }
                : card,
            ),
          )
          break
        }
        case 'agent.activity': {
          const invocationId = data.invocationId as string
          patchCard(invocationId, {
            lastActivityAt:
              typeof data.receivedAt === 'string'
                ? data.receivedAt
                : new Date().toISOString(),
          })
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
            error:
              typeof data.error === 'string' ? data.error : 'Agent 调用失败',
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
          setGlobalError(
            typeof data.error === 'string' ? data.error : '运行被中断',
          )
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
          if (!delta) return
          setCards((prev) =>
            prev.map((c) =>
              c.agentKey === key ? { ...c, status: 'streaming', text: c.text + delta } : c,
            ),
          )
          break
        }
        case 'agent_complete': {
          const key = data.agent_key as string
          const content = typeof data.content === 'string' ? data.content : null
          const semantic = parseSemanticAgentOutput(content ?? '')
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
            error: typeof data.error === 'string' ? data.error : '未知错误',
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
          setGlobalError(typeof data.error === 'string' ? data.error : '翻译管道失败')
          break
        }
        // 'done' 由流收尾逻辑统一处理
      }
    },
    [patchCard],
  )

  const restoreSession = useCallback(async (id: string) => {
    setGlobalError(null)
    const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
      cache: 'no-store',
    })
    if (!response.ok) throw new Error('无法恢复历史会话')
    const payload = await response.json() as {
      session: SessionRow
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
    const chains =
      payload.invocationChains ??
      (payload.invocations ?? []).map((invocation) => ({
        rootInvocationId: invocation.id,
        currentInvocation: invocation,
        attempts: [invocation],
        attemptCount: 1,
      }))
    const evidenceByInvocation = new Map<string, TranslationEvidenceReport>()
    for (const event of payload.events ?? []) {
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
    setSessionId(id)
    setLangPair({
      source: payload.session.source_lang,
      target: payload.session.target_lang,
    })
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
          error: invocation.error,
          annotation: invocation.annotation_output,
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
    let snapshot: ConfigSnapshot | null = null
    try {
      snapshot = JSON.parse(payload.session.config_snapshot) as ConfigSnapshot
    } catch {
      snapshot = null
    }
    setPhase(active ? 'streaming' : 'done')
    if (active) {
      const controller = new AbortController()
      abortRef.current?.abort()
      abortRef.current = controller
      void (async () => {
        try {
          const events = await fetch(
            `/api/sessions/${encodeURIComponent(id)}/events?after=${afterEventId}`,
            { signal: controller.signal },
          )
          if (!events.ok) {
            throw new Error(
              await readErrorBody(events, '无法订阅会话事件'),
            )
          }
          await consumeSSE(events, applyEvent)
        } catch (error) {
          if (!controller.signal.aborted && mountedRef.current) {
            setGlobalError(
              error instanceof Error ? error.message : '会话事件连接已中断',
            )
          }
        }
      })()
    }
    return {
      sourceText: payload.session.source_text,
      taskBrief: payload.session.task_brief ?? '',
      reviewMode: payload.session.review_mode ?? 'main_editor',
      selectedPresetRevisionId: payload.session.preset_revision_id ?? null,
      promptBundleRevisionId: snapshot?.promptBundleRevisionId ?? null,
      constraints: snapshot?.constraints ?? {},
      allowedAgentVariantIds:
        snapshot?.agentVariantSnapshots?.map((variant) => variant.id) ?? [],
    }
  }, [applyEvent])

  // ── 主流程：创建会话 → 触发翻译 SSE ────────────────────────────
  const start = useCallback(
    async (input: StartTranslationInput) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setGlobalError(null)
      setCards([])
      setPhase('creating')

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
        if (!createRes.ok) {
          throw new Error(await readErrorBody(createRes, `创建会话失败（${createRes.status}）`))
        }
        const session = (await createRes.json()) as SessionRow
        clientRequestIdRef.current = null

        // 2. 从配置快照播种卡片（快照即权威：名称+模型+数量）
        const snapshot = JSON.parse(session.config_snapshot) as ConfigSnapshot
        if (!mountedRef.current) return
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
        if (!runRes.ok) {
          throw new Error(
            await readErrorBody(runRes, `启动翻译失败（${runRes.status}）`),
          )
        }
        const sseRes =
          snapshot.version === 3
            ? await fetch(`/api/sessions/${session.id}/events`, {
                signal: controller.signal,
              })
            : runRes
        if (!sseRes.ok) {
          throw new Error(await readErrorBody(sseRes, `翻译请求失败（${sseRes.status}）`))
        }
        await consumeSSE(sseRes, applyEvent)

        // 4. 流正常关闭：仍未完结的卡片按断流处理（杀 mock 场景）
        if (!mountedRef.current) return
        failInFlight(INTERRUPTED_MESSAGE)
      } catch (err) {
        if (controller.signal.aborted || !mountedRef.current) return
        failInFlight(INTERRUPTED_MESSAGE)
        setGlobalError(err instanceof Error ? err.message : String(err))
      }
    },
    [applyEvent, failInFlight],
  )

  // ── 单卡重试：仅该卡重置流式，其余卡片原样不动 ─────────────────
  const retry = useCallback(
    async (agentKey: string) => {
      if (!sessionId || retryingKey != null) return

      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setGlobalError(null)
      setRetryingKey(agentKey)
      patchCard(agentKey, { status: 'streaming', text: '', error: null })

      try {
        const res = await fetch(`/api/sessions/${sessionId}/retry`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ invocationId: agentKey }),
          signal: controller.signal,
        })
        if (!res.ok) {
          throw new Error(await readErrorBody(res, `重试请求失败（${res.status}）`))
        }
        const retryRun = await res.json() as {
          afterEventId: number
          invocationId: string
        }
        const events = await fetch(
          `/api/sessions/${sessionId}/events?after=${retryRun.afterEventId}`,
          { signal: controller.signal },
        )
        if (!events.ok) {
          throw new Error(
            await readErrorBody(events, `订阅重试事件失败（${events.status}）`),
          )
        }
        await consumeSSE(events, applyEvent)

        if (!mountedRef.current) return
        // 流关闭后该卡仍在飞 → 断流
        setCards((prev) =>
          prev.map((c) =>
            (c.agentKey === agentKey || c.agentKey === retryRun.invocationId) &&
                (c.status === 'streaming' || c.status === 'pending')
              ? { ...c, status: 'error', error: INTERRUPTED_MESSAGE }
              : c,
          ),
        )
      } catch (err) {
        if (controller.signal.aborted || !mountedRef.current) return
        setCards((prev) =>
          prev.map((c) =>
            c.agentKey === agentKey && (c.status === 'streaming' || c.status === 'pending')
              ? { ...c, status: 'error', error: INTERRUPTED_MESSAGE }
              : c,
          ),
        )
        setGlobalError(err instanceof Error ? err.message : String(err))
      } finally {
        if (mountedRef.current) {
          setRetryingKey(null)
          emitSessionChanged(sessionId)
        }
      }
    },
    [sessionId, retryingKey, applyEvent, patchCard],
  )

  const retryAll = useCallback(
    async (configMode: 'frozen' | 'current') => {
      if (!sessionId || retryingKey != null) return
      const controller = new AbortController()
      abortRef.current?.abort()
      abortRef.current = controller
      setGlobalError(null)
      setRetryingKey('*')
      try {
        const response = await fetch(`/api/sessions/${sessionId}/retry`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            target: { type: 'all_failed' },
            configMode,
          }),
          signal: controller.signal,
        })
        if (!response.ok) {
          throw new Error(
            await readErrorBody(response, `一键重试失败（${response.status}）`),
          )
        }
        const payload = (await response.json()) as {
          runs: Array<{ afterEventId: number }>
        }
        const after = Math.min(
          ...payload.runs.map((run) => run.afterEventId),
        )
        const events = await fetch(
          `/api/sessions/${sessionId}/events?after=${after}`,
          { signal: controller.signal },
        )
        if (!events.ok) throw new Error('无法订阅重试事件')
        await consumeSSE(events, applyEvent)
        await restoreSession(sessionId)
      } catch (error) {
        if (!controller.signal.aborted) {
          setGlobalError(
            error instanceof Error ? error.message : String(error),
          )
        }
      } finally {
        if (mountedRef.current) {
          setRetryingKey(null)
          emitSessionChanged(sessionId)
        }
      }
    },
    [applyEvent, restoreSession, retryingKey, sessionId],
  )

  const dismissError = useCallback(() => setGlobalError(null), [])

  // ── 派生状态 ───────────────────────────────────────────────────
  const busy = phase === 'creating' || phase === 'streaming' || retryingKey != null
  const translationCards = cards.filter(
    (card) =>
      card.kind !== 'context_analysis' && card.kind !== 'poetry_plan',
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
  }
}
