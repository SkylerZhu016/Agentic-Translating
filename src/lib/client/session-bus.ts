// ---------------------------------------------------------------------------
// 会话变更总线（Wave 4 各面板共享）—— 跨面板松耦合刷新信号
// 翻译（22）/统筹（23）/编辑（24）面板推进会话后 dispatch；
// 各面板监听信号重取服务端状态（不缓存前端阶段结果，一律以服务端为准）
// ---------------------------------------------------------------------------

export const SESSION_CHANGED_EVENT = 'agentic:session-changed'

export interface SessionChangedDetail {
  sessionId?: string
}

/** 广播会话变更；可选携带 sessionId 让监听方直接锁定新会话 */
export function emitSessionChanged(sessionId?: string): void {
  if (typeof window === 'undefined') return
  const detail: SessionChangedDetail = { sessionId }
  window.dispatchEvent(new CustomEvent(SESSION_CHANGED_EVENT, { detail }))
}

/** 监听会话变更；返回解绑函数（供 useEffect cleanup 直接返回） */
export function onSessionChanged(
  listener: (detail: SessionChangedDetail) => void,
): () => void {
  if (typeof window === 'undefined') return () => {}
  const handler = (e: Event) => {
    listener((e as CustomEvent<SessionChangedDetail>).detail ?? {})
  }
  window.addEventListener(SESSION_CHANGED_EVENT, handler)
  return () => window.removeEventListener(SESSION_CHANGED_EVENT, handler)
}
