import { describe, expect, it } from 'vitest'
import {
  beginChatActivity,
  endChatActivity,
  getChatActivity,
  markChatActivityProgress,
  touchChatActivity,
} from '../../src/lib/chat/activity'

describe('chat activity registry', () => {
  it('exposes activity to other clients and removes it on completion', () => {
    const sessionId = `activity-${Date.now()}`
    const leaseId = beginChatActivity(sessionId, 100)
    expect(getChatActivity(sessionId)).toEqual({
      active: true,
      startedAt: 100,
      lastHeartbeatAt: 100,
      lastProgressAt: 100,
      phase: 'waiting_for_model',
    })

    touchChatActivity(sessionId, 250)
    expect(getChatActivity(sessionId).lastHeartbeatAt).toBe(250)
    expect(getChatActivity(sessionId).lastProgressAt).toBe(100)

    markChatActivityProgress(sessionId, 'thinking', 275)
    expect(getChatActivity(sessionId)).toMatchObject({
      phase: 'thinking',
      lastHeartbeatAt: 275,
      lastProgressAt: 275,
    })

    markChatActivityProgress(sessionId, 'generating', 300)
    expect(getChatActivity(sessionId)).toMatchObject({
      phase: 'generating',
      lastHeartbeatAt: 300,
      lastProgressAt: 300,
    })

    endChatActivity(sessionId, leaseId)
    expect(getChatActivity(sessionId)).toEqual({
      active: false,
      startedAt: null,
      lastHeartbeatAt: null,
      lastProgressAt: null,
      phase: null,
    })
  })

  it('does not let an older request clear or update a newer lease', () => {
    const sessionId = `activity-lease-${Date.now()}`
    const oldLease = beginChatActivity(sessionId, 100)
    const newLease = beginChatActivity(sessionId, 200)

    touchChatActivity(sessionId, 250, oldLease)
    markChatActivityProgress(sessionId, 'generating', 275, oldLease)
    endChatActivity(sessionId, oldLease)

    expect(getChatActivity(sessionId)).toMatchObject({
      active: true,
      startedAt: 200,
      lastHeartbeatAt: 200,
      phase: 'waiting_for_model',
    })

    endChatActivity(sessionId, newLease)
    expect(getChatActivity(sessionId).active).toBe(false)
  })
})
