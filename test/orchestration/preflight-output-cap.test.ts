import { describe, expect, it, vi } from 'vitest'
import { chatCompletion } from '../../src/lib/llm/client'
import { runFanOut } from '../../src/lib/orchestration/fanout'
import { complete } from '../../src/lib/orchestration/vnext-runner'

vi.mock('../../src/lib/llm/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm/client')>()
  return {
    ...actual,
    chatCompletion: vi.fn(),
  }
})

describe('physical output ceilings frozen by preflight', () => {
  it('passes the resolved vNext binding ceiling to the provider request', async () => {
    vi.mocked(chatCompletion).mockResolvedValueOnce({ content: 'done' })

    await complete(
      {
        id: 1,
        name: 'fixture',
        baseUrl: 'https://example.invalid',
        chatCompletionsPath: '/v1/chat/completions',
        apiKey: 'fixture-secret',
        contextWindow: 32_768,
        maxOutputTokens: 2_048,
      },
      {
        model: 'fixture-model',
        messages: [{ role: 'user', content: 'Source' }],
        stream: false,
      },
    )

    expect(vi.mocked(chatCompletion).mock.calls[0][1].maxTokens).toBe(2_048)
  })

  it('passes each worker runtime ceiling through fanout unchanged', async () => {
    const caller = vi.fn().mockResolvedValue({ content: 'translated' })

    const result = await runFanOut(
      [
        {
          agentKey: 'worker-1',
          name: 'Worker 1',
          endpoint: {
            baseUrl: 'https://example.invalid',
            apiKey: 'fixture-secret',
          },
          model: 'fixture-model',
          messages: [{ role: 'user', content: 'Source' }],
          maxTokens: 1_536,
        },
      ],
      {},
      caller,
      { retryDelaysMs: [] },
    )

    expect(result.succeeded).toBe(1)
    expect(caller.mock.calls[0][1].maxTokens).toBe(1_536)
  })
})
