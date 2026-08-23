import { describe, expect, it, vi } from 'vitest'
import {
  ALLOWED_PROVIDER_MODELS,
  buildProviderRequest,
  createSafeSseInspector,
  inspectJsonShape,
  parseProviderProbeArguments,
  parseStrictConnectionJson,
  persistPrivateProbeReport,
  runProviderCompatProbe,
} from '../../scripts/probe-provider-compat.mjs'

const BASE_URL = 'https://newapi.wingsandasoul.vip'
const SECRET = 'opaque-secret-material'

function keyFile(): string {
  return JSON.stringify({
    _type: 'newapi_channel_conn',
    key: SECRET,
    url: BASE_URL,
  })
}

function response(body: string, contentType: string): Response {
  const result = new Response(body, {
    status: 200,
    headers: { 'content-type': contentType },
  })
  Object.defineProperty(result, 'url', {
    value: `${BASE_URL}/v1/chat/completions`,
  })
  return result
}

describe('provider compatibility probe', () => {
  it('has an exact model allowlist and requires explicit execution', () => {
    expect(ALLOWED_PROVIDER_MODELS).toEqual([
      'DeepSeek V4 Flash: Go',
      'Qwen 3.7 Plus: Go',
      'MiniMax M3: Go',
      'Gemini 3.7 Flash: Antigravity',
    ])
    expect(() => parseProviderProbeArguments([
      '--model', 'DeepSeek V4 Flash: Go',
      '--protocol', 'openai-chat',
    ])).toThrow('execute_flag_required')
    expect(() => parseProviderProbeArguments([
      '--execute',
      '--model', 'unapproved-model',
      '--protocol', 'openai-chat',
    ])).toThrow('model_not_allowed')
    expect(() => parseProviderProbeArguments([
      '--execute',
      '--model', 'DeepSeek V4 Flash: Go',
      '--protocol', 'anthropic-messages',
    ])).toThrow('model_protocol_mismatch')
    const protocolByModel = new Map([
      ['DeepSeek V4 Flash: Go', 'openai-chat'],
      ['Gemini 3.7 Flash: Antigravity', 'openai-chat'],
      ['Qwen 3.7 Plus: Go', 'anthropic-messages'],
      ['MiniMax M3: Go', 'anthropic-messages'],
    ])
    for (const model of ALLOWED_PROVIDER_MODELS) {
      const protocol = protocolByModel.get(model)!
      expect(() => buildProviderRequest({
        baseUrl: BASE_URL,
        apiKey: SECRET,
        model,
        protocol,
      })).not.toThrow()
      expect(() => buildProviderRequest({
        baseUrl: BASE_URL,
        apiKey: SECRET,
        model,
        protocol: protocol === 'openai-chat' ? 'anthropic-messages' : 'openai-chat',
      })).toThrow('model_protocol_mismatch')
    }
    expect(parseProviderProbeArguments([
      '--execute',
      '--model', 'DeepSeek V4 Flash: Go',
      '--protocol', 'openai-chat',
      '--timeout-ms', '900000',
    ])).toMatchObject({
      execute: true,
      model: 'DeepSeek V4 Flash: Go',
      protocol: 'openai-chat',
      timeoutMs: 900_000,
    })
  })

  it('accepts only the strict root-bound HTTPS NewAPI connection object', () => {
    expect(parseStrictConnectionJson(keyFile())).toEqual({
      apiKey: SECRET,
      baseUrl: BASE_URL,
    })
    for (const invalid of [
      SECRET,
      JSON.stringify({ _type: 'newapi_channel_conn', key: SECRET, url: 'http://x.test' }),
      JSON.stringify({ _type: 'newapi_channel_conn', key: SECRET, url: `${BASE_URL}/v1` }),
      JSON.stringify({ _type: 'newapi_channel_conn', key: SECRET, url: BASE_URL, extra: true }),
      '{"_type":"newapi_channel_conn","key":"first","key":"second","url":"https://newapi.wingsandasoul.vip"}',
      JSON.stringify({
        _type: 'newapi_channel_conn',
        key: SECRET,
        url: 'https://different-newapi.example.invalid',
      }),
      `\u00a0${keyFile()}`,
      `\u000b${keyFile()}`,
      `${keyFile()}\u000c`,
      ` \uFEFF${keyFile()}`,
      `\uFEFF\uFEFF${keyFile()}`,
    ]) {
      expect(() => parseStrictConnectionJson(invalid)).toThrow()
    }
    expect(parseStrictConnectionJson(`\uFEFF \t\r\n${keyFile()}\r\n`)).toMatchObject({
      baseUrl: BASE_URL,
    })
  })

  it('builds the OpenAI and Anthropic protocol-specific requests', () => {
    const openai = buildProviderRequest({
      baseUrl: BASE_URL,
      apiKey: SECRET,
      model: 'DeepSeek V4 Flash: Go',
      protocol: 'openai-chat',
    })
    expect(openai.url).toBe(`${BASE_URL}/v1/chat/completions`)
    expect(openai.headers.authorization).toBe(`Bearer ${SECRET}`)
    expect(openai.body).toMatchObject({
      model: 'DeepSeek V4 Flash: Go',
      max_tokens: 4_096,
      stream: true,
      stream_options: { include_usage: true },
    })

    const anthropic = buildProviderRequest({
      baseUrl: BASE_URL,
      apiKey: SECRET,
      model: 'Qwen 3.7 Plus: Go',
      protocol: 'anthropic-messages',
    })
    expect(anthropic.url).toBe(`${BASE_URL}/v1/messages`)
    expect(anthropic.headers['x-api-key']).toBe(SECRET)
    expect(anthropic.headers['anthropic-version']).toBe('2023-06-01')
    expect(anthropic.body).toMatchObject({
      model: 'Qwen 3.7 Plus: Go',
      max_tokens: 4_096,
      stream: true,
    })
  })

  it('captures SSE structure, text lengths, reasons and usage without text values', () => {
    const privateText = 'PRIVATE_OUTPUT_MUST_NOT_APPEAR'
    const privateReasoning = 'PRIVATE_REASONING_MUST_NOT_APPEAR'
    const inspector = createSafeSseInspector()
    inspector.push(new TextEncoder().encode([
      'event: content_block_delta',
      `data: ${JSON.stringify({
        choices: [{
          delta: { content: privateText, reasoning_content: privateReasoning },
          finish_reason: null,
        }],
      })}`,
      '',
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      })}`,
      '',
      'data: [DONE]',
      '',
    ].join('\r\n')))
    const capture = inspector.end()
    const serialized = JSON.stringify(capture)
    expect(serialized).not.toContain(privateText)
    expect(serialized).not.toContain(privateReasoning)
    expect(capture.events.map((event) => event.kind)).toEqual(['json', 'json', 'done'])
    expect(capture.events[0].eventType).toBe('content_block_delta')
    expect(capture.events[0].json.textFields).toHaveLength(2)
    expect(capture.events[1].json.finishReasons).toEqual(['stop'])
    expect(capture.events[1].json.usage).toEqual(expect.arrayContaining([
      { path: '$.usage.prompt_tokens', value: 7 },
      { path: '$.usage.completion_tokens', value: 3 },
      { path: '$.usage.total_tokens', value: 10 },
    ]))
    expect(capture.framing.crlf).toBeGreaterThan(0)
  })

  it('keeps a valid standard multi-data JSON event intact', () => {
    const privateText = 'STANDARD_MULTI_DATA_PRIVATE_TEXT'
    const inspector = createSafeSseInspector()
    inspector.push(new TextEncoder().encode([
      'event: content_block_delta',
      'data: {"type":"content_block_delta",',
      `data: "delta":{"type":"text_delta","text":${JSON.stringify(privateText)}}}`,
      '',
      '',
    ].join('\n')))
    const capture = inspector.end()
    expect(capture.events).toHaveLength(1)
    expect(capture.events[0]).toMatchObject({
      kind: 'json',
      eventType: 'content_block_delta',
      dataLines: 2,
      eofTerminated: false,
    })
    expect(JSON.stringify(capture)).not.toContain(privateText)
  })

  it('never partitions a blank-delimited standard multi-data event', () => {
    const inspector = createSafeSseInspector()
    inspector.push(new TextEncoder().encode([
      'data: {"first":true}',
      'data: {"second":true}',
      '',
      '',
    ].join('\n')))
    const capture = inspector.end()
    expect(capture.events).toHaveLength(1)
    expect(capture.events[0]).toMatchObject({
      kind: 'malformed_json',
      dataLines: 2,
      eofTerminated: false,
    })
  })

  it('partitions consecutive complete NewAPI data lines without blank delimiters', () => {
    const inspector = createSafeSseInspector()
    inspector.push(new TextEncoder().encode([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'FIRST_PRIVATE' } }] })}`,
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      })}`,
      'data: [DONE]',
    ].join('\n')))
    const capture = inspector.end()
    expect(capture.events.map((event) => event.kind)).toEqual(['json', 'json', 'done'])
    expect(capture.events[1].json.finishReasons).toEqual(['stop'])
    expect(JSON.stringify(capture)).not.toContain('FIRST_PRIVATE')
  })

  it('groups no-blank Anthropic event and data segments with their event types', () => {
    const privateText = 'ANTHROPIC_NO_BLANK_PRIVATE_TEXT'
    const inspector = createSafeSseInspector()
    inspector.push(new TextEncoder().encode([
      'event: message_start',
      `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 4 } } })}`,
      'event: content_block_delta',
      `data: ${JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: privateText },
      })}`,
      'event: message_delta',
      `data: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      })}`,
    ].join('\n')))
    const capture = inspector.end()
    expect(capture.events.map((event) => event.eventType)).toEqual([
      'message_start',
      'content_block_delta',
      'message_delta',
    ])
    expect(capture.events.every((event) => event.kind === 'json')).toBe(true)
    expect(capture.events[2].json.stopReasons).toEqual(['end_turn'])
    expect(JSON.stringify(capture)).not.toContain(privateText)
  })

  it('handles thousands of line-delimited events without recursive framing', () => {
    const inspector = createSafeSseInspector()
    const count = 5_000
    const lines = Array.from(
      { length: count },
      (_, index) => `data: ${JSON.stringify({ usage: { output_tokens: index } })}`,
    )
    lines.push('data: [DONE]')
    inspector.push(new TextEncoder().encode(lines.join('\n')))
    const capture = inspector.end()
    expect(capture.events).toHaveLength(count + 1)
    expect(capture.events.at(-1)?.kind).toBe('done')
  })

  it.each([
    ['text/event-stream', 'AbortError'],
    ['text/event-stream', 'TimeoutError'],
    ['application/json', 'AbortError'],
    ['application/json', 'TimeoutError'],
  ])('preserves a post-header %s body failure as timeout (%s)', async (contentType, errorName) => {
    const body = new ReadableStream({
      pull(controller) {
        controller.error(new DOMException('private timeout detail', errorName))
      },
    })
    const abortedResponse = new Response(body, {
      status: 200,
      headers: { 'content-type': contentType },
    })
    Object.defineProperty(abortedResponse, 'url', {
      value: `${BASE_URL}/v1/chat/completions`,
    })
    await expect(runProviderCompatProbe({
      keyFile: 'ignored-in-fixture',
      model: 'DeepSeek V4 Flash: Go',
      protocol: 'openai-chat',
      fetchImpl: (async () => abortedResponse) as unknown as typeof fetch,
      readFileImpl: (async () => keyFile()) as never,
    })).rejects.toMatchObject({
      code: 'timeout',
      type: 'transport_error',
    })
  })

  it('hashes unknown property names and every string value', () => {
    const providerKey = 'provider-controlled-secret-key'
    const providerValue = 'provider-controlled-secret-value'
    const capture = inspectJsonShape({
      [providerKey]: providerValue,
      stop_reason: 'unexpected-provider-reason',
    })
    const serialized = JSON.stringify(capture)
    expect(serialized).not.toContain(providerKey)
    expect(serialized).not.toContain(providerValue)
    expect(serialized).not.toContain('unexpected-provider-reason')
    expect(capture.paths.some((entry) => entry.path.includes('$key_sha256_'))).toBe(true)
    expect(capture.stopReasons[0]).toMatch(/^other_sha256_/)
  })

  it('performs exactly one request and emits only redacted response evidence', async () => {
    const privateText = 'ONE_REQUEST_PRIVATE_TEXT'
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${BASE_URL}/v1/chat/completions`)
      expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`)
      const parsed = JSON.parse(String(init.body))
      expect(parsed.model).toBe('DeepSeek V4 Flash: Go')
      return response([
        `data: ${JSON.stringify({
          choices: [{ delta: { content: privateText }, finish_reason: null }],
        })}`,
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
        })}`,
        'data: [DONE]',
        '',
      ].join('\n'), 'text/event-stream')
    })
    const report = await runProviderCompatProbe({
      keyFile: 'ignored-in-fixture',
      model: 'DeepSeek V4 Flash: Go',
      protocol: 'openai-chat',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      readFileImpl: (async () => keyFile()) as never,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(report.request).toMatchObject({ physicalRequests: 1, retries: 0 })
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain(SECRET)
    expect(serialized).not.toContain(privateText)
    expect(serialized).not.toContain('Return the single uppercase word')
  })

  it('restricts persisted evidence to a private report basename', async () => {
    const writes: Array<{ destination: string; body: string }> = []
    await expect(persistPrivateProbeReport(
      { ok: true },
      '../outside.json',
    )).rejects.toThrow('invalid_output_name')
    await persistPrivateProbeReport(
      { ok: true },
      'deepseek-openai-shape.json',
      {
        mkdirImpl: async () => undefined,
        writeFileImpl: async (destination, body) => {
          writes.push({ destination: String(destination), body: String(body) })
        },
      },
    )
    expect(writes).toHaveLength(1)
    expect(writes.every(({ destination }) => (
      destination.includes('FSBP_Test') && destination.includes('provider-compat')
    ))).toBe(true)
  })
})
