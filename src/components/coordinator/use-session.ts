'use client'

// ---------------------------------------------------------------------------
// useSessionFull —— 发现当前会话并拉取全量状态（以服务端为准，无前端缓存）
// 监听 session-bus 变更信号；翻译进行中轻量轮询以便完成后自动解锁统筹
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ChatMessageRow,
  FinalVersionRow,
  SessionRow,
  StageOutputRow,
  TranslationResultRow,
} from '@/src/lib/contracts/types'
import { onSessionChanged } from './session-bus'

/** GET /api/sessions/[id] 响应形状（与 handlers.ts 对齐） */
export interface SessionFullResponse {
  session: SessionRow
  results: TranslationResultRow[]
  stages: StageOutputRow[]
  versions: FinalVersionRow[]
  messages: ChatMessageRow[]
  latest_version_no: number | null
}

const TRANSLATING_POLL_MS = 3000

export function useSessionFull() {
  const [data, setData] = useState<SessionFullResponse | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const idRef = useRef<string | null>(null)

  const refresh = useCallback(async (): Promise<SessionFullResponse | null> => {
    try {
      let id = idRef.current
      if (!id) {
        // 发现最近会话（sessions 按 updated_at DESC 排列）
        const listRes = await fetch('/api/sessions?limit=1', { cache: 'no-store' })
        if (!listRes.ok) {
          setLoading(false)
          return null
        }
        const list = (await listRes.json()) as { sessions?: SessionRow[] }
        id = list.sessions?.[0]?.id ?? null
        if (!id) {
          idRef.current = null
          setSessionId(null)
          setData(null)
          setLoading(false)
          return null
        }
        idRef.current = id
        setSessionId(id)
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

  // 初次装载
  useEffect(() => {
    void refresh()
  }, [refresh])

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

  // 翻译进行中轻量轮询：翻译完成后 stepper 自动解锁
  const state = data?.session?.state
  useEffect(() => {
    if (state !== 'translating' && state !== 'draft') return
    const timer = setInterval(() => void refresh(), TRANSLATING_POLL_MS)
    return () => clearInterval(timer)
  }, [state, refresh])

  return { data, sessionId, loading, refresh }
}
