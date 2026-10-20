import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  emitStageStreamEvent,
  onStageStreamEvent,
} from '@/src/lib/client/stage-stream-bus'

afterEach(() => vi.unstubAllGlobals())

describe('shared stage event transport', () => {
  it('only forwards valid stage events and never assigns reasoning a persisted cursor', () => {
    vi.stubGlobal('window', new EventTarget())
    const listener = vi.fn()
    const unsubscribe = onStageStreamEvent(listener)
    emitStageStreamEvent('s1', {
      event: 'stage.delta', id: '12', data: '',
    }, { stage: 'assemble', delta: '译文' })
    emitStageStreamEvent('s1', {
      event: 'stage.reasoning', id: '99999', data: '',
    }, { stage: 'assemble', reasoningPreview: '思考', reasoningCharacters: 2 })
    emitStageStreamEvent('s1', {
      event: 'agent.delta', id: '13', data: '',
    }, { stage: 'assemble', delta: '候选' })
    emitStageStreamEvent('s1', {
      event: 'stage.delta', id: '14', data: '',
    }, { stage: '__proto__', delta: '无效' })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener.mock.calls[0][0].id).toBe(12)
    expect(listener.mock.calls[1][0].id).toBeUndefined()
    unsubscribe()
    emitStageStreamEvent('s1', {
      event: 'stage.completed', id: '15', data: '',
    }, { stage: 'assemble' })
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
