import { randomUUID } from 'node:crypto'

export type ChatActivityPhase =
  | 'waiting_for_model'
  | 'thinking'
  | 'generating'
  | 'applying_edits'

export interface ChatActivitySnapshot {
  active: boolean
  startedAt: number | null
  lastHeartbeatAt: number | null
  lastProgressAt: number | null
  phase: ChatActivityPhase | null
}

interface ActiveChatActivity {
  leaseId: string
  startedAt: number
  lastHeartbeatAt: number
  lastProgressAt: number
  phase: ChatActivityPhase
}

const globalChatState = globalThis as typeof globalThis & {
  __agenticTranslatingChatActivities?: Map<string, ActiveChatActivity>
}

const activities =
  globalChatState.__agenticTranslatingChatActivities ??
  new Map<string, ActiveChatActivity>()

globalChatState.__agenticTranslatingChatActivities = activities

export function beginChatActivity(sessionId: string, now = Date.now()): string {
  const leaseId = randomUUID()
  activities.set(sessionId, {
    leaseId,
    startedAt: now,
    lastHeartbeatAt: now,
    lastProgressAt: now,
    phase: 'waiting_for_model',
  })
  return leaseId
}

export function touchChatActivity(
  sessionId: string,
  now = Date.now(),
  leaseId?: string,
): void {
  const current = activities.get(sessionId)
  if (!current || (leaseId && current.leaseId !== leaseId)) return
  current.lastHeartbeatAt = now
}

export function markChatActivityProgress(
  sessionId: string,
  phase: ChatActivityPhase,
  now = Date.now(),
  leaseId?: string,
): void {
  const current = activities.get(sessionId)
  if (!current || (leaseId && current.leaseId !== leaseId)) return
  current.phase = phase
  current.lastHeartbeatAt = now
  current.lastProgressAt = now
}

export function endChatActivity(sessionId: string, leaseId?: string): void {
  const current = activities.get(sessionId)
  if (leaseId && current?.leaseId !== leaseId) return
  activities.delete(sessionId)
}

export function getChatActivity(sessionId: string): ChatActivitySnapshot {
  const activity = activities.get(sessionId)
  return activity
    ? {
        active: true,
        startedAt: activity.startedAt,
        lastHeartbeatAt: activity.lastHeartbeatAt,
        lastProgressAt: activity.lastProgressAt,
        phase: activity.phase,
      }
    : {
        active: false,
        startedAt: null,
        lastHeartbeatAt: null,
        lastProgressAt: null,
        phase: null,
      }
}
