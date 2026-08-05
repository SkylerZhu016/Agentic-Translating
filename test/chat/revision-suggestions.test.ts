import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/lib/llm/client', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../src/lib/llm/client')>()
  return {
    ...original,
    chatCompletion: vi.fn(),
  }
})

import { chatCompletion } from '../../src/lib/llm/client'
import { generateRevisionSuggestion } from '../../src/lib/chat/revision-suggestions'

describe('revision suggestion lenses', () => {
  beforeEach(() => {
    vi.mocked(chatCompletion).mockReset()
  })

  it('keeps the target-language reader blind to the source and isolates annotations', async () => {
    const streamOf = (content: string) =>
      (async function* () {
        yield { type: 'text' as const, content }
        yield { type: 'done' as const, content }
      })()
    vi.mocked(chatCompletion).mockImplementation(async (_endpoint, request) => {
      const system = request.messages[0]?.content ?? ''
      if (system.includes('把两份隔离意见整理成')) {
        return streamOf(
          '这两处读着有点绕：“凌晨那些小小的钟点开始变大”和“劳苦的头脑”。请改得自然一些，同时保留原文疲惫不安的感觉。\n---\n内部仲裁注释',
        )
      }
      if (system.includes('独立的中文成品读者')) {
        return streamOf(
          '“凌晨那些小小的钟点开始变大”读起来生硬。\n---\n内部读者注释',
        )
      }
      if (system.includes('双语核验者')) {
        return streamOf(
          '“劳苦的头脑”搭配不自然，需要保留 mind 的劳顿感。\n---\n内部核验注释',
        )
      }
      throw new Error(`unexpected prompt: ${system}`)
    })

    const result = await generateRevisionSuggestion({
      endpoint: {
        baseUrl: 'https://example.invalid',
        chatCompletionsPath: '/v1/chat/completions',
        apiKey: 'test-key',
      },
      model: 'DeepSeek V4 Flash: Go',
      promptLanguage: 'zh',
      sourceText: 'The little hours of the morning began to grow large.',
      taskBrief: '保持叙事语气。',
      currentTranslation: '凌晨那些小小的钟点开始变大。劳苦的头脑没有安宁。',
      userRequest: '读起来有点拗口，只改最明显的地方。',
    })

    expect(result).toEqual({
      targetReaderReport: '“凌晨那些小小的钟点开始变大”读起来生硬。',
      bilingualReport: '“劳苦的头脑”搭配不自然，需要保留 mind 的劳顿感。',
      feedback:
        '这两处读着有点绕：“凌晨那些小小的钟点开始变大”和“劳苦的头脑”。请改得自然一些，同时保留原文疲惫不安的感觉。',
    })

    expect(chatCompletion).toHaveBeenCalledTimes(3)
    const calls = vi.mocked(chatCompletion).mock.calls
    const targetReaderCall = calls.find(([, request]) =>
      request.messages[0]?.content.includes('独立的中文成品读者'),
    )
    const bilingualCall = calls.find(([, request]) =>
      request.messages[0]?.content.includes('双语核验者'),
    )
    const arbiterCall = calls.find(([, request]) =>
      request.messages[0]?.content.includes('把两份隔离意见整理成'),
    )

    expect(targetReaderCall?.[1].messages[1].content).not.toContain(
      'The little hours of the morning began to grow large.',
    )
    expect(bilingualCall?.[1].messages[1].content).toContain(
      'The little hours of the morning began to grow large.',
    )
    expect(arbiterCall?.[1].messages[1].content).toContain(
      '“凌晨那些小小的钟点开始变大”读起来生硬。',
    )
    expect(arbiterCall?.[1].messages[1].content).toContain(
      '“劳苦的头脑”搭配不自然',
    )
    expect(
      calls.every(([, request]) =>
        request.model === 'DeepSeek V4 Flash: Go' &&
        request.stream === true &&
        request.maxTokens === 65_536,
      ),
    ).toBe(true)
  })

  it('uses English lenses for Chinese-to-English sessions', async () => {
    vi.mocked(chatCompletion).mockImplementation(async (_endpoint, request) => {
      const system = request.messages[0]?.content ?? ''
      if (system.includes('Turn the two independent reports')) {
        return { content: 'The final line feels too abstract; make the loneliness feel more aimless without rewriting the poem.' }
      }
      if (system.includes('independent reader of finished English')) {
        return { content: 'The final clause feels abstract.' }
      }
      if (system.includes('bilingual verifier')) {
        return { content: 'The final clause weakens the source sense of 漫.' }
      }
      throw new Error(`unexpected prompt: ${system}`)
    })

    const result = await generateRevisionSuggestion({
      endpoint: { baseUrl: 'https://example.invalid', apiKey: 'test-key' },
      model: 'DeepSeek V4 Flash: Go',
      promptLanguage: 'en',
      sourceText: '人事音书漫寂寥。',
      taskBrief: 'Preserve the poem\'s tone.',
      currentTranslation: 'My affairs and letters are left to loneliness.',
      userRequest: 'The ending still feels a little flat.',
    })

    expect(result.feedback).toContain('too abstract')
    expect(chatCompletion).toHaveBeenCalledTimes(3)
    expect(
      vi.mocked(chatCompletion).mock.calls[0][1].messages[0].content,
    ).toContain('finished English')
  })

  it('v16 prompts protect deliberate strangeness and require verbatim prohibitions', async () => {
    const streamOf = (content: string) =>
      (async function* () {
        yield { type: 'text' as const, content }
        yield { type: 'done' as const, content }
      })()
    vi.mocked(chatCompletion).mockImplementation(async (_endpoint, request) => {
      const system = request.messages[0]?.content ?? ''
      if (system.includes('把两份隔离意见整理成')) return streamOf('这一轮先不要修改')
      if (system.includes('独立的中文成品读者')) return streamOf('停止')
      if (system.includes('双语核验者')) return streamOf('停止')
      throw new Error(`unexpected prompt: ${system}`)
    })
    await generateRevisionSuggestion({
      endpoint: { baseUrl: 'https://example.invalid', apiKey: 'test-key' },
      model: 'DeepSeek V4 Flash: Go',
      promptLanguage: 'zh',
      sourceText: 'The small hours began to grow large.',
      taskBrief: '保持叙事语气。',
      currentTranslation: '凌晨那些小小的钟点开始变大。',
      userRequest: '读起来有点拗口。',
    })
    const zhCalls = vi.mocked(chatCompletion).mock.calls
    const zhReader = zhCalls.find(([, r]) =>
      r.messages[0]?.content.includes('独立的中文成品读者'),
    )?.[1].messages[0].content ?? ''
    const zhBilingual = zhCalls.find(([, r]) =>
      r.messages[0]?.content.includes('双语核验者'),
    )?.[1].messages[0].content ?? ''
    const zhArbiter = zhCalls.find(([, r]) =>
      r.messages[0]?.content.includes('把两份隔离意见整理成'),
    )?.[1].messages[0].content ?? ''
    expect(zhReader).toContain('陌生化手法')
    expect(zhReader).toContain('待核验')
    expect(zhReader).toContain('疑似刻意表达')
    expect(zhBilingual).toContain('禁止事项')
    expect(zhBilingual).toContain('主语—谓语—宾语骨架')
    expect(zhArbiter).toContain('禁止事项')
    expect(zhArbiter).toContain('逐字保留')
    expect(zhArbiter).toContain('这一轮先不要修改')

    vi.mocked(chatCompletion).mockReset()
    vi.mocked(chatCompletion).mockImplementation(async (_endpoint, request) => {
      const system = request.messages[0]?.content ?? ''
      if (system.includes('Turn the two independent reports')) {
        return { content: 'Do not change this version in this round.' }
      }
      if (system.includes('independent reader of finished English')) {
        return { content: 'stop' }
      }
      if (system.includes('bilingual verifier')) return { content: 'stop' }
      throw new Error(`unexpected prompt: ${system}`)
    })
    await generateRevisionSuggestion({
      endpoint: { baseUrl: 'https://example.invalid', apiKey: 'test-key' },
      model: 'DeepSeek V4 Flash: Go',
      promptLanguage: 'en',
      sourceText: '人事音书漫寂寥。',
      taskBrief: 'Preserve the poem\'s tone.',
      currentTranslation: 'My affairs are left to loneliness.',
      userRequest: 'The ending feels flat.',
    })
    const enCalls = vi.mocked(chatCompletion).mock.calls
    const enReader = enCalls.find(([, r]) =>
      r.messages[0]?.content.includes('independent reader of finished English'),
    )?.[1].messages[0].content ?? ''
    const enBilingual = enCalls.find(([, r]) =>
      r.messages[0]?.content.includes('bilingual verifier'),
    )?.[1].messages[0].content ?? ''
    const enArbiter = enCalls.find(([, r]) =>
      r.messages[0]?.content.includes('Turn the two independent reports'),
    )?.[1].messages[0].content ?? ''
    expect(enReader).toContain('unusual but flavorful')
    expect(enReader).toContain('needs-verification')
    expect(enBilingual).toContain('prohibitions')
    expect(enBilingual).toContain('negative form')
    expect(enBilingual).toContain('subject-verb-object skeleton')
    expect(enArbiter).toContain('prohibitions')
    expect(enArbiter).toContain('verbatim')
    expect(enArbiter).toContain('do not')
  })
})
