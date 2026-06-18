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

// ── Public types ────────────────────────────────────────────────

export type AgentCardStatus = 'pending' | 'streaming' | 'complete' | 'error'

export interface AgentCardState {
  agentKey: string
  name: string
  model: string
  status: AgentCardStatus
  /** 已累积的流式文本（complete 后以服务端 content 为准） */
  text: string
  error: string | null
}

export type TranslatePhase = 'idle' | 'creating' | 'streaming' | 'done'

export type ConfigStatus = 'loading' | 'ready' | 'unconfigured'

export interface LangPair {
  source: string
  target: string
}

const DEFAULT_LANG_PAIR: LangPair = { source: '英文', target: '中文五言' }

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

export function useTranslation() {
  const [configStatus, setConfigStatus] = useState<ConfigStatus>('loading')
  const [phase, setPhase] = useState<TranslatePhase>('idle')
  const [cards, setCards] = useState<AgentCardState[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [langPair, setLangPair] = useState<LangPair>(DEFAULT_LANG_PAIR)
  const [globalError, setGlobalError] = useState<string | null>(null)
  const [retryingKey, setRetryingKey] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)

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
          fetch('/api/agents'),
          fetch('/api/endpoints'),
        ])
        const agents = agentsRes.ok ? ((await agentsRes.json()) as unknown[]) : []
        const endpoints = endpointsRes.ok ? ((await endpointsRes.json()) as unknown[]) : []
        if (cancelled) return
        setConfigStatus(agents.length > 0 && endpoints.length > 0 ? 'ready' : 'unconfigured')
      } catch {
        if (!cancelled) setConfigStatus('unconfigured')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

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
          setCards((prev) =>
            prev.map((c) =>
              c.agentKey === key
                ? { ...c, status: 'complete', text: content ?? c.text, error: null }
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

  // ── 主流程：创建会话 → 触发翻译 SSE ────────────────────────────
  const start = useCallback(
    async (sourceText: string) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setGlobalError(null)
      setCards([])
      setPhase('creating')

      try {
        // 1. 创建会话（守卫在服务端：空原文/超长/无 Agent 均 400）
        const createRes = await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceText }),
          signal: controller.signal,
        })
        if (!createRes.ok) {
          throw new Error(await readErrorBody(createRes, `创建会话失败（${createRes.status}）`))
        }
        const session = (await createRes.json()) as SessionRow

        // 2. 从配置快照播种卡片（快照即权威：名称+模型+数量）
        const snapshot = JSON.parse(session.config_snapshot) as ConfigSnapshot
        if (!mountedRef.current) return
        setSessionId(session.id)
        // 通知统筹/译文面板锁定新会话（session-bus 松耦合集成）
        emitSessionChanged(session.id)
        setLangPair({ source: session.source_lang, target: session.target_lang })
        setCards(
          snapshot.agents.map((a) => ({
            agentKey: a.name,
            name: a.name,
            model: a.model,
            status: 'pending',
            text: '',
            error: null,
          })),
        )
        setPhase('streaming')

        // 3. 翻译 SSE
        const sseRes = await fetch(`/api/sessions/${session.id}/translate`, {
          method: 'POST',
          signal: controller.signal,
        })
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
        const res = await fetch(
          `/api/sessions/${sessionId}/agents/${encodeURIComponent(agentKey)}/retry`,
          { method: 'POST', signal: controller.signal },
        )
        if (!res.ok) {
          throw new Error(await readErrorBody(res, `重试请求失败（${res.status}）`))
        }
        await consumeSSE(res, applyEvent)

        if (!mountedRef.current) return
        // 流关闭后该卡仍在飞 → 断流
        setCards((prev) =>
          prev.map((c) =>
            c.agentKey === agentKey && (c.status === 'streaming' || c.status === 'pending')
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
        if (mountedRef.current) setRetryingKey(null)
      }
    },
    [sessionId, retryingKey, applyEvent, patchCard],
  )

  const dismissError = useCallback(() => setGlobalError(null), [])

  // ── 派生状态 ───────────────────────────────────────────────────
  const busy = phase === 'creating' || phase === 'streaming' || retryingKey != null
  const summary = useMemo(() => {
    if (cards.length === 0 || phase !== 'done') return null
    return {
      succeeded: cards.filter((c) => c.status === 'complete').length,
      failed: cards.filter((c) => c.status === 'error').length,
    }
  }, [cards, phase])
  const allComplete = cards.length > 0 && cards.every((c) => c.status === 'complete')

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
    retry,
    dismissError,
  }
}
