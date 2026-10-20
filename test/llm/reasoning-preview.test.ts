import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chatCompletion,
  isAsyncIterable,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type LLMStreamEvent,
  type ReasoningUpdate,
} from '../../src/lib/llm/client';

const endpoint = { baseUrl: 'http://mock.invalid/v1', apiKey: 'mock-key' };
const request: ChatCompletionRequest = {
  model: 'mock',
  messages: [{ role: 'user', content: 'Translate the passage.' }],
};

function mockSseChoices(choices: Array<Record<string, unknown>>, finishReason = 'stop') {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const choice of choices) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          choices: [choice],
        })}\n\n`));
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: finishReason }],
      })}\n\ndata: [DONE]\n\n`));
      controller.close();
    },
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
  ));
}

function mockSse(deltas: Array<Record<string, unknown>>, finishReason = 'stop') {
  mockSseChoices(deltas.map((delta) => ({ delta, finish_reason: null })), finishReason);
}

function mockJson(message: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    choices: [{ message, finish_reason: 'stop' }],
  }), { headers: { 'content-type': 'application/json' } })));
}

async function collect(overrides: Partial<ChatCompletionRequest> = {}) {
  const result = await chatCompletion(endpoint, { ...request, stream: true, ...overrides });
  expect(isAsyncIterable(result)).toBe(true);
  const events: LLMStreamEvent[] = [];
  for await (const event of result as AsyncIterable<LLMStreamEvent>) events.push(event);
  return {
    text: events.filter((event) => event.type === 'text').map((event) => event.content).join(''),
    done: events.find((event) => event.type === 'done'),
    events,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('independent bounded reasoning preview', () => {
  it('continues reporting 40,000 reasoning characters without accumulating them in output', async () => {
    const reasoning = Array.from({ length: 40 }, (_, index) =>
      `${index.toString().padStart(2, '0')}:${'思'.repeat(997)}`);
    mockSse([
      ...reasoning.map((reasoning_content) => ({ reasoning_content })),
      { content: '{"body":"译文","notes":[]}' },
    ]);
    let lastUpdate: ReasoningUpdate | undefined;
    let preview = '';
    let largestDelta = 0;
    let updateCount = 0;
    const result = await collect({
      onReasoning(update) {
        lastUpdate = update;
        updateCount += 1;
        largestDelta = Math.max(largestDelta, update.delta.length);
        preview = (preview + update.delta).slice(-4000);
      },
    });
    expect(updateCount).toBe(40);
    expect(largestDelta).toBeLessThanOrEqual(1024);
    expect(lastUpdate).toMatchObject({ characters: 40_000, chunks: 40, truncated: false });
    expect(preview).toHaveLength(4000);
    expect(preview).toBe(reasoning.slice(-4).join(''));
    expect(result.text).toBe('{"body":"译文","notes":[]}');
    expect(result.done?.content).toBe(result.text);
    expect(JSON.stringify(result.events)).not.toContain('思思');
    expect(result.done?.providerDiagnostics).toEqual({
      reasoningFields: ['reasoning_content'],
      reasoningCharacters: 40_000,
      reasoningChunks: 40,
    });
  });

  it('takes the bounded tail of oversized provider chunks and preserves full counters', async () => {
    const rawReasoning = '思'.repeat(39_996) + '尾部进度';
    mockSse([{ reasoning_content: rawReasoning }, { reasoning_content: '最新' }, { content: '译文' }]);
    const updates: ReasoningUpdate[] = [];
    const result = await collect({ onReasoning: (update) => updates.push(update) });
    expect(updates[0]).toEqual({
      source: 'reasoning_content',
      delta: rawReasoning.slice(-1024),
      characters: 40_000,
      chunks: 1,
      truncated: true,
    });
    expect(updates[1]).toMatchObject({ delta: '最新', characters: 40_002, truncated: true });
    expect(result.text).toBe('译文');
  });

  it.each([false, true])('supports JSON responses with stream=%s', async (stream) => {
    mockJson({ content: '译文', thinking: 'hidden'.repeat(1000) });
    const updates: ReasoningUpdate[] = [];
    const result = await chatCompletion(endpoint, {
      ...request,
      stream,
      onReasoning: (update) => updates.push(update),
    });
    if (isAsyncIterable(result)) {
      for await (const event of result) {
        if (event.type === 'done') expect(event.content).toBe('译文');
      }
    } else {
      expect(result.content).toBe('译文');
      expect(JSON.stringify(result)).not.toContain('hidden');
    }
    expect(updates).toHaveLength(1);
    expect(updates[0].delta).toHaveLength(1024);
    expect(updates[0]).toMatchObject({ source: 'thinking', characters: 6000, truncated: true });
  });

  it('isolates observer errors from successful content', async () => {
    mockSse([{ reasoning: 'private preview' }, { content: '译文' }]);
    const result = await collect({ onReasoning: () => { throw new Error('observer failed'); } });
    expect(result.text).toBe('译文');
  });

  it('counts only new reasoning when a gateway repeats aggregate message fields', async () => {
    mockSseChoices([
      { delta: { reasoning_content: 'private' } },
      { message: { reasoning_content: 'private final', content: '译文' } },
      { message: { reasoning_content: 'private final', content: '译文' } },
    ]);
    const updates: ReasoningUpdate[] = [];
    const result = await collect({ onReasoning: (update) => updates.push(update) });
    expect(updates.map((update) => update.delta)).toEqual(['private', ' final']);
    expect(result.done?.providerDiagnostics).toMatchObject({
      reasoningCharacters: 13,
      reasoningChunks: 2,
    });
  });

  it('keeps reasoning-only completion a failure with safe diagnostics', async () => {
    mockSse([{ reasoning_content: 'never a translation' }]);
    await expect(collect({ onReasoning: () => undefined })).rejects.toMatchObject({
      code: 'incomplete_output',
      message: 'LLM response completed with reasoning but no visible content',
      partialContent: '',
      providerDiagnostics: { reasoningCharacters: 19 },
    });
  });
});

describe('explicit leading <think> compatibility', () => {
  it('preserves literal tags by default', async () => {
    mockSse([{ content: '<think>literal example</think> translated text' }]);
    const updates: ReasoningUpdate[] = [];
    const result = await collect({ onReasoning: (update) => updates.push(update) });
    expect(result.text).toBe('<think>literal example</think> translated text');
    expect(updates).toHaveLength(0);
  });

  it('separates tags split across provider content chunks', async () => {
    mockSse(['<th', 'ink>私密', '思考</th', 'ink>{"body":"译文","notes":[]}']
      .map((content) => ({ content })));
    const updates: ReasoningUpdate[] = [];
    const result = await collect({
      reasoningTagMode: 'leading_think',
      onReasoning: (update) => updates.push(update),
    });
    expect(result.text).toBe('{"body":"译文","notes":[]}');
    expect(result.done?.content).toBe(result.text);
    expect(updates.map((update) => update.delta).join('')).toBe('私密思考');
    expect(result.done?.providerDiagnostics).toMatchObject({
      reasoningFields: ['think_tag'],
      reasoningCharacters: 4,
    });
  });

  it.each([
    '{"body":"literal <think>example</think>","notes":[]}',
    'Translation includes <think>literal text</think>.',
  ])('preserves tags inside visible content: %s', async (content) => {
    mockSse([...content].map((character) => ({ content: character })));
    const result = await collect({ reasoningTagMode: 'leading_think' });
    expect(result.text).toBe(content);
    expect(result.done?.providerDiagnostics).toBeUndefined();
  });

  it.each(['<think>unfinished reasoning', '<thi'])('rejects an incomplete wrapper: %s', async (content) => {
    mockSse([{ content }]);
    await expect(collect({ reasoningTagMode: 'leading_think' })).rejects.toMatchObject({
      code: 'incomplete_output',
      message: 'LLM response ended with an incomplete leading <think> block',
      partialContent: '',
    });
  });

  it.each([false, true])('also separates an explicit wrapper in JSON fallback with stream=%s', async (stream) => {
    mockJson({ content: '<think>private</think>译文' });
    const updates: ReasoningUpdate[] = [];
    const result = await chatCompletion(endpoint, {
      ...request,
      stream,
      reasoningTagMode: 'leading_think',
      onReasoning: (update) => updates.push(update),
    });
    if (isAsyncIterable(result)) {
      for await (const event of result) {
        if (event.type === 'done') expect(event.content).toBe('译文');
      }
    } else {
      expect((result as ChatCompletionResponse).content).toBe('译文');
    }
    expect(updates.map((update) => update.delta).join('')).toBe('private');
  });

  it('accepts a complete aggregate wrapper without replaying earlier reasoning', async () => {
    mockSseChoices([
      { delta: { content: '<think>private</thi' } },
      { message: { content: '<think>private</think>译文' } },
    ]);
    const updates: ReasoningUpdate[] = [];
    const result = await collect({
      reasoningTagMode: 'leading_think',
      onReasoning: (update) => updates.push(update),
    });
    expect(result.text).toBe('译文');
    expect(updates.map((update) => update.delta).join('')).toBe('private');
    expect(result.done?.providerDiagnostics?.reasoningCharacters).toBe(7);
  });

  it('counts only new reasoning in successive aggregate-only wrappers', async () => {
    mockSseChoices([
      { message: { content: '<think>a</think>A' } },
      { message: { content: '<think>ab</think>AB' } },
    ]);
    const updates: ReasoningUpdate[] = [];
    const result = await collect({
      reasoningTagMode: 'leading_think',
      onReasoning: (update) => updates.push(update),
    });
    expect(result.text).toBe('AB');
    expect(updates.map((update) => update.delta).join('')).toBe('ab');
    expect(result.done?.providerDiagnostics?.reasoningCharacters).toBe(2);
  });

  it('reports reasoning first supplied by a final aggregate snapshot', async () => {
    mockSseChoices([
      { delta: { content: 'A' } },
      { message: { content: '<think>private</think>AB' } },
    ]);
    const updates: ReasoningUpdate[] = [];
    const result = await collect({
      reasoningTagMode: 'leading_think',
      onReasoning: (update) => updates.push(update),
    });
    expect(result.text).toBe('AB');
    expect(updates.map((update) => update.delta).join('')).toBe('private');
    expect(result.done?.providerDiagnostics?.reasoningCharacters).toBe(7);
  });

  it('rejects length finish after filtering the reasoning wrapper', async () => {
    mockSse([{ content: '<think>private</think>partial answer' }], 'length');
    await expect(collect({ reasoningTagMode: 'leading_think' })).rejects.toMatchObject({
      code: 'incomplete_output',
      partialContent: 'partial answer',
    });
  });
});
