import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  LLMStreamEvent,
} from '../../src/lib/llm/client'
import { createReasoningPreview, type ReasoningPreview } from '../../src/lib/llm/reasoning-preview'

vi.mock('../../src/lib/services/llm-call-ledger', () => ({
  ledgeredChatCompletion: vi.fn(),
}))

import { ledgeredChatCompletion } from '../../src/lib/services/llm-call-ledger'
import { runChatTurn } from '../../src/lib/chat/tool-loop'

const endpoint = { baseUrl: 'https://unused.example.invalid', apiKey: 'test-key' }
const messages = [{ role: 'user', content: 'Please revise the translation.' }]

function reasoningStream(
  request: ChatCompletionRequest,
  fragments: string[],
  response: ChatCompletionResponse,
): AsyncIterable<LLMStreamEvent> {
  return (async function* () {
    let characters = 0
    for (const [index, fragment] of fragments.entries()) {
      characters += fragment.length
      request.onReasoning?.({
        source: 'reasoning_content',
        delta: fragment.slice(-1024),
        characters,
        chunks: index + 1,
        truncated: fragment.length > 1024,
      })
    }
    if (response.content) yield { type: 'text', content: response.content }
    yield { type: 'done', ...response }
  })()
}

describe('chat provider reasoning previews', () => {
  beforeEach(() => {
    vi.mocked(ledgeredChatCompletion).mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('drops an older tail when the transport skips a large fragment and resumes only the known suffix', () => {
    const previews: ReasoningPreview[] = []
    const accumulator = createReasoningPreview((preview) => previews.push(preview))
    for (let index = 1; index <= 4; index += 1) {
      accumulator.push({
        source: 'reasoning_content', delta: 'A'.repeat(1_000),
        characters: index * 1_000, chunks: index, truncated: false,
      })
    }
    accumulator.flush()
    expect(previews.at(-1)?.reasoningPreview).toBe('A'.repeat(4_000))
    accumulator.push({
      source: 'reasoning_content', delta: 'B'.repeat(1_024),
      characters: 44_000, chunks: 5, truncated: true,
    })
    accumulator.flush()
    expect(previews.at(-1)).toEqual({
      reasoningPreview: 'B'.repeat(1_024),
      reasoningCharacters: 44_000,
      reasoningTruncated: true,
    })
    accumulator.push({
      source: 'reasoning_content', delta: 'CC',
      characters: 44_002, chunks: 6, truncated: true,
    })
    accumulator.dispose()
    expect(previews.at(-1)?.reasoningPreview).toBe('B'.repeat(1_024) + 'CC')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('caps long streaming reasoning and keeps it out of assistant body and caller messages', async () => {
    const previews: ReasoningPreview[] = []
    const body: string[] = []
    const originalMessages = structuredClone(messages)
    vi.mocked(ledgeredChatCompletion).mockImplementation(async (_endpoint, request) => (
      reasoningStream(
        request,
        Array.from({ length: 50 }, () => 'PRIVATE_REASONING_'.repeat(60)),
        { content: 'The revised translation.' },
      )
    ))

    const result = await runChatTurn({
      endpoint,
      model: 'test-model',
      messages: originalMessages,
      currentText: 'Original translation.',
      callbacks: {
        onReasoning: (preview) => previews.push(preview),
        onDelta: (text) => body.push(text),
      },
    })

    expect(result).toEqual({ ok: true, kind: 'message', text: 'The revised translation.' })
    expect(body.join('')).toBe('The revised translation.')
    expect(originalMessages).toEqual(messages)
    expect(previews).toHaveLength(1)
    expect(previews[0]).toMatchObject({
      reasoningCharacters: 54_000,
      reasoningTruncated: true,
    })
    // Every 1,080-character fragment is sliced to its final 1,024 characters
    // by the transport. The gap means only that last suffix is continuous.
    expect(previews[0].reasoningPreview).toBe('PRIVATE_REASONING_'.repeat(60).slice(-1_024))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps counters cumulative across edit correction calls without adding reasoning to the next request', async () => {
    const previews: ReasoningPreview[] = []
    const requestMessages: string[] = []
    let round = 0
    vi.mocked(ledgeredChatCompletion).mockImplementation(async (_endpoint, request) => {
      requestMessages.push(JSON.stringify(request.messages))
      round += 1
      const first = round === 1
      return reasoningStream(
        request,
        [first ? 'FIRST_PRIVATE_REASONING'.repeat(250) : 'SECOND_PRIVATE_REASONING'.repeat(100)],
        {
          content: '',
          toolCalls: [{
            id: `edit-${round}`,
            name: 'replace_text',
            arguments: JSON.stringify({
              old_string: first ? 'not present' : 'original',
              new_string: 'revised',
            }),
          }],
        },
      )
    })

    const result = await runChatTurn({
      endpoint,
      model: 'test-model',
      messages,
      currentText: 'original translation',
      callbacks: { onReasoning: (preview) => previews.push(preview) },
    })

    expect(result).toMatchObject({ ok: true, kind: 'edited', newText: 'revised translation' })
    expect(previews.map((preview) => preview.reasoningCharacters)).toEqual([
      'FIRST_PRIVATE_REASONING'.length * 250,
      'FIRST_PRIVATE_REASONING'.length * 250 + 'SECOND_PRIVATE_REASONING'.length * 100,
    ])
    expect(previews.at(-1)?.reasoningTruncated).toBe(true)
    expect(requestMessages).toHaveLength(2)
    expect(requestMessages.join('')).not.toContain('PRIVATE_REASONING')
    expect(previews.at(-1)?.reasoningPreview).not.toContain('FIRST_PRIVATE_REASONING')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('flushes the last bounded preview and clears its timer when the provider fails', async () => {
    const previews: ReasoningPreview[] = []
    vi.mocked(ledgeredChatCompletion).mockImplementation(async (_endpoint, request) => (
      (async function* (): AsyncIterable<LLMStreamEvent> {
        request.onReasoning?.({
          source: 'thinking',
          delta: 'partial reasoning',
          characters: 17,
          chunks: 1,
          truncated: false,
        })
        throw new Error('provider disconnected')
      })()
    ))

    await expect(runChatTurn({
      endpoint,
      model: 'test-model',
      messages,
      currentText: 'Original.',
      callbacks: { onReasoning: (preview) => previews.push(preview) },
    })).rejects.toThrow('provider disconnected')

    expect(previews).toEqual([{
      reasoningPreview: 'partial reasoning',
      reasoningCharacters: 17,
      reasoningTruncated: false,
    }])
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['timer', 'dispose'] as const)(
    'preserves the successful provider result and clears timers when the %s observer throws',
    async (flushPath) => {
      let markReasoningReady!: () => void
      let releaseProvider!: () => void
      const reasoningReady = new Promise<void>((resolve) => {
        markReasoningReady = resolve
      })
      const providerReleased = new Promise<void>((resolve) => {
        releaseProvider = resolve
      })
      const onReasoning = vi.fn(() => {
        throw new Error('preview observer failed')
      })
      const body: string[] = []
      vi.mocked(ledgeredChatCompletion).mockImplementation(async (_endpoint, request) => (
        (async function* (): AsyncIterable<LLMStreamEvent> {
          request.onReasoning?.({
            source: 'reasoning_content',
            delta: 'temporary reasoning',
            characters: 19,
            chunks: 1,
            truncated: false,
          })
          markReasoningReady()
          // Keep the provider pending so the timer path fires independently
          // from runChatTurn's final dispose flush.
          await providerReleased
          yield { type: 'text', content: 'Successful answer.' }
          yield { type: 'done', content: 'Successful answer.' }
        })()
      ))

      const turn = runChatTurn({
        endpoint,
        model: 'test-model',
        messages,
        currentText: 'Original.',
        callbacks: {
          onReasoning,
          onDelta: (text) => body.push(text),
        },
      })

      await reasoningReady
      expect(onReasoning).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(1)
      try {
        if (flushPath === 'timer') {
          await vi.advanceTimersByTimeAsync(200)
          expect(onReasoning).toHaveBeenCalledTimes(1)
          expect(body).toEqual([])
          expect(vi.getTimerCount()).toBe(0)
        }
      } finally {
        releaseProvider()
      }

      await expect(turn).resolves.toEqual({
        ok: true,
        kind: 'message',
        text: 'Successful answer.',
      })
      expect(body).toEqual(['Successful answer.'])
      expect(onReasoning).toHaveBeenCalledTimes(1)
      expect(onReasoning).toHaveBeenCalledWith({
        reasoningPreview: 'temporary reasoning',
        reasoningCharacters: 19,
        reasoningTruncated: false,
      })
      expect(vi.getTimerCount()).toBe(0)
    },
  )
})
