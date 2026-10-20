import { afterEach, describe, expect, it, vi } from 'vitest'
import { runStageStream } from '@/src/components/coordinator/run-stage'
import { encodeSSE } from '@/src/lib/contracts/sse'

afterEach(() => vi.unstubAllGlobals())

describe('manual stage SSE client', () => {
  it('handles split UTF-8 frames and keeps body, annotation and bounded reasoning separate', async () => {
    const payload = [
      encodeSSE('stage_start', { stage: 'assemble' }),
      encodeSSE('stage_reasoning', {
        stage: 'assemble', reasoningPreview: '思'.repeat(40_000),
        reasoningCharacters: 40_000, reasoningTruncated: true,
      }),
      encodeSSE('stage_delta', { stage: 'assemble', content: '第一行\n第二行' }),
      encodeSSE('stage_annotation', { stage: 'assemble', content: '说明：保留语气。' }),
      encodeSSE('stage_complete', { stage: 'assemble', raw_text: '{"body":"最终正文"}' }),
      encodeSSE('done', {}),
    ].join('')
    const bytes = new TextEncoder().encode(payload)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < bytes.length; index += 137) {
          controller.enqueue(bytes.slice(index, index + 137))
        }
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream)))
    const onDelta = vi.fn()
    const onAnnotation = vi.fn()
    const onReasoning = vi.fn()
    const onComplete = vi.fn()
    const onError = vi.fn()
    await runStageStream('session-1', 'assemble', {
      onDelta, onAnnotation, onReasoning, onComplete, onError,
    })
    expect(onDelta.mock.calls).toEqual([['assemble', '第一行\n第二行']])
    expect(onAnnotation.mock.calls).toEqual([['assemble', '说明：保留语气。']])
    expect(onReasoning.mock.calls[0][1].reasoningPreview).toHaveLength(4_000)
    expect(onReasoning.mock.calls[0][1].reasoningCharacters).toBe(40_000)
    expect(onComplete).toHaveBeenCalledWith('assemble', '{"body":"最终正文"}')
    expect(onError).not.toHaveBeenCalled()
  })

  it('does not report interruption when cancelled before or during reading', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetch = vi.fn()
    const onError = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await runStageStream('session-1', 'assemble', {
      signal: controller.signal, onError,
    })
    expect(fetch).not.toHaveBeenCalled()
    const activeController = new AbortController()
    fetch.mockResolvedValue(new Response(encodeSSE('stage_delta', {
      stage: 'assemble', content: '已收到的正文',
    })))
    await runStageStream('session-1', 'assemble', {
      signal: activeController.signal,
      onDelta: () => activeController.abort(),
      onError,
    })
    expect(onError).not.toHaveBeenCalled()
  })

  it('reports clean EOF after complete delta frames when no terminal event arrived', async () => {
    const payload = [
      encodeSSE('stage_start', { stage: 'assemble' }),
      encodeSSE('stage_delta', { stage: 'assemble', content: '尚未完成的正文' }),
    ].join('')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(payload)))
    const onDelta = vi.fn()
    const onComplete = vi.fn()
    const onError = vi.fn()
    await runStageStream('session-1', 'assemble', { onDelta, onComplete, onError })
    expect(onDelta).toHaveBeenCalledWith('assemble', '尚未完成的正文')
    expect(onComplete).not.toHaveBeenCalled()
    expect(onError.mock.calls).toEqual([['assemble', '连接中断']])
  })

  it('reports an incomplete trailing frame even after a complete stage result', async () => {
    const payload = [
      encodeSSE('stage_complete', { stage: 'assemble', raw_text: '完整正文' }),
      'event: done\ndata: {',
    ].join('')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(payload)))
    const onComplete = vi.fn()
    const onError = vi.fn()
    await runStageStream('session-1', 'assemble', { onComplete, onError })
    expect(onComplete).toHaveBeenCalledWith('assemble', '完整正文')
    expect(onError.mock.calls).toEqual([['assemble', '连接中断']])
  })
})
