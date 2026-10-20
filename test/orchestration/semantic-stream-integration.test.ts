import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  runFanOut,
  type AgentRuntime,
  type FanOutCallbacks,
  type LLMCaller,
} from '../../src/lib/orchestration/fanout'
import type { LLMStreamEvent } from '../../src/lib/llm/client'
import type { ReasoningPreview } from '../../src/lib/llm/reasoning-preview'
import {
  parseSemanticAgentOutput,
  semanticOutputFormatForPrompt,
} from '../../src/lib/protocol/semantic-output'

function agent(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    agentKey: 'translator',
    name: 'Translator',
    endpoint: { baseUrl: 'http://unused.invalid/v1', apiKey: 'mock-key' },
    model: 'mock-translator',
    messages: [{ role: 'user', content: 'Translate the passage.' }],
    outputFormat: 'json',
    ...overrides,
  }
}

async function* textStream(chunks: readonly string[]): AsyncIterable<LLMStreamEvent> {
  for (const content of chunks) yield { type: 'text', content }
  yield { type: 'done', content: chunks.join('') }
}

afterEach(() => vi.useRealTimers())

describe('semantic output through fan-out callbacks', () => {
  it('streams decoded body and annotation independently before the JSON object finishes', async () => {
    const body: string[] = []
    const annotation: string[] = []
    const chunks = [
      '{"body":"河岸',
      '上的灯。\\n第二行。","annotation":"保留',
      '原文意象。"}',
    ]
    const caller: LLMCaller = async () => (async function* (): AsyncIterable<LLMStreamEvent> {
      yield { type: 'text', content: chunks[0] }
      expect(body.join('')).toBe('河岸')
      expect(annotation).toEqual([])
      yield { type: 'text', content: chunks[1] }
      expect(body.join('')).toBe('河岸上的灯。\n第二行。')
      expect(annotation.join('')).toBe('保留')
      yield { type: 'text', content: chunks[2] }
      yield { type: 'done', content: chunks.join('') }
    })()

    const summary = await runFanOut([agent()], {
      onToken: (_key, text) => body.push(text),
      onAnnotation: (_key, text) => annotation.push(text),
    }, caller, { retryDelaysMs: [] })

    expect(summary).toMatchObject({ succeeded: 1, failed: 0 })
    expect(summary.results[0]).toMatchObject({
      status: 'complete',
      content: chunks.join(''),
    })
    expect(body.join('')).toBe('河岸上的灯。\n第二行。')
    expect(annotation.join('')).toBe('保留原文意象。')
    expect(body.join('')).not.toContain('annotation')
    expect(annotation.join('')).not.toContain('body')
  })

  it('keeps the same semantic callbacks when the provider falls back to a complete response', async () => {
    const raw = '{"annotation":"译者说明","body":"完成的译文"}'
    const onToken = vi.fn()
    const onAnnotation = vi.fn()
    const summary = await runFanOut(
      [agent()],
      { onToken, onAnnotation },
      async () => ({ content: raw }),
      { retryDelaysMs: [] },
    )

    expect(summary.succeeded).toBe(1)
    expect(onToken).toHaveBeenCalledExactlyOnceWith('translator', '完成的译文')
    expect(onAnnotation).toHaveBeenCalledExactlyOnceWith('translator', '译者说明')
  })

  it('bounds invalid JSON retries and resets each invalid preview once', async () => {
    const attempts: number[] = []
    const invalidated: string[] = []
    const onComplete = vi.fn()
    const onError = vi.fn()
    const caller = vi.fn<LLMCaller>(async () => textStream([
      '{"body":"暂存译文","annotation":"暂存说明"',
      ',"body":"重复字段"}',
      ' trailing text',
      ' more trailing text',
    ]))
    let visibleBody = ''
    let visibleAnnotation = ''
    const summary = await runFanOut([agent()], {
      onAgentAttemptStart: (_key, attempt) => {
        attempts.push(attempt)
        visibleBody = ''
        visibleAnnotation = ''
      },
      onToken: (_key, text) => { visibleBody += text },
      onAnnotation: (_key, text) => { visibleAnnotation += text },
      onAgentOutputInvalid: (key) => {
        invalidated.push(key)
        visibleBody = ''
        visibleAnnotation = ''
      },
      onAgentComplete: onComplete,
      onAgentError: onError,
    }, caller, { retryDelaysMs: [0, 0] })

    expect(caller).toHaveBeenCalledTimes(3)
    expect(attempts).toEqual([0, 1, 2])
    expect(invalidated).toEqual(['translator', 'translator', 'translator'])
    expect(summary).toMatchObject({ succeeded: 0, failed: 1 })
    expect(summary.results[0]).toMatchObject({ status: 'error' })
    expect(onComplete).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(visibleBody).toBe('')
    expect(visibleAnnotation).toBe('')
  })

  it('clears an unfinished but otherwise valid JSON prefix when final validation fails', async () => {
    const onInvalid = vi.fn()
    const onComplete = vi.fn()
    let visibleBody = ''
    const caller: LLMCaller = async () => textStream(['{"body":"尚未闭合的译文'])
    const summary = await runFanOut([agent()], {
      onToken: (_key, text) => { visibleBody += text },
      onAgentOutputInvalid: (key) => {
        onInvalid(key)
        visibleBody = ''
      },
      onAgentComplete: onComplete,
    }, caller, { retryDelaysMs: [] })

    expect(summary).toMatchObject({ succeeded: 0, failed: 1 })
    expect(summary.results[0].status).toBe('error')
    expect(onInvalid).toHaveBeenCalledExactlyOnceWith('translator')
    expect(onComplete).not.toHaveBeenCalled()
    expect(visibleBody).toBe('')
  })

  it('starts a successful retry with fresh body and annotation previews', async () => {
    let attempt = 0
    let visibleBody = ''
    let visibleAnnotation = ''
    const callbacks: FanOutCallbacks = {
      onAgentAttemptStart: () => {
        visibleBody = ''
        visibleAnnotation = ''
      },
      onToken: (_key, text) => { visibleBody += text },
      onAnnotation: (_key, text) => { visibleAnnotation += text },
      onAgentOutputInvalid: () => {
        visibleBody = ''
        visibleAnnotation = ''
      },
    }
    const caller: LLMCaller = async () => textStream(attempt++ === 0
      ? ['{"body":"第一次的残片","annotation":"失效说明"}', 'invalid suffix']
      : ['{"body":"第二次的译文",', '"annotation":"有效说明"}'])
    const summary = await runFanOut([agent()], callbacks, caller, {
      retryDelaysMs: [0],
    })

    expect(attempt).toBe(2)
    expect(summary).toMatchObject({ succeeded: 1, failed: 0 })
    expect(visibleBody).toBe('第二次的译文')
    expect(visibleAnnotation).toBe('有效说明')
    expect(summary.results[0].content).not.toContain('第一次')
  })

  it('routes 40,000 provider reasoning characters to bounded previews without mixing them into output', async () => {
    vi.useFakeTimers()
    const previews: ReasoningPreview[] = []
    const body: string[] = []
    const annotation: string[] = []
    const chunks = Array.from({ length: 40 }, (_, index) =>
      `${String(index).padStart(2, '0')}:${'思'.repeat(997)}`)
    const raw = '{"body":"最终译文","annotation":"公开说明"}'
    const caller: LLMCaller = async (_endpoint, request) => (async function* (): AsyncIterable<LLMStreamEvent> {
      expect(request.onReasoning).toBeTypeOf('function')
      for (let index = 0; index < chunks.length; index += 1) {
        request.onReasoning?.({
          source: 'reasoning_content',
          delta: chunks[index],
          characters: (index + 1) * 1_000,
          chunks: index + 1,
          truncated: false,
        })
        if ((index + 1) % 10 === 0) {
          await vi.advanceTimersByTimeAsync(200)
        }
      }
      yield { type: 'text', content: raw }
      yield { type: 'done', content: raw }
    })()
    const summary = await runFanOut([agent()], {
      onAgentReasoning: (_key, preview) => previews.push(preview),
      onToken: (_key, text) => body.push(text),
      onAnnotation: (_key, text) => annotation.push(text),
    }, caller, { retryDelaysMs: [] })

    expect(previews.length).toBeGreaterThan(1)
    for (const preview of previews) {
      expect(preview.reasoningPreview.length).toBeLessThanOrEqual(4_000)
      expect(preview.reasoningTruncated).toBe(true)
    }
    expect(previews.at(-1)).toEqual({
      reasoningPreview: chunks.slice(-4).join(''),
      reasoningCharacters: 40_000,
      reasoningTruncated: true,
    })
    expect(summary.results[0]).toMatchObject({
      status: 'complete',
      content: raw,
      reasoningCharacters: 40_000,
    })
    expect(body.join('')).toBe('最终译文')
    expect(annotation.join('')).toBe('公开说明')
    expect(JSON.stringify(summary)).not.toContain('思思')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves old unmarked prompts and their legacy output convention', async () => {
    const prompt = 'Translate the passage, then put optional notes after a standalone --- line.'
    const outputFormat = semanticOutputFormatForPrompt(prompt)
    const raw = '旧版译文。\n---\n旧版说明。'
    const visible: string[] = []
    const summary = await runFanOut([agent({
      messages: [{ role: 'system', content: prompt }],
      outputFormat,
    })], {
      onToken: (_key, text) => visible.push(text),
    }, async () => textStream(['旧版译文。\n', '---\n旧版说明。']), {
      retryDelaysMs: [],
    })

    expect(outputFormat).toBe('legacy')
    expect(summary).toMatchObject({ succeeded: 1, failed: 0 })
    expect(summary.results[0].content).toBe(raw)
    expect(visible.join('')).toBe(raw)
    expect(parseSemanticAgentOutput(summary.results[0].content!)).toEqual({
      raw,
      body: '旧版译文。',
      annotation: '旧版说明。',
    })
  })
})
