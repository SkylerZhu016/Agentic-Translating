import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chatCompletion,
  isAsyncIterable,
  type ChatCompletionEndpoint,
  type ChatCompletionRequest,
} from '../../src/lib/llm/client'
import { jsonObjectResponseFormat } from '../../src/lib/llm/response-format'
import {
  parseSemanticAgentOutput,
  SEMANTIC_JSON_PROTOCOL_MARKER,
} from '../../src/lib/protocol/semantic-output'

const officialUrl = 'https://api.deepseek.com/v1/chat/completions'
const officialEndpoint = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'test-placeholder-key',
}
const jsonRequest: ChatCompletionRequest = {
  model: 'deepseek-flash',
  messages: [
    {
      role: 'system',
      content: `${SEMANTIC_JSON_PROTOCOL_MARKER}\nReturn JSON with body and annotation.`,
    },
    { role: 'user', content: 'Translate the supplied text.' },
  ],
}
const bodyText = JSON.stringify({ body: 'First line\nSecond line', annotation: null })

function response(stream: boolean): Response {
  return stream
    ? new Response([
        `data: ${JSON.stringify({ choices: [{ delta: { content: bodyText }, finish_reason: null }] })}`,
        '',
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
        '',
        'data: [DONE]',
        '',
        '',
      ].join('\n'), { headers: { 'Content-Type': 'text/event-stream' } })
    : new Response(JSON.stringify({
        choices: [{ message: { content: bodyText }, finish_reason: 'stop' }],
      }), { headers: { 'Content-Type': 'application/json' } })
}

async function consume(
  endpoint: ChatCompletionEndpoint,
  request: ChatCompletionRequest,
): Promise<string> {
  const result = await chatCompletion(endpoint, request)
  if (!isAsyncIterable(result)) return result.content
  let content = ''
  for await (const event of result) {
    if (event.type === 'text') content += event.content
  }
  return content
}

afterEach(() => vi.restoreAllMocks())

describe('documented JSON response format capability', () => {
  it.each(['deepseek-flash', 'deepseek-v4-pro'])(
    'enables both documented chat paths for %s',
    (model) => {
      for (const path of ['/chat/completions', '/v1/chat/completions']) {
        expect(jsonObjectResponseFormat(
          `https://api.deepseek.com${path}`,
          { ...jsonRequest, model },
        )).toEqual({ type: 'json_object' })
      }
    },
  )

  it.each([
    'https://compatible.example/v1/chat/completions',
    'http://127.0.0.1:1234/v1/chat/completions',
    'https://api.deepseek.com.example/v1/chat/completions',
    'https://sub.api.deepseek.com/v1/chat/completions',
    'http://api.deepseek.com/v1/chat/completions',
    'https://api.deepseek.com:8443/v1/chat/completions',
    'https://api.deepseek.com/custom/chat/completions',
    'https://api.deepseek.com/v1/chat/completions?route=other',
    'https://api.deepseek.com/v1/chat/completions#other',
    'https://user:password@api.deepseek.com/v1/chat/completions',
    'not a URL',
  ])('leaves unsupported or unverified address %s unchanged', (url) => {
    expect(jsonObjectResponseFormat(url, jsonRequest)).toBeUndefined()
  })

  it.each(['deepseek-chat', 'deepseek-reasoner', 'deepseek-flash-custom', 'other'])(
    'does not infer support for model %s',
    (model) => {
      expect(jsonObjectResponseFormat(
        officialUrl,
        { ...jsonRequest, model },
      )).toBeUndefined()
    },
  )

  it('requires the saved system protocol, rather than source text or a JSON hint', () => {
    for (const messages of [
      [{ role: 'system', content: 'Please return JSON.' }],
      [{ role: 'user', content: SEMANTIC_JSON_PROTOCOL_MARKER }],
      [{ role: 'assistant', content: SEMANTIC_JSON_PROTOCOL_MARKER }],
      [
        { role: 'system', content: 'Translate faithfully.' },
        { role: 'user', content: SEMANTIC_JSON_PROTOCOL_MARKER },
      ],
    ]) {
      expect(jsonObjectResponseFormat(
        officialUrl,
        { ...jsonRequest, messages },
      )).toBeUndefined()
    }
  })

  it('keeps tool requests on their existing protocol', () => {
    const tools: ChatCompletionRequest['tools'] = [{
      type: 'function',
      function: { name: 'inspect', parameters: { type: 'object' } },
    }]
    expect(jsonObjectResponseFormat(
      officialUrl,
      { ...jsonRequest, tools },
    )).toBeUndefined()
    expect(jsonObjectResponseFormat(
      officialUrl,
      { ...jsonRequest, toolChoice: 'none' },
    )).toBeUndefined()
    expect(jsonObjectResponseFormat(
      officialUrl,
      { ...jsonRequest, tools: [] },
    )).toEqual({ type: 'json_object' })
  })
})

describe('physical request JSON format serialization', () => {
  it.each([false, true])('sends JSON mode with stream=%s and preserves escaped lines', async (stream) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(stream))
    const result = await consume(officialEndpoint, { ...jsonRequest, stream })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(officialUrl)
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: jsonRequest.model,
      messages: jsonRequest.messages,
      stream,
      response_format: { type: 'json_object' },
    })
    expect(parseSemanticAgentOutput(result, { format: 'json' }).body)
      .toBe('First line\nSecond line')
  })

  it.each([false, true])('keeps unknown compatible requests unchanged with stream=%s', async (stream) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(stream))
    await consume({
      ...officialEndpoint,
      baseUrl: 'https://compatible.example',
    }, { ...jsonRequest, stream })
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)))
      .not.toHaveProperty('response_format')
  })

  it.each([false, true])('omits JSON mode for ordinary and tool requests with stream=%s', async (stream) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(async () => response(stream))
    await consume(officialEndpoint, {
      ...jsonRequest,
      messages: [{ role: 'system', content: 'Translate naturally.' }],
      stream,
    })
    await consume(officialEndpoint, {
      ...jsonRequest,
      tools: [{
        type: 'function',
        function: { name: 'inspect', parameters: { type: 'object' } },
      }],
      stream,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.parse(String(init?.body))).not.toHaveProperty('response_format')
    }
  })

  it.each([false, true])('uses one current endpoint read with stream=%s', async (stream) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(async () => response(stream))
    let currentBaseUrl = 'https://compatible.example'
    const resolveRuntimeEndpoint = vi.fn(() => ({
      ...officialEndpoint,
      baseUrl: currentBaseUrl,
    }))
    const endpoint = { ...officialEndpoint, resolveRuntimeEndpoint }

    await consume(endpoint, { ...jsonRequest, stream })
    currentBaseUrl = officialEndpoint.baseUrl
    await consume(endpoint, { ...jsonRequest, stream })

    expect(resolveRuntimeEndpoint).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://compatible.example/v1/chat/completions',
      officialUrl,
    ])
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)))
      .not.toHaveProperty('response_format')
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).response_format)
      .toEqual({ type: 'json_object' })
  })

  it.each([false, true])('rechecks capability during compatibility retry, initial support=%s', async (initialSupport) => {
    const endpoints = initialSupport
      ? [officialEndpoint.baseUrl, 'https://compatible.example']
      : ['https://compatible.example', officialEndpoint.baseUrl]
    let reads = 0
    const resolveRuntimeEndpoint = vi.fn(() => ({
      ...officialEndpoint,
      baseUrl: endpoints[reads++],
    }))
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'stream_options is not supported' },
      }), { status: 400, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(response(true))

    await consume({
      ...officialEndpoint,
      resolveRuntimeEndpoint,
    }, { ...jsonRequest, stream: true })

    expect(resolveRuntimeEndpoint).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const sent = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
    expect(sent[0]).toHaveProperty('stream_options.include_usage', true)
    expect(sent[1]).not.toHaveProperty('stream_options')
    expect(sent.map((body) => body.response_format)).toEqual(initialSupport
      ? [{ type: 'json_object' }, undefined]
      : [undefined, { type: 'json_object' }])
  })

  it('keeps strict JSON and schema validation after transport support is enabled', () => {
    expect(() => parseSemanticAgentOutput(
      '{"body":"First line\nSecond line","annotation":null}',
      { format: 'json' },
    )).toThrow('one complete JSON object')
    expect(() => parseSemanticAgentOutput(
      '{"body":"Text","annotation":null,"extra":true}',
      { format: 'json' },
    )).toThrow('exactly body')
  })
})
