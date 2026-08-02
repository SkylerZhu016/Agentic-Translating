import { describe, expect, it } from 'vitest'
import {
  resolveChatCompletionsUrl,
  resolveModelsUrl,
  splitEndpointAddress,
} from '../../src/lib/llm/endpoint-url'

describe('endpoint address', () => {
  it('never duplicates /v1 when a full OpenAI URL is pasted', () => {
    const split = splitEndpointAddress(
      'https://example.test/v1/chat/completions',
    )
    expect(split).toEqual({
      baseUrl: 'https://example.test',
      chatCompletionsPath: '/v1/chat/completions',
    })
    expect(resolveChatCompletionsUrl(split)).toBe(
      'https://example.test/v1/chat/completions',
    )
  })

  it('preserves provider-specific compatible paths', () => {
    expect(
      splitEndpointAddress(
        'https://openrouter.ai/api/v1/chat/completions',
      ),
    ).toEqual({
      baseUrl: 'https://openrouter.ai',
      chatCompletionsPath: '/api/v1/chat/completions',
    })
    expect(
      splitEndpointAddress(
        'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      ),
    ).toEqual({
      baseUrl: 'https://generativelanguage.googleapis.com',
      chatCompletionsPath: '/v1beta/openai/chat/completions',
    })
  })

  it('derives the model catalogue from the configured compatible path', () => {
    expect(
      resolveModelsUrl({
        baseUrl: 'https://example.test',
        chatCompletionsPath: '/v1/chat/completions',
      }),
    ).toBe('https://example.test/v1/models')
    expect(
      resolveModelsUrl({
        baseUrl: 'https://openrouter.ai',
        chatCompletionsPath: '/api/v1/chat/completions',
      }),
    ).toBe('https://openrouter.ai/api/v1/models')
    expect(
      resolveModelsUrl({
        baseUrl: 'https://generativelanguage.googleapis.com',
        chatCompletionsPath: '/v1beta/openai/chat/completions',
      }),
    ).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/models',
    )
  })
})
