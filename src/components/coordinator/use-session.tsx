'use client'

// ---------------------------------------------------------------------------
// useSessionFull —— 发现当前会话并拉取轻量工作区状态（以服务端为准）
// 监听 session-bus 变更信号；翻译进行中轻量轮询以便完成后自动解锁统筹
// ---------------------------------------------------------------------------

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
import { onStageStreamEvent } from '@/src/lib/client/stage-stream-bus'
import {
  createStageStreamBatcher,
  emptyStageStreams,
  type StageStreamMap,
} from './stage-stream-state'

/** GET /api/sessions/[id]?view=workspace 响应形状（与 handlers.ts 对齐） */
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
  chatActivity?: {
    active: boolean
    startedAt: number | null
    lastHeartbeatAt: number | null
    lastProgressAt: number | null
    phase: 'waiting_for_model' | 'thinking' | 'generating' | 'applying_edits' | null
  }
  patches?: TextPatchView[]
  final_evidence?: TranslationEvidenceReport | null
  latest_version_no: number | null
}

const TRANSLATING_POLL_MS = 3000
const IDLE_SESSION_POLL_MS = 15000

interface SessionWorkspaceContextValue {
  data: SessionFullResponse | null
  sessionId: string | null
  /** 候选正文/状态改变时变化，供按需证据面板失效并重取。 */
  candidateRevision: string
  loading: boolean
  refresh: () => Promise<SessionFullResponse | null>
}

const SessionWorkspaceContext =
  createContext<SessionWorkspaceContextValue | null>(null)
const StageStreamsContext = createContext<StageStreamMap | null>(null)

export function SessionWorkspaceProvider({
  children,
}: {
  children: ReactNode
}) {
  const searchParams = useSearchParams()
  const routeSessionId = searchParams.get('session')
  const [data, setData] = useState<SessionFullResponse | null>(null)
  const [candidateRevision, setCandidateRevision] = useState('0')
  const [sessionId, setSessionId] = useState<string | null>(routeSessionId)
  const [loading, setLoading] = useState(true)
  const [stageStreams, setStageStreams] = useState(emptyStageStreams)
  const idRef = useRef<string | null>(routeSessionId)
  const stageStreamRef = useRef<{
    sessionId: string | null
    lastPersistentEventId: number
    batcher: ReturnType<typeof createStageStreamBatcher>
  } | null>(null)
  const resetStageStreamSession = useCallback((id: string | null) => {
    if (stageStreamRef.current?.sessionId === id) return
    stageStreamRef.current?.batcher.dispose()
    setStageStreams(emptyStageStreams())
    stageStreamRef.current = {
      sessionId: id,
      lastPersistentEventId: 0,
      batcher: createStageStreamBatcher(setStageStreams),
    }
  }, [])
  const requestRef = useRef<{
    id: string
    controller: AbortController
    promise: Promise<SessionFullResponse | null>
  } | null>(null)
  const previousCandidatesRef = useRef<SessionFullResponse['invocations']>(undefined)

  const refresh = useCallback((): Promise<SessionFullResponse | null> => {
    const id = idRef.current
    if (!id) {
      setSessionId(null)
      setData(null)
      setLoading(false)
      return Promise.resolve(null)
    }
    if (requestRef.current?.id === id) return requestRef.current.promise
    requestRef.current?.controller.abort()
    const controller = new AbortController()
    const isCurrent = () => !controller.signal.aborted && idRef.current === id
    const promise = (async () => {
    try {
      const [res, chatActivityRes] = await Promise.all([
        fetch(`/api/sessions/${encodeURIComponent(id)}?view=workspace`, {
          cache: 'no-store', signal: controller.signal,
        }),
        fetch(`/api/sessions/${encodeURIComponent(id)}/chat`, {
          cache: 'no-store', signal: controller.signal,
        }).catch(() => null),
      ])
      if (!isCurrent()) return null
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
      full.chatActivity = chatActivityRes?.ok
        ? await chatActivityRes.json() as SessionFullResponse['chatActivity']
        : {
            active: false,
            startedAt: null,
            lastHeartbeatAt: null,
            lastProgressAt: null,
            phase: null,
          }
      if (!isCurrent()) return null
      // Compare the small candidate set directly rather than serializing its
      // text (or the complete session history) into a second large string.
      const previousCandidates = previousCandidatesRef.current ?? []
      const nextCandidates = full.invocations ?? []
      if (previousCandidates.length !== nextCandidates.length ||
        nextCandidates.some((candidate, index) => {
          const previous = previousCandidates[index]
          return !previous || previous.id !== candidate.id ||
            previous.status !== candidate.status || previous.model !== candidate.model ||
            previous.body_output !== candidate.body_output
        })) {
        setCandidateRevision((revision) => String(Number(revision) + 1))
      }
      previousCandidatesRef.current = nextCandidates
      setData(full)
      setLoading(false)
      return full
    } catch {
      if (isCurrent()) setLoading(false)
      return null
    } finally {
      if (requestRef.current?.controller === controller) requestRef.current = null
    }
    })()
    requestRef.current = { id, controller, promise }
    return promise
  }, [])

  // URL 是方向与正式会话的唯一权威来源。
  useEffect(() => {
    requestRef.current?.controller.abort()
    requestRef.current = null
    previousCandidatesRef.current = undefined
    idRef.current = routeSessionId
    resetStageStreamSession(routeSessionId)
    setSessionId(routeSessionId)
    setData(null)
    setLoading(Boolean(routeSessionId))
    void refresh()
  }, [refresh, routeSessionId, resetStageStreamSession])

  useEffect(() => () => {
    requestRef.current?.controller.abort()
  }, [])

  // The translation hook owns the existing session SSE connection. Consume
  // only stage events here rather than downloading candidate/history twice.
  useEffect(() => {
    const unsubscribe = onStageStreamEvent((detail) => {
      // Read the authoritative ref so a restore replay can arrive in the same
      // turn as a session switch, before React commits another render.
      if (!idRef.current || detail.sessionId !== idRef.current) return
      resetStageStreamSession(detail.sessionId)
      const stream = stageStreamRef.current!
      if (detail.id !== undefined) {
        if (detail.id <= stream.lastPersistentEventId) return
        stream.lastPersistentEventId = detail.id
      }
      stream.batcher.push(detail)
      if (detail.event === 'stage.completed' || detail.event === 'stage.failed') {
        void refresh()
      }
    })
    return () => {
      unsubscribe()
      stageStreamRef.current?.batcher.dispose()
      stageStreamRef.current = null
    }
  }, [refresh, resetStageStreamSession])

  // 会话变更信号：锁定新 sessionId 并重取
  useEffect(() => {
    return onSessionChanged((detail) => {
      if (detail.sessionId) {
        if (idRef.current !== detail.sessionId) {
          requestRef.current?.controller.abort()
          requestRef.current = null
          previousCandidatesRef.current = undefined
          setData(null)
        }
        idRef.current = detail.sessionId
        resetStageStreamSession(detail.sessionId)
        setSessionId(detail.sessionId)
      }
      void refresh()
    })
  }, [refresh, resetStageStreamSession])

  // 服务端运行轻量轮询：断线续跑、暂停和重新成稿都不依赖旧 SSE 生命周期。
  const state = data?.session?.state
  const hasActiveRun = data?.runs?.some(
    (run) => run.status === 'queued' || run.status === 'running',
  )
  const hasActiveChat = data?.chatActivity?.active === true
  useEffect(() => {
    const isEditableSession = state === 'assembled' || state === 'refining'
    if (
      !hasActiveRun &&
      !hasActiveChat &&
      !isEditableSession &&
      state !== 'translating' &&
      state !== 'coordinating'
    ) return
    const active =
      hasActiveRun || hasActiveChat || state === 'translating' || state === 'coordinating'
    const interval = active
        ? TRANSLATING_POLL_MS
        : IDLE_SESSION_POLL_MS
    let cancelled = false
    let checking = false
    const check = async () => {
      if (document.visibilityState === 'hidden' || checking) return
      checking = true
      try {
        if (active) {
          await refresh()
        } else {
          // An idle editor only needs the small activity response. Refresh the
          // full history when a remote chat starts or the window regains focus.
          const id = idRef.current
          if (!id) return
          const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/chat`, {
            cache: 'no-store',
          })
          if (!response.ok || cancelled || id !== idRef.current) return
          const activity = await response.json() as SessionFullResponse['chatActivity']
          if (!cancelled && (activity?.active ||
            JSON.stringify(activity) !== JSON.stringify(data?.chatActivity))) {
            await refresh()
          }
        }
      } catch {
        // A transient background status failure leaves the current text intact.
      } finally {
        checking = false
      }
    }
    const onVisible = () => {
      if (document.visibilityState !== 'hidden') void refresh()
    }
    const timer = setInterval(() => void check(), interval)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [hasActiveRun, hasActiveChat, state, refresh, data?.chatActivity])

  const contextValue = useMemo(
    () => ({ data, sessionId, candidateRevision, loading, refresh }),
    [data, sessionId, candidateRevision, loading, refresh],
  )

  return (
    <SessionWorkspaceContext.Provider value={contextValue}>
      <StageStreamsContext.Provider value={stageStreams}>
        {children}
      </StageStreamsContext.Provider>
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

/** Stream updates stay separate from workspace data and candidate evidence. */
export function useStageStreams() {
  const context = useContext(StageStreamsContext)
  if (!context) {
    throw new Error('useStageStreams must be used inside SessionWorkspaceProvider')
  }
  return context
}
