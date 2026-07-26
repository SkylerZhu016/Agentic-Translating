'use client'

// ---------------------------------------------------------------------------
// useSessionFull —— 发现当前会话并拉取全量状态（以服务端为准，无前端缓存）
// 监听 session-bus 变更信号；翻译进行中轻量轮询以便完成后自动解锁统筹
// ---------------------------------------------------------------------------

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useSearchParams } from 'next/navigation'
import type {
  ChatMessageRow,
  FinalVersionRow,
  SessionRow,
  StageOutputRow,
  TranslationResultRow,
} from '@/src/lib/contracts/types'
import { onSessionChanged } from './session-bus'
import type { TextPatchView } from '@/src/components/editor/RevisionEvidence'
import type { TranslationEvidenceReport } from '@/src/lib/evidence/checker'

/** GET /api/sessions/[id] 响应形状（与 handlers.ts 对齐） */
export interface SessionFullResponse {
  session: SessionRow
  results: TranslationResultRow[]
  stages: StageOutputRow[]
  versions: FinalVersionRow[]
  finalVersion: FinalVersionRow | null
  messages: ChatMessageRow[]
  invocations?: Array<{
    id: string
    status: string
    model: string
    agent_snapshot: string
    body_output: string | null
    error: string | null
  }>
  runs?: Array<{ id: string; status: string; phase: string; error: string | null }>
  runControl?: {
    pause_requested: number
    candidates_stale: number
    updated_at: string | null
  }
  events?: Array<{ id: number; event_type: string; payload_json: string }>
  patches?: TextPatchView[]
  final_evidence?: TranslationEvidenceReport | null
  latest_version_no: number | null
}

const TRANSLATING_POLL_MS = 3000

interface SessionWorkspaceContextValue {
  data: SessionFullResponse | null
  sessionId: string | null
  loading: boolean
  refresh: () => Promise<SessionFullResponse | null>
}

const SessionWorkspaceContext =
  createContext<SessionWorkspaceContextValue | null>(null)

export function SessionWorkspaceProvider({
  children,
}: {
  children: ReactNode
}) {
  const searchParams = useSearchParams()
  const routeSessionId = searchParams.get('session')
  const [data, setData] = useState<SessionFullResponse | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(routeSessionId)
  const [loading, setLoading] = useState(true)
  const idRef = useRef<string | null>(routeSessionId)

  const refresh = useCallback(async (): Promise<SessionFullResponse | null> => {
    try {
      const id = idRef.current
      if (!id) {
        setSessionId(null)
        setData(null)
        setLoading(false)
        return null
      }

      const res = await fetch(`/api/sessions/${id}`, { cache: 'no-store' })
      if (res.status === 404) {
        idRef.current = null
        setSessionId(null)
        setData(null)
        setLoading(false)
        return null
      }
      if (!res.ok) {
        setLoading(false)
        return null
      }
      const full = (await res.json()) as SessionFullResponse
      setData(full)
      setLoading(false)
      return full
    } catch {
      setLoading(false)
      return null
    }
  }, [])

  // URL 是方向与正式会话的唯一权威来源。
  useEffect(() => {
    idRef.current = routeSessionId
    setSessionId(routeSessionId)
    setData(null)
    setLoading(Boolean(routeSessionId))
    void refresh()
  }, [refresh, routeSessionId])

  // 会话变更信号：锁定新 sessionId 并重取
  useEffect(() => {
    return onSessionChanged((detail) => {
      if (detail.sessionId) {
        idRef.current = detail.sessionId
        setSessionId(detail.sessionId)
      }
      void refresh()
    })
  }, [refresh])

  // 服务端运行轻量轮询：断线续跑、暂停和重新成稿都不依赖旧 SSE 生命周期。
  const state = data?.session?.state
  const hasActiveRun = data?.runs?.some(
    (run) => run.status === 'queued' || run.status === 'running',
  )
  useEffect(() => {
    if (
      !hasActiveRun &&
      state !== 'translating' &&
      state !== 'coordinating'
    ) return
    const timer = setInterval(() => void refresh(), TRANSLATING_POLL_MS)
    return () => clearInterval(timer)
  }, [hasActiveRun, state, refresh])

  return (
    <SessionWorkspaceContext.Provider
      value={{ data, sessionId, loading, refresh }}
    >
      {children}
    </SessionWorkspaceContext.Provider>
  )
}

export function useSessionFull() {
  const context = useContext(SessionWorkspaceContext)
  if (!context) {
    throw new Error(
      'useSessionFull must be used inside SessionWorkspaceProvider',
    )
  }
  return context
}
