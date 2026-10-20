import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyStageStreamEvent,
  createStageStreamBatcher,
  emptyStageStream,
  STAGE_REASONING_FLUSH_MS,
  STAGE_TEXT_FLUSH_MS,
} from '@/src/components/coordinator/stage-stream-state'
import type { StageStreamEventDetail } from '@/src/lib/client/stage-stream-bus'

const event = (
  name: string,
  data: Record<string, unknown> = {},
): StageStreamEventDetail => ({
  sessionId: 'session-1',
  stage: 'assemble',
  event: name,
  data,
})

afterEach(() => vi.useRealTimers())

describe('coordination stream isolation and repaint budget', () => {
  it('keeps only a bounded reasoning tail while body and annotation remain separate', () => {
    let state = emptyStageStream()
    state = applyStageStreamEvent(state, event('stage.delta', { delta: '译文正文' }))
    state = applyStageStreamEvent(state, event('stage.annotation', { delta: '译者批注' }))
    state = applyStageStreamEvent(state, event('stage.reasoning', {
      reasoningPreview: '思'.repeat(40_000),
      reasoningCharacters: 40_000,
    }))
    expect(state.body).toBe('译文正文')
    expect(state.annotation).toBe('译者批注')
    expect(state.reasoningPreview).toHaveLength(4_000)
    expect(state.reasoningCharacters).toBe(40_000)
    expect(state.reasoningTruncated).toBe(true)
  })

  it('publishes body chunks at 75ms without leaking faster reasoning updates', () => {
    vi.useFakeTimers()
    const publish = vi.fn()
    const batcher = createStageStreamBatcher(publish)
    batcher.push(event('stage.started'))
    publish.mockClear()
    for (let index = 0; index < 40; index++) {
      batcher.push(event('stage.reasoning', {
        reasoningPreview: '思'.repeat((index + 1) * 1_000),
        reasoningCharacters: (index + 1) * 1_000,
      }))
      batcher.push(event('stage.delta', { delta: '字' }))
    }
    expect(publish).not.toHaveBeenCalled()
    vi.advanceTimersByTime(STAGE_TEXT_FLUSH_MS)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish.mock.lastCall?.[0].assemble.body).toBe('字'.repeat(40))
    expect(publish.mock.lastCall?.[0].assemble.reasoningCharacters).toBe(0)
    vi.advanceTimersByTime(STAGE_REASONING_FLUSH_MS - STAGE_TEXT_FLUSH_MS)
    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish.mock.lastCall?.[0].assemble.reasoningPreview).toHaveLength(4_000)
    expect(publish.mock.lastCall?.[0].assemble.reasoningCharacters).toBe(40_000)
    batcher.dispose()
  })

  it('retry resets discard pending output and terminal events flush the final characters', () => {
    vi.useFakeTimers()
    const publish = vi.fn()
    const batcher = createStageStreamBatcher(publish)
    batcher.push(event('stage.delta', { delta: '旧尝试' }))
    batcher.push(event('stage.reasoning', {
      reasoningPreview: '旧思考',
      reasoningCharacters: 3,
    }))
    batcher.push(event('stage.reset'))
    expect(publish.mock.lastCall?.[0].assemble).toMatchObject({
      body: '', annotation: '', reasoningPreview: '', reasoningCharacters: 0,
      running: true,
    })
    batcher.push(event('stage.delta', { delta: '新译' }))
    batcher.push(event('stage.completed', { body: '新译文', annotation: '最终批注' }))
    expect(publish.mock.lastCall?.[0].assemble).toMatchObject({
      body: '新译文', annotation: '最终批注', running: false,
      reasoningCharacters: 0,
    })
    const callsAtCompletion = publish.mock.calls.length
    vi.runAllTimers()
    expect(publish).toHaveBeenCalledTimes(callsAtCompletion)
    batcher.dispose()
  })

  it('restores count-only diagnostics without inventing a stored reasoning transcript', () => {
    const state = applyStageStreamEvent(emptyStageStream(), event('stage.reasoning.completed', {
      reasoningCharacters: 39_675,
    }))
    expect(state.reasoningPreview).toBe('')
    expect(state.reasoningCharacters).toBe(39_675)
    expect(state.body).toBe('')
  })

  it('cancels pending repaints when the session changes or the panel unmounts', () => {
    vi.useFakeTimers()
    const publish = vi.fn()
    const batcher = createStageStreamBatcher(publish)
    batcher.push(event('stage.delta', { delta: '迟到正文' }))
    batcher.push(event('stage.reasoning', {
      reasoningPreview: '迟到思考',
      reasoningCharacters: 4,
    }))
    batcher.dispose()
    vi.runAllTimers()
    batcher.flush()
    expect(publish).not.toHaveBeenCalled()
  })
})
