/**
 * LLM Client tests — TDD for Wave 2 Task 8
 *
 * Tests the OpenAI-compatible chatCompletion client against the mock-llm fixture.
 * Covers: non-streaming, streaming text, streaming tool_call delta merging,
 * error normalization, ToolsNotSupportedError, abort propagation,
 * non-stream fallback, AbortSignal.any merging, network errors.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { startMockLLM, type MockLLMInstance } from '../fixtures/mock-llm';
import {
  chatCompletion,
  isAsyncIterable,
  // Error classes
  LLMError,
  AuthError,
  RateLimitError,
  ServerError,
  TimeoutError,
  NetworkError,
  ClientError,
  ToolsNotSupportedError,
  AbortedError,
  IncompleteOutputError,
  // Types
  type LLMStreamEvent,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
} from '../../src/lib/llm/client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all events from an AsyncIterable<LLMStreamEvent> */
async function collectStreamEvents(
  iterable: AsyncIterable<LLMStreamEvent>,
): Promise<LLMStreamEvent[]> {
  const events: LLMStreamEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

/** Build a minimal chat completion request body */
function makeRequest(
  overrides: Partial<ChatCompletionRequest> = {},
): ChatCompletionRequest {
  return {
    model: 'test-model',
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('chatCompletion', () => {
  let llm: MockLLMInstance;
  let endpoint: { baseUrl: string; apiKey: string };

  beforeEach(async () => {
    llm = await startMockLLM();
    endpoint = { baseUrl: llm.url, apiKey: 'sk-test' };
  });

  afterEach(async () => {
    if (llm) {
      await llm.close();
    }
  });

  // =========================================================================
  // 1. Non-streaming — basic
  // =========================================================================

  describe('non-streaming', () => {
    it('returns content and usage for a non_stream response', async () => {
      llm.setBehavior('test-model', { behavior: 'non_stream' });

      const result = await chatCompletion(endpoint, makeRequest());

      // Should be a plain response (not an iterable)
      expect(isAsyncIterable(result)).toBe(false);
      const resp = result as ChatCompletionResponse;
      expect(resp.content).toContain('mock non-streaming');
      expect(resp.usage).toBeDefined();
      expect(resp.usage!.prompt_tokens).toBeGreaterThan(0);
      expect(resp.usage!.completion_tokens).toBeGreaterThan(0);
      expect(resp.usage!.total_tokens).toBeGreaterThan(0);
      expect(resp.toolCalls).toBeUndefined();
    });

    it('returns toolCalls for tool_call non-stream behavior', async () => {
      llm.setBehavior('test-model', {
        behavior: 'tool_call',
        stream: false,
      });

      const result = await chatCompletion(endpoint, makeRequest());

      expect(isAsyncIterable(result)).toBe(false);
      const resp = result as ChatCompletionResponse;
      expect(resp.content).toContain('I will search');
      expect(resp.toolCalls).toBeDefined();
      expect(resp.toolCalls!.length).toBe(1);
      expect(resp.toolCalls![0].name).toBe('replace_text');
      expect(resp.toolCalls![0].arguments).toContain('original text');
      // arguments should be valid JSON
      expect(() => JSON.parse(resp.toolCalls![0].arguments)).not.toThrow();
    });

    it('preserves invalid tool argument JSON from complete JSON responses', async () => {
      const http = await import('http');
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{
            message: {
              content: 'Here is my edit.',
              tool_calls: [{
                id: 'call_bad_json',
                type: 'function',
                function: {
                  name: 'replace_text',
                  arguments: '{not valid json',
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        }));
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address() as { port: number };
      const jsonEndpoint = {
        baseUrl: `http://localhost:${address.port}`,
        apiKey: 'sk-test',
      };
      try {
        const response = await chatCompletion(
          jsonEndpoint,
          makeRequest(),
        ) as ChatCompletionResponse;
        expect(response.toolCalls).toEqual([{
          id: 'call_bad_json',
          name: 'replace_text',
          arguments: '{not valid json',
        }]);

        const fallback = await chatCompletion(
          jsonEndpoint,
          makeRequest({ stream: true }),
        );
        const events = await collectStreamEvents(
          fallback as AsyncIterable<LLMStreamEvent>,
        );
        expect(events.at(-1)).toMatchObject({
          type: 'done',
          transport: 'json_fallback',
          toolCalls: [{
            id: 'call_bad_json',
            name: 'replace_text',
            arguments: '{not valid json',
          }],
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('rejects incomplete envelopes and non-array tool_calls in JSON responses', async () => {
      const http = await import('http');
      const variants: Record<string, unknown> = {
        missing_id: [{
          function: { name: 'replace_text', arguments: '{broken json' },
        }],
        missing_name: [{
          id: 'call_missing_name',
          function: { arguments: '{broken json' },
        }],
        missing_arguments: [{
          id: 'call_missing_arguments',
          function: { name: 'replace_text' },
        }],
        non_array: { id: 'call_not_in_an_array' },
      };
      const server = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          model: string;
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{
            message: {
              content: 'This response must not be accepted.',
              tool_calls: variants[request.model],
            },
            finish_reason: 'tool_calls',
          }],
        }));
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address() as { port: number };
      const boundaryEndpoint = {
        baseUrl: `http://localhost:${address.port}`,
        apiKey: 'sk-test',
      };
      try {
        for (const model of Object.keys(variants)) {
          await expect(chatCompletion(
            boundaryEndpoint,
            makeRequest({ model }),
          )).rejects.toMatchObject({
            code: 'incomplete_output',
            partialContent: 'This response must not be accepted.',
          });
        }
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('echoes user message content', async () => {
      llm.setBehavior('test-model', { behavior: 'echo' });

      const result = await chatCompletion(endpoint, makeRequest({
        messages: [{ role: 'user', content: 'Echo this back' }],
      }));

      expect(isAsyncIterable(result)).toBe(false);
      const resp = result as ChatCompletionResponse;
      expect(resp.content).toBe('Echo this back');
    });

    it('forwards an explicit required tool choice', async () => {
      llm.setBehavior('test-model', { behavior: 'non_stream' });

      await chatCompletion(endpoint, makeRequest({
        tools: [{
          type: 'function',
          function: {
            name: 'call_agents',
            parameters: { type: 'object' },
          },
        }],
        toolChoice: {
          type: 'function',
          function: { name: 'call_agents' },
        },
      }));

      const body = llm.getRequests()[0]?.body as {
        tool_choice?: unknown
      };
      expect(body.tool_choice).toEqual({
        type: 'function',
        function: { name: 'call_agents' },
      });
    });

    it('forwards an explicit completion token budget', async () => {
      llm.setBehavior('test-model', { behavior: 'non_stream' });

      await chatCompletion(endpoint, makeRequest({ maxTokens: 16_384 }));

      const body = llm.getRequests()[0]?.body as {
        max_tokens?: unknown
      };
      expect(body.max_tokens).toBe(16_384);
    });

    it('accepts only safe integer usage and derives a missing total', async () => {
      const http = await import('http');
      const usages: Record<string, Record<string, number>> = {
        negative: { prompt_tokens: -1, completion_tokens: 2, total_tokens: 1 },
        fractional: { prompt_tokens: 1, completion_tokens: 1.5, total_tokens: 2.5 },
        overflow: {
          prompt_tokens: Number.MAX_SAFE_INTEGER,
          completion_tokens: 1,
        },
        inconsistent: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 11 },
        missing_total: { prompt_tokens: 4, completion_tokens: 6 },
      };
      const server = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          model: string;
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{
            message: { content: 'complete response' },
            finish_reason: 'stop',
          }],
          usage: usages[request.model],
        }));
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address() as { port: number };
      const usageEndpoint = {
        baseUrl: `http://localhost:${address.port}`,
        apiKey: 'sk-test',
      };
      try {
        for (const model of ['negative', 'fractional', 'overflow', 'inconsistent']) {
          const result = await chatCompletion(
            usageEndpoint,
            makeRequest({ model }),
          ) as ChatCompletionResponse;
          expect(result.usage).toBeUndefined();
        }
        const result = await chatCompletion(
          usageEndpoint,
          makeRequest({ model: 'missing_total' }),
        ) as ChatCompletionResponse;
        expect(result.usage).toEqual({
          prompt_tokens: 4,
          completion_tokens: 6,
          total_tokens: 10,
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('fails closed for length, content_filter, unknown, or missing finish reasons', async () => {
      const http = await import('http');
      const server = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          model: string
        };
        const finishReason = request.model === 'missing' ? null : request.model;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{
            message: { content: 'partial provider text' },
            finish_reason: finishReason,
          }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        }));
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address() as { port: number };
      try {
        for (const finishReason of ['length', 'content_filter', 'mystery', 'missing']) {
          await expect(chatCompletion(
            { baseUrl: `http://localhost:${address.port}`, apiKey: 'sk-test' },
            makeRequest({ model: finishReason }),
          )).rejects.toMatchObject({
            code: 'incomplete_output',
            partialContent: 'partial provider text',
          });
        }
        const fallback = await chatCompletion(
          { baseUrl: `http://localhost:${address.port}`, apiKey: 'sk-test' },
          makeRequest({ model: 'content_filter', stream: true }),
        );
        await expect(collectStreamEvents(
          fallback as AsyncIterable<LLMStreamEvent>,
        )).rejects.toMatchObject({ code: 'incomplete_output' });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  // =========================================================================
  // 2. Streaming — text deltas
  // =========================================================================

  describe('streaming — text deltas', () => {
    it('yields text events and ends with done event', async () => {
      llm.setBehavior('test-model', {
        behavior: 'stream',
        chunkDelayMs: 0,
      });

      const result = await chatCompletion(endpoint, makeRequest({ stream: true }));

      expect(isAsyncIterable(result)).toBe(true);
      const events = await collectStreamEvents(result as AsyncIterable<LLMStreamEvent>);

      // Should have at least one text event
      const textEvents = events.filter((e) => e.type === 'text');
      expect(textEvents.length).toBeGreaterThan(0);

      // Should end with a done event
      const lastEvent = events[events.length - 1];
      expect(lastEvent.type).toBe('done');
      if (lastEvent.type === 'done') {
        expect(lastEvent.content).toContain('mock streaming response');
      }
    });

    it('all text deltas concatenate to full content', async () => {
      llm.setBehavior('test-model', {
        behavior: 'stream',
        chunkDelayMs: 0,
      });

      const result = await chatCompletion(endpoint, makeRequest({ stream: true }));
      const events = await collectStreamEvents(result as AsyncIterable<LLMStreamEvent>);

      const fullText = events
        .filter((e) => e.type === 'text')
        .map((e) => (e as { type: 'text'; content: string }).content)
        .join('');

      const doneEvent = events.find((e) => e.type === 'done') as
        | { type: 'done'; content: string }
        | undefined;
      expect(doneEvent).toBeDefined();
      expect(fullText).toBe(doneEvent!.content);
    });

    it('rejects a stream that closes without a completion marker', async () => {
      const http = await import('http');
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({
          choices: [{
            index: 0,
            delta: { content: 'unfinished sentence' },
            finish_reason: null,
          }],
        })}\n\n`);
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address() as { port: number };
      try {
        const result = await chatCompletion(
          { baseUrl: `http://localhost:${address.port}`, apiKey: 'sk-test' },
          makeRequest({ stream: true }),
        );
        await expect(
          collectStreamEvents(result as AsyncIterable<LLMStreamEvent>),
        ).rejects.toMatchObject({
          code: 'incomplete_output',
          partialContent: 'unfinished sentence',
          message: 'LLM stream closed without a completion marker',
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('rejects finish_reason length instead of accepting truncated text', async () => {
      const http = await import('http');
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({
          choices: [{
            index: 0,
            delta: { content: 'truncated' },
            finish_reason: null,
          }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          choices: [{
            index: 0,
            delta: {},
            finish_reason: 'length',
          }],
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address() as { port: number };
      try {
        const result = await chatCompletion(
          { baseUrl: `http://localhost:${address.port}`, apiKey: 'sk-test' },
          makeRequest({ stream: true }),
        );
        await expect(
          collectStreamEvents(result as AsyncIterable<LLMStreamEvent>),
        ).rejects.toBeInstanceOf(IncompleteOutputError);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('accepts NewAPI line-delimited SSE and a complete EOF residual', async () => {
      const http = await import('http');
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end([
          `data: ${JSON.stringify({ choices: [{
            delta: { reasoning_content: 'private-shape-only' },
            finish_reason: null,
          }] })}`,
          `data: ${JSON.stringify({ choices: [{
            delta: { content: 'Visible NewAPI result' },
            finish_reason: null,
          }] })}`,
          `data: ${JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
          })}`,
        ].join('\n'));
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address() as { port: number };
      try {
        const result = await chatCompletion(
          { baseUrl: `http://localhost:${address.port}`, apiKey: 'sk-test' },
          makeRequest({ stream: true }),
        );
        const events = await collectStreamEvents(
          result as AsyncIterable<LLMStreamEvent>,
        );
        expect(events.at(-1)).toMatchObject({
          type: 'done',
          content: 'Visible NewAPI result',
          usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
          providerDiagnostics: {
            reasoningFields: ['reasoning_content'],
            reasoningChunks: 1,
            reasoningCharacters: 'private-shape-only'.length,
          },
        });
        expect(JSON.stringify(events)).not.toContain('private-shape-only');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('accepts a matching aggregate message as clean-EOF evidence', async () => {
      const http = await import('http');
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end([
          `data: ${JSON.stringify({ choices: [{
            delta: { content: 'Aggregate' },
            finish_reason: null,
          }] })}`,
          '',
          `data: ${JSON.stringify({ choices: [{
            message: { content: 'Aggregate result' },
            finish_reason: null,
          }] })}`,
          '',
        ].join('\n'));
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address() as { port: number };
      try {
        const result = await chatCompletion(
          { baseUrl: `http://localhost:${address.port}`, apiKey: 'sk-test' },
          makeRequest({ stream: true }),
        );
        const events = await collectStreamEvents(
          result as AsyncIterable<LLMStreamEvent>,
        );
        expect(events.filter((event) => event.type === 'text')).toEqual([
          { type: 'text', content: 'Aggregate' },
          { type: 'text', content: ' result' },
        ]);
        expect(events.at(-1)).toMatchObject({
          type: 'done',
          content: 'Aggregate result',
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('treats the first explicit finish reason as terminal and cancels the reader', async () => {
      const encoder = new TextEncoder();
      let cancelReason: unknown;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode([
            `data: ${JSON.stringify({ choices: [{
              delta: { content: 'authoritative result' },
              finish_reason: null,
            }] })}`,
            `data: ${JSON.stringify({ choices: [{
              delta: {},
              finish_reason: 'stop',
            }] })}`,
            `data: ${JSON.stringify({ choices: [{
              delta: { content: 'must be ignored' },
              finish_reason: 'length',
            }] })}`,
          ].join('\n')));
        },
        cancel(reason) {
          cancelReason = reason;
        },
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );

      try {
        const result = await chatCompletion(
          endpoint,
          makeRequest({ stream: true }),
        );
        const events = await collectStreamEvents(
          result as AsyncIterable<LLMStreamEvent>,
        );
        expect(events.at(-1)).toMatchObject({
          type: 'done',
          content: 'authoritative result',
        });
        expect(JSON.stringify(events)).not.toContain('must be ignored');
        expect(cancelReason).toBe('SSE terminal event received');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('collects a safe choices=[] usage tail from the same decoded chunk', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode([
            `data: ${JSON.stringify({ choices: [{
              delta: { content: 'same-chunk result' },
              finish_reason: null,
            }] })}`,
            `data: ${JSON.stringify({ choices: [{
              delta: {},
              finish_reason: 'stop',
            }] })}`,
            `data: ${JSON.stringify({
              choices: [],
              usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
            })}`,
          ].join('\n')));
          controller.close();
        },
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );

      try {
        const result = await chatCompletion(
          endpoint,
          makeRequest({ stream: true }),
        );
        const events = await collectStreamEvents(
          result as AsyncIterable<LLMStreamEvent>,
        );
        expect(events.at(-1)).toMatchObject({
          type: 'done',
          content: 'same-chunk result',
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
        });
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('enforces the event limit while consuming one large decoded chunk', async () => {
      const encoder = new TextEncoder();
      const oversizedEventChunk = Array.from(
        { length: 100_001 },
        () => 'data: {"choices":[]}',
      ).join('\n');
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(oversizedEventChunk));
          controller.close();
        },
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );

      try {
        const result = await chatCompletion(
          endpoint,
          makeRequest({ stream: true }),
        );
        await expect(collectStreamEvents(
          result as AsyncIterable<LLMStreamEvent>,
        )).rejects.toMatchObject({
          code: 'incomplete_output',
          message: 'LLM SSE stream exceeded the bounded event limit',
        });
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('keeps the authoritative completion when the usage tail hangs or errors', async () => {
      const encoder = new TextEncoder();
      const primaryChunk = encoder.encode([
        `data: ${JSON.stringify({ choices: [{
          delta: { content: 'stable terminal result' },
          finish_reason: null,
        }] })}`,
        `data: ${JSON.stringify({ choices: [{
          delta: {},
          finish_reason: 'stop',
        }] })}`,
        '',
      ].join('\n'));

      for (const mode of ['hang', 'error'] as const) {
        let primarySent = false;
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!primarySent) {
              primarySent = true;
              controller.enqueue(primaryChunk);
              return;
            }
            if (mode === 'error') controller.error(new Error('tail transport failed'));
            else return new Promise<void>(() => {});
          },
          cancel() {
            cancelled = true;
          },
        });
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }),
        );

        try {
          const result = await chatCompletion(
            endpoint,
            makeRequest({ stream: true }),
          );
          const events = await collectStreamEvents(
            result as AsyncIterable<LLMStreamEvent>,
          );
          expect(events.at(-1)).toMatchObject({
            type: 'done',
            content: 'stable terminal result',
          });
          if (mode === 'hang') expect(cancelled).toBe(true);
        } finally {
          fetchSpy.mockRestore();
        }
      }
    });

    it('preserves standard multiline data events', async () => {
      const http = await import('http');
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end([
          'data: {"choices":[{"delta":{"content":"multiline result"},',
          'data: "finish_reason":"stop"}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'));
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address() as { port: number };
      try {
        const result = await chatCompletion(
          { baseUrl: `http://localhost:${address.port}`, apiKey: 'sk-test' },
          makeRequest({ stream: true }),
        );
        await expect(collectStreamEvents(
          result as AsyncIterable<LLMStreamEvent>,
        )).resolves.toEqual(expect.arrayContaining([
          { type: 'text', content: 'multiline result' },
        ]));
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('rejects malformed JSON SSE frames instead of skipping them', async () => {
      const http = await import('http');
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: {"choices":[{"delta":{"content":"broken"}\n\n');
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address() as { port: number };
      try {
        const result = await chatCompletion(
          { baseUrl: `http://localhost:${address.port}`, apiKey: 'sk-test' },
          makeRequest({ stream: true }),
        );
        await expect(collectStreamEvents(
          result as AsyncIterable<LLMStreamEvent>,
        )).rejects.toMatchObject({
          code: 'incomplete_output',
          message: 'LLM SSE contained malformed or truncated JSON data',
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('rejects a completed SSE stream with no content or complete tool calls', async () => {
      const http = await import('http');
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end([
          `data: ${JSON.stringify({ choices: [{
            delta: {},
            finish_reason: 'stop',
          }] })}`,
          'data: [DONE]',
          '',
        ].join('\n\n'));
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address() as { port: number };
      try {
        const result = await chatCompletion(
          { baseUrl: `http://localhost:${address.port}`, apiKey: 'sk-test' },
          makeRequest({ stream: true }),
        );
        await expect(collectStreamEvents(
          result as AsyncIterable<LLMStreamEvent>,
        )).rejects.toMatchObject({
          code: 'incomplete_output',
          message: 'LLM response completed without visible content',
          partialContent: '',
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('fails closed for a non-success SSE finish reason', async () => {
      const http = await import('http');
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end([
          `data: ${JSON.stringify({ choices: [{
            delta: { content: 'filtered partial' },
            finish_reason: null,
          }] })}`,
          `data: ${JSON.stringify({ choices: [{
            delta: {},
            finish_reason: 'content_filter',
          }] })}`,
          'data: [DONE]',
          '',
        ].join('\n\n'));
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address() as { port: number };
      try {
        const result = await chatCompletion(
          { baseUrl: `http://localhost:${address.port}`, apiKey: 'sk-test' },
          makeRequest({ stream: true }),
        );
        await expect(collectStreamEvents(
          result as AsyncIterable<LLMStreamEvent>,
        )).rejects.toMatchObject({
          code: 'incomplete_output',
          partialContent: 'filtered partial',
          message: 'LLM response ended with non-success finish_reason "content_filter"',
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe('streaming usage compatibility', () => {
    async function readRequestBody(
      req: import('http').IncomingMessage,
    ): Promise<Record<string, unknown>> {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
        string,
        unknown
      >;
    }

    async function listenOnLoopback(
      server: import('http').Server,
    ): Promise<string> {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('stream compatibility server did not bind a TCP port');
      }
      return `http://127.0.0.1:${address.port}`;
    }

    async function closeServer(server: import('http').Server): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (
            error &&
            (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
          ) {
            reject(error);
            return;
          }
          resolve();
        });
        server.closeAllConnections();
      });
    }

    it('collects a safe choices=[] usage frame from the next chunk', async () => {
      const http = await import('http');
      const requestBodies: Array<Record<string, unknown>> = [];
      const server = http.createServer(async (req, res) => {
        requestBodies.push(await readRequestBody(req));
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({
          choices: [{
            index: 0,
            delta: { content: 'Usage-aware response' },
            finish_reason: null,
          }],
          usage: null,
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: null,
        })}\n\n`);
        setTimeout(() => {
          if (res.destroyed) return;
          res.write(`data: ${JSON.stringify({
            choices: [],
            usage: {
              prompt_tokens: 21,
              completion_tokens: 8,
              total_tokens: 29,
            },
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }, 10);
      });
      const url = await listenOnLoopback(server);

      try {
        const result = await chatCompletion(
          { baseUrl: url, apiKey: 'sk-test' },
          makeRequest({ stream: true }),
        );
        const events = await collectStreamEvents(
          result as AsyncIterable<LLMStreamEvent>,
        );
        const done = events.at(-1);

        expect(requestBodies).toHaveLength(1);
        expect(requestBodies[0].stream_options).toEqual({
          include_usage: true,
        });
        expect(done).toMatchObject({
          type: 'done',
          content: 'Usage-aware response',
          transport: 'sse',
          usage: {
            prompt_tokens: 21,
            completion_tokens: 8,
            total_tokens: 29,
          },
        });
      } finally {
        await closeServer(server);
      }
    });

    it('retries once without stream_options when the endpoint rejects it', async () => {
      const http = await import('http');
      const requestBodies: Array<Record<string, unknown>> = [];
      const authorizationHeaders: Array<string | undefined> = [];
      let credentialReadCount = 0;
      let retryError: ClientError | undefined;
      let callbackObservedBeforeRetry = false;
      const server = http.createServer(async (req, res) => {
        const body = await readRequestBody(req);
        requestBodies.push(body);
        authorizationHeaders.push(req.headers.authorization);
        if ('stream_options' in body) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              message: 'Unsupported parameter: stream_options',
              type: 'invalid_request_error',
              code: 'unsupported_parameter',
            },
          }));
          return;
        }

        callbackObservedBeforeRetry = retryError instanceof ClientError;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({
          choices: [{
            index: 0,
            delta: { content: 'Compatible fallback' },
            finish_reason: 'stop',
          }],
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
      const url = await listenOnLoopback(server);

      try {
        const result = await chatCompletion(
          {
            baseUrl: url,
            apiKey: 'sk-stale',
            resolveRuntimeEndpoint() {
              credentialReadCount += 1;
              return {
                baseUrl: url,
                apiKey: `sk-current-${credentialReadCount}`,
              };
            },
          },
          makeRequest({
            stream: true,
            onCompatibilityRetry(error) {
              retryError = error;
              throw new Error('telemetry failure must be ignored');
            },
          }),
        );
        const events = await collectStreamEvents(
          result as AsyncIterable<LLMStreamEvent>,
        );

        expect(events.at(-1)).toMatchObject({
          type: 'done',
          content: 'Compatible fallback',
        });
        expect(requestBodies).toHaveLength(2);
        expect(requestBodies[0].stream_options).toEqual({
          include_usage: true,
        });
        expect(requestBodies[1]).not.toHaveProperty('stream_options');
        expect(credentialReadCount).toBe(2);
        expect(authorizationHeaders).toEqual([
          'Bearer sk-current-1',
          'Bearer sk-current-2',
        ]);
        expect(callbackObservedBeforeRetry).toBe(true);
        expect(retryError).toMatchObject({
          code: 'client_error',
          status: 400,
          message: 'Unsupported parameter: stream_options',
        });
      } finally {
        await closeServer(server);
      }
    });

    it('bounds an unsupported stream_options fallback to one retry', async () => {
      const http = await import('http');
      let requestCount = 0;
      const server = http.createServer(async (req, res) => {
        await readRequestBody(req);
        requestCount++;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: 'stream_options is not supported',
            type: 'invalid_request_error',
          },
        }));
      });
      const url = await listenOnLoopback(server);

      try {
        const result = await chatCompletion(
          { baseUrl: url, apiKey: 'sk-test' },
          makeRequest({ stream: true }),
        );
        await expect(
          collectStreamEvents(result as AsyncIterable<LLMStreamEvent>),
        ).rejects.toBeInstanceOf(ClientError);
        expect(requestCount).toBe(2);
      } finally {
        await closeServer(server);
      }
    });

    it('does not retry an unrelated 400 that merely echoes the request', async () => {
      const http = await import('http');
      let requestCount = 0;
      const server = http.createServer(async (req, res) => {
        const request = await readRequestBody(req);
        requestCount++;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: 'max_tokens must be greater than zero',
            type: 'invalid_request_error',
          },
          request,
        }));
      });
      const url = await listenOnLoopback(server);

      try {
        const result = await chatCompletion(
          { baseUrl: url, apiKey: 'sk-test' },
          makeRequest({ stream: true }),
        );
        await expect(
          collectStreamEvents(result as AsyncIterable<LLMStreamEvent>),
        ).rejects.toBeInstanceOf(ClientError);
        expect(requestCount).toBe(1);
      } finally {
        await closeServer(server);
      }
    });

    it('does not retry a successful JSON fallback response', async () => {
      llm.setBehavior('test-model', { behavior: 'non_stream' });

      const result = await chatCompletion(
        endpoint,
        makeRequest({ stream: true }),
      );
      const events = await collectStreamEvents(
        result as AsyncIterable<LLMStreamEvent>,
      );

      expect(events.at(-1)).toMatchObject({
        type: 'done',
        transport: 'json_fallback',
      });
      expect(llm.getRequests()).toHaveLength(1);
      expect(
        (llm.getRequests()[0].body as Record<string, unknown>).stream_options,
      ).toEqual({ include_usage: true });
    });
  });

  // =========================================================================
  // 3. Streaming — tool_call delta merging
  // =========================================================================

  describe('streaming — tool_call delta merging', () => {
    it('accumulates tool_call deltas into complete toolCalls at done', async () => {
      llm.setBehavior('test-model', {
        behavior: 'tool_call',
        stream: true,
      });

      const result = await chatCompletion(endpoint, makeRequest({
        stream: true,
        tools: [
          {
            type: 'function',
            function: {
              name: 'replace_text',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
      }));

      const events = await collectStreamEvents(result as AsyncIterable<LLMStreamEvent>);

      // Should have at least one tool_call_delta
      const toolDeltas = events.filter((e) => e.type === 'tool_call_delta');
      expect(toolDeltas.length).toBeGreaterThan(0);

      // Done event should contain merged toolCalls
      const doneEvent = events.find((e) => e.type === 'done') as
        | { type: 'done'; content: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }
        | undefined;
      expect(doneEvent).toBeDefined();
      expect(doneEvent!.toolCalls).toBeDefined();
      expect(doneEvent!.toolCalls!.length).toBe(1);
      expect(doneEvent!.toolCalls![0].name).toBe('replace_text');

      // Arguments should be valid JSON
      const args = JSON.parse(doneEvent!.toolCalls![0].arguments);
      expect(args.old_string).toBe('original text');
      expect(args.new_string).toBe('replaced text');
    });

    it('merges tool_call arguments delivered in multiple fragments', async () => {
      // Create a custom mock for fragmented tool_call streaming
      // The standard mock sends arguments in one chunk; this test verifies
      // that the client correctly accumulates across multiple chunks.
      // We use a small inline HTTP server for this specific scenario.
      const http = await import('http');
      const multiFragmentServer = http.createServer((_req, res) => {
        const id = 'chatcmpl-frag';
        const created = Math.floor(Date.now() / 1000);

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        const frag1 = {
          id,
          object: 'chat.completion.chunk',
          created,
          model: 'test-model',
          choices: [
            {
              index: 0,
              delta: {
                content: 'Let me ',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_abc',
                    type: 'function',
                    function: { name: 'replace_text', arguments: '' },
                  },
                ],
              },
            },
          ],
        };

        const frag2 = {
          id,
          object: 'chat.completion.chunk',
          created,
          model: 'test-model',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      arguments: '{"old_string": "h',
                    },
                  },
                ],
              },
            },
          ],
        };

        const frag3 = {
          id,
          object: 'chat.completion.chunk',
          created,
          model: 'test-model',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      arguments: 'ello", "new_string": "hi"}',
                    },
                  },
                ],
              },
            },
          ],
        };

        const fragments = [
          `data: ${JSON.stringify(frag1)}\n\n`,
          `data: ${JSON.stringify(frag2)}\n\n`,
          `data: ${JSON.stringify(frag3)}\n\n`,
          `data: [DONE]\n\n`,
        ];

        let i = 0;
        const sendNext = () => {
          if (i < fragments.length) {
            res.write(fragments[i++]);
            setTimeout(sendNext, 5);
          } else {
            res.end();
          }
        };
        sendNext();
      });

      await new Promise<void>((resolve) =>
        multiFragmentServer.listen(0, () => resolve()),
      );
      const addr = multiFragmentServer.address() as { port: number };
      const fragUrl = `http://localhost:${addr.port}`;

      try {
        const result = await chatCompletion(
          { baseUrl: fragUrl, apiKey: 'sk-test' },
          makeRequest({
            stream: true,
            tools: [
              {
                type: 'function',
                function: {
                  name: 'replace_text',
                  parameters: { type: 'object', properties: {} },
                },
              },
            ],
          }),
        );

        const events = await collectStreamEvents(
          result as AsyncIterable<LLMStreamEvent>,
        );

        // Should have text events (from fragment 1 content)
        const textEvents = events.filter((e) => e.type === 'text');
        expect(textEvents.length).toBeGreaterThan(0);

        // Should have multiple tool_call_delta events (one per fragment with tool_calls)
        const toolDeltas = events.filter((e) => e.type === 'tool_call_delta');
        expect(toolDeltas.length).toBeGreaterThanOrEqual(2);

        // Done event should merge all fragments into complete arguments JSON
        const doneEvent = events.find((e) => e.type === 'done') as
          | { type: 'done'; content: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }
          | undefined;
        expect(doneEvent).toBeDefined();
        expect(doneEvent!.toolCalls).toBeDefined();
        expect(doneEvent!.toolCalls!.length).toBe(1);
        expect(doneEvent!.toolCalls![0].name).toBe('replace_text');
        expect(doneEvent!.toolCalls![0].id).toBe('call_abc');

        // Arguments should be valid JSON and complete
        const args = JSON.parse(doneEvent!.toolCalls![0].arguments);
        expect(args.old_string).toBe('hello');
        expect(args.new_string).toBe('hi');
      } finally {
        await new Promise<void>((resolve) =>
          multiFragmentServer.close(() => resolve()),
        );
      }
    });

    it('rejects a tool_calls finish when the accumulated call is incomplete', async () => {
      const http = await import('http');
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end([
          `data: ${JSON.stringify({ choices: [{
            delta: { tool_calls: [{
              index: 0,
              id: 'call_incomplete',
              function: { name: 'replace_text', arguments: '{"old":' },
            }] },
            finish_reason: null,
          }] })}`,
          `data: ${JSON.stringify({ choices: [{
            delta: {},
            finish_reason: 'tool_calls',
          }] })}`,
          'data: [DONE]',
          '',
        ].join('\n\n'));
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address() as { port: number };
      try {
        const result = await chatCompletion(
          { baseUrl: `http://localhost:${address.port}`, apiKey: 'sk-test' },
          makeRequest({ stream: true }),
        );
        await expect(collectStreamEvents(
          result as AsyncIterable<LLMStreamEvent>,
        )).rejects.toMatchObject({
          code: 'incomplete_output',
          message: expect.stringMatching(/incomplete tool calls/i),
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it.each([
      ['JSON array', '[]'],
      ['JSON null', 'null'],
      ['JSON number', '42'],
      ['raw array', []],
      ['raw null', null],
      ['raw number', 42],
    ])('rejects SSE tool arguments that are a %s', async (_label, toolArguments) => {
      const http = await import('http');
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end([
          `data: ${JSON.stringify({ choices: [{
            delta: { tool_calls: [{
              index: 0,
              id: 'call_invalid_shape',
              function: {
                name: 'replace_text',
                arguments: toolArguments,
              },
            }] },
            finish_reason: null,
          }] })}`,
          `data: ${JSON.stringify({ choices: [{
            delta: {},
            finish_reason: 'tool_calls',
          }] })}`,
          'data: [DONE]',
          '',
        ].join('\n\n'));
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address() as { port: number };
      try {
        const result = await chatCompletion(
          { baseUrl: `http://localhost:${address.port}`, apiKey: 'sk-test' },
          makeRequest({ stream: true }),
        );
        await expect(collectStreamEvents(
          result as AsyncIterable<LLMStreamEvent>,
        )).rejects.toMatchObject({
          code: 'incomplete_output',
          message: expect.stringMatching(/incomplete tool calls/i),
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  // =========================================================================
  // 4. Error normalization
  // =========================================================================

  describe('error normalization', () => {
    it('maps 401 to AuthError (non-retryable)', async () => {
      llm.setBehavior('test-model', {
        behavior: 'error',
        status: 401,
        errorMessage: 'Invalid API key',
        errorType: 'invalid_request_error',
        errorCode: 'invalid_api_key',
      });

      await expect(
        chatCompletion(endpoint, makeRequest()),
      ).rejects.toThrow(AuthError);

      try {
        await chatCompletion(endpoint, makeRequest());
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError);
        const e = err as AuthError;
        expect(e.code).toBe('auth_error');
        expect(e.retryable).toBe(false);
        expect(e.status).toBe(401);
        expect(e.message).toContain('Invalid API key');
      }
    });

    it('maps 429 to RateLimitError (retryable)', async () => {
      llm.setBehavior('test-model', {
        behavior: 'error',
        status: 429,
        errorMessage: 'Rate limit exceeded',
        errorType: 'rate_limit_error',
        errorCode: 'rate_limited',
      });

      await expect(
        chatCompletion(endpoint, makeRequest()),
      ).rejects.toThrow(RateLimitError);

      try {
        await chatCompletion(endpoint, makeRequest());
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitError);
        const e = err as RateLimitError;
        expect(e.code).toBe('rate_limit');
        expect(e.retryable).toBe(true);
        expect(e.status).toBe(429);
      }
    });

    it('maps 5xx to ServerError (retryable)', async () => {
      llm.setBehavior('test-model', {
        behavior: 'error',
        status: 500,
        errorMessage: 'Internal server error',
        errorType: 'server_error',
        errorCode: 'internal_error',
      });

      await expect(
        chatCompletion(endpoint, makeRequest()),
      ).rejects.toThrow(ServerError);

      try {
        await chatCompletion(endpoint, makeRequest());
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ServerError);
        const e = err as ServerError;
        expect(e.code).toBe('server_error');
        expect(e.retryable).toBe(true);
        expect(e.status).toBe(500);
      }
    });

    it('maps 503 to ServerError (retryable)', async () => {
      llm.setBehavior('test-model', {
        behavior: 'error',
        status: 503,
        errorMessage: 'Service unavailable',
        errorType: 'server_error',
        errorCode: 'overloaded',
      });

      try {
        await chatCompletion(endpoint, makeRequest());
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ServerError);
        const e = err as ServerError;
        expect(e.code).toBe('server_error');
        expect(e.retryable).toBe(true);
        expect(e.status).toBe(503);
      }
    });

    it('maps other 4xx to ClientError (non-retryable)', async () => {
      llm.setBehavior('test-model', {
        behavior: 'error',
        status: 400,
        errorMessage: 'Bad request: invalid parameter',
        errorType: 'invalid_request_error',
        errorCode: 'bad_request',
      });

      try {
        await chatCompletion(endpoint, makeRequest());
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ClientError);
        const e = err as ClientError;
        expect(e.code).toBe('client_error');
        expect(e.retryable).toBe(false);
        expect(e.status).toBe(400);
      }
    });

    it('maps 404 to ClientError (non-retryable)', async () => {
      llm.setBehavior('test-model', {
        behavior: 'error',
        status: 404,
        errorMessage: 'Model not found',
        errorType: 'invalid_request_error',
        errorCode: 'model_not_found',
      });

      try {
        await chatCompletion(endpoint, makeRequest());
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ClientError);
        const e = err as ClientError;
        expect(e.code).toBe('client_error');
        expect(e.retryable).toBe(false);
        expect(e.status).toBe(404);
      }
    });

    it('handles malformed JSON responses gracefully', async () => {
      llm.setBehavior('test-model', { behavior: 'malformed_json' });

      try {
        await chatCompletion(endpoint, makeRequest());
        // May succeed or throw depending on parsing robustness
      } catch (err) {
        // Should be a ClientError or similar for parse failure
        expect(err).toBeInstanceOf(LLMError);
      }
    });
  });

  // =========================================================================
  // 5. ToolsNotSupportedError
  // =========================================================================

  describe('ToolsNotSupportedError', () => {
    it('throws ToolsNotSupportedError when no_tools_error behavior with tools', async () => {
      llm.setBehavior('test-model', { behavior: 'no_tools_error' });

      await expect(
        chatCompletion(
          endpoint,
          makeRequest({
            tools: [
              {
                type: 'function',
                function: {
                  name: 'test_tool',
                  parameters: { type: 'object', properties: {} },
                },
              },
            ],
          }),
        ),
      ).rejects.toThrow(ToolsNotSupportedError);

      try {
        await chatCompletion(
          endpoint,
          makeRequest({
            tools: [
              {
                type: 'function',
                function: {
                  name: 'test_tool',
                  parameters: { type: 'object', properties: {} },
                },
              },
            ],
          }),
        );
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToolsNotSupportedError);
        const e = err as ToolsNotSupportedError;
        expect(e.code).toBe('tools_not_supported');
        expect(e.retryable).toBe(false);
        expect(e.status).toBe(400);
      }
    });

    it('succeeds when no_tools_error behavior WITHOUT tools', async () => {
      llm.setBehavior('test-model', { behavior: 'no_tools_error' });

      const result = await chatCompletion(endpoint, makeRequest());
      // Should succeed — no tools means the mock returns 200
      expect(isAsyncIterable(result)).toBe(false);
      const resp = result as ChatCompletionResponse;
      expect(resp.content).toBeTruthy();
    });
  });

  // =========================================================================
  // 6. Abort propagation
  // =========================================================================

  describe('abort propagation', () => {
    it('aborts an in-progress streaming request and throws AbortedError', async () => {
      const http = await import('http');
      let resolveProviderReady!: () => void;
      let resolveProviderDisconnected!: () => void;
      const providerReady = new Promise<void>((resolve) => {
        resolveProviderReady = resolve;
      });
      const providerDisconnected = new Promise<void>((resolve) => {
        resolveProviderDisconnected = resolve;
      });
      const server = http.createServer((req, res) => {
        req.resume();
        req.once('end', () => {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.once('close', resolveProviderDisconnected);
          res.write(`data: ${JSON.stringify({
            choices: [{
              index: 0,
              delta: { content: 'first token' },
              finish_reason: null,
            }],
          })}\n\n`);
          resolveProviderReady();
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('abort test server did not bind a TCP port');
      }

      const controller = new AbortController();
      try {
        const result = await chatCompletion(
          {
            baseUrl: `http://127.0.0.1:${address.port}`,
            apiKey: 'sk-test',
          },
          makeRequest({ stream: true, signal: controller.signal }),
        );

        // Attach both fulfillment and rejection handlers before waiting for
        // the provider. This promise can never reject unobserved, even when a
        // busy full-suite worker loses the socket race.
        const outcomePromise = collectStreamEvents(
          result as AsyncIterable<LLMStreamEvent>,
        ).then(
          (events) => ({ status: 'fulfilled' as const, events }),
          (error: unknown) => ({ status: 'rejected' as const, error }),
        );

        await providerReady;
        controller.abort();

        const outcome = await outcomePromise;
        expect(outcome.status).toBe('rejected');
        if (outcome.status !== 'rejected') {
          throw new Error('stream consumption unexpectedly completed');
        }
        expect(outcome.error).toBeInstanceOf(AbortedError);
        const e = outcome.error as AbortedError;
        expect(e.code).toBe('aborted');
        expect(e.retryable).toBe(false);

        await providerDisconnected;
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (
              error &&
              (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
            ) {
              reject(error);
              return;
            }
            resolve();
          });
          server.closeAllConnections();
        });
      }
    });

    it('prioritizes an aborted external signal over an existing stream NetworkError', async () => {
      const controller = new AbortController();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );

      try {
        const result = await chatCompletion(
          endpoint,
          makeRequest({
            stream: true,
            signal: controller.signal,
            onActivity: () => controller.abort(),
          }),
        );

        await expect(
          collectStreamEvents(result as AsyncIterable<LLMStreamEvent>),
        ).rejects.toBeInstanceOf(AbortedError);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('iterator.return aborts the upstream SSE connection', async () => {
      const http = await import('http');
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let resolveDisconnected!: () => void;
      const disconnected = new Promise<void>((resolve) => {
        resolveDisconnected = resolve;
      });
      const server = http.createServer((req, res) => {
        req.resume();
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.on('close', () => {
          if (heartbeat) clearInterval(heartbeat);
          resolveDisconnected();
        });
        res.write(`data: ${JSON.stringify({
          choices: [{
            index: 0,
            delta: { content: 'first token' },
            finish_reason: null,
          }],
        })}\n\n`);
        heartbeat = setInterval(() => {
          if (!res.destroyed) res.write(': keep-alive\n\n');
        }, 20);
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('abort test server did not bind a TCP port');
      }

      try {
        const result = await chatCompletion(
          {
            baseUrl: `http://127.0.0.1:${address.port}`,
            apiKey: 'sk-test',
          },
          makeRequest({
            stream: true,
            timeoutMs: 5_000,
            maxDurationMs: 5_000,
          }),
        );
        const iterator = (
          result as AsyncIterable<LLMStreamEvent>
        )[Symbol.asyncIterator]();
        expect(await iterator.next()).toMatchObject({
          done: false,
          value: { type: 'text', content: 'first token' },
        });

        await expect(iterator.return?.()).resolves.toMatchObject({
          done: true,
        });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            disconnected,
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(
                () => reject(new Error('upstream SSE connection stayed open')),
                1_000,
              );
            }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (
              error &&
              (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
            ) {
              reject(error);
              return;
            }
            resolve();
          });
          server.closeAllConnections();
        });
      }
    });

    it('aborts a non-streaming request and throws AbortedError', async () => {
      llm.setBehavior('test-model', {
        behavior: 'non_stream',
      });

      const controller = new AbortController();
      controller.abort(); // Abort before sending

      await expect(
        chatCompletion(
          endpoint,
          makeRequest({ signal: controller.signal }),
        ),
      ).rejects.toThrow(AbortedError);

      try {
        await chatCompletion(
          endpoint,
          makeRequest({ signal: controller.signal }),
        );
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AbortedError);
      }
    });
  });

  // =========================================================================
  // 7. Non-stream fallback (auto-detect)
  // =========================================================================

  describe('non-stream fallback', () => {
    it('auto-detects JSON response when stream:true is requested', async () => {
      // non_stream behavior returns application/json, not text/event-stream
      llm.setBehavior('test-model', { behavior: 'non_stream' });

      const result = await chatCompletion(endpoint, makeRequest({ stream: true }));

      // Should still return an AsyncIterable (caller expects stream)
      expect(isAsyncIterable(result)).toBe(true);
      const events = await collectStreamEvents(result as AsyncIterable<LLMStreamEvent>);

      // Should emit a text event with the content, then done
      const textEvents = events.filter((e) => e.type === 'text');
      expect(textEvents.length).toBeGreaterThan(0);
      expect(textEvents[0].type).toBe('text');

      const doneEvent = events.find((e) => e.type === 'done');
      expect(doneEvent).toBeDefined();
      if (doneEvent && doneEvent.type === 'done') {
        expect(doneEvent.content).toContain('mock non-streaming');
      }

      // No error should have been thrown
    });

    it('returns usage in done event when falling back from stream', async () => {
      llm.setBehavior('test-model', { behavior: 'non_stream' });

      const result = await chatCompletion(endpoint, makeRequest({ stream: true }));
      const events = await collectStreamEvents(result as AsyncIterable<LLMStreamEvent>);

      const doneEvent = events.find((e) => e.type === 'done') as
        | { type: 'done'; content: string; usage?: Record<string, number> }
        | undefined;
      expect(doneEvent).toBeDefined();
      expect(doneEvent!.usage).toBeDefined();
      expect(doneEvent!.usage!.prompt_tokens).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 8. AbortSignal.any — timeout + external signal merging
  // =========================================================================

  describe('AbortSignal.any merging', () => {
    it('respects external AbortSignal via AbortSignal.any merge', async () => {
      llm.setBehavior('test-model', {
        behavior: 'stream',
        chunkDelayMs: 200,
      });

      const controller = new AbortController();

      const result = await chatCompletion(
        endpoint,
        makeRequest({
          stream: true,
          signal: controller.signal,
          timeoutMs: 5000, // long enough not to trigger
        }),
      );

      // Start consuming to kick off fetch
      const consumePromise = collectStreamEvents(
        result as AsyncIterable<LLMStreamEvent>,
      );

      // Abort externally during streaming
      await new Promise((r) => setTimeout(r, 30));
      controller.abort();

      // Consumption should throw
      await expect(consumePromise).rejects.toThrow(AbortedError);
    });

    it('times out via AbortSignal.timeout when no external signal', async () => {
      llm.setBehavior('test-model', {
        behavior: 'stream',
        chunkDelayMs: 500, // very slow — timeout should fire first
      });

      // Very short timeout — should trigger before streaming completes
      const result = await chatCompletion(
        endpoint,
        makeRequest({
          stream: true,
          timeoutMs: 100,
        }),
      );

      // Start consuming the generator
      const consumePromise = collectStreamEvents(
        result as AsyncIterable<LLMStreamEvent>,
      );

      // Should throw TimeoutError when trying to fetch/stream
      await expect(consumePromise).rejects.toThrow(TimeoutError);

      try {
        await consumePromise;
        expect.fail('Should have thrown');
      } catch (err) {
        // Should be TimeoutError
        expect(err).toBeInstanceOf(TimeoutError);
      }
    });
  });

  // =========================================================================
  // 9. Network errors
  // =========================================================================

  describe('network errors', () => {
    it('throws NetworkError for connection refused', async () => {
      // Connect to a port that should be closed
      await llm.close();
      llm = null!; // prevent afterEach double-close

      await expect(
        chatCompletion(
          { baseUrl: 'http://localhost:1', apiKey: 'sk-test' },
          makeRequest(),
        ),
      ).rejects.toThrow(NetworkError);
    });

    it('throws NetworkError for unreachable host', async () => {
      // Use a non-routable IP with a generous timeout.
      // OS network stack behavior varies — may throw NetworkError or TimeoutError.
      try {
        await chatCompletion(
          { baseUrl: 'http://10.255.255.1:9999', apiKey: 'sk-test' },
          makeRequest({ timeoutMs: 10000 }),
        );
        expect.fail('Should have thrown');
      } catch (err) {
        // Either NetworkError or TimeoutError is acceptable here
        const ok = err instanceof NetworkError || err instanceof TimeoutError;
        expect(ok).toBe(true);
        expect(err).toBeInstanceOf(LLMError);
      }
    }, 15000);
  });

  // =========================================================================
  // 10. Edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('supports custom timeoutMs parameter', async () => {
      llm.setBehavior('test-model', { behavior: 'non_stream' });

      const result = await chatCompletion(endpoint, makeRequest({ timeoutMs: 30000 }));
      expect(isAsyncIterable(result)).toBe(false);
      const resp = result as ChatCompletionResponse;
      expect(resp.content).toBeTruthy();
    });

    it('tracks usage tokens correctly', async () => {
      llm.setBehavior('test-model', { behavior: 'non_stream' });

      const result = await chatCompletion(endpoint, makeRequest());
      const resp = result as ChatCompletionResponse;
      expect(resp.usage).toBeDefined();
      expect(resp.usage!.prompt_tokens).toBe(10);
      expect(resp.usage!.completion_tokens).toBe(5);
      expect(resp.usage!.total_tokens).toBe(15);
    });

    it('rejects a terminal response with neither visible content nor tool calls', async () => {
      llm.setBehavior('test-model', { behavior: 'echo' });

      await expect(chatCompletion(
        endpoint,
        makeRequest({ messages: [{ role: 'user', content: '' }] }),
      )).rejects.toMatchObject({
        code: 'incomplete_output',
        partialContent: '',
      });
    });
  });

  // =========================================================================
  // 11. Reasoning-content stripping (reasoning_content / thinking discarded)
  // =========================================================================

  describe('reasoning-content stripping', () => {
    const LOOPBACK_HOST = '127.0.0.1';

    function listenOnLoopback(server: import('http').Server): Promise<string> {
      return new Promise((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once('error', onError);
        server.listen(0, LOOPBACK_HOST, () => {
          server.off('error', onError);
          const address = server.address();
          if (!address || typeof address === 'string') {
            reject(new Error('reasoning test server did not bind a TCP port'));
            return;
          }
          resolve(`http://${LOOPBACK_HOST}:${address.port}`);
        });
      });
    }

    function closeTestServer(server: import('http').Server): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (
            error &&
            (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
          ) {
            reject(error);
            return;
          }
          resolve();
        });
        // Undici keeps completed SSE connections alive for reuse. Closing the
        // listener alone can therefore leave each test waiting several seconds
        // and, under the full parallel suite, accumulate enough loopback
        // sockets to make a later fetch fail before it reaches the fixture.
        server.closeAllConnections();
      });
    }

    /** Start an inline HTTP server that returns a non-streaming response
     *  carrying both `content` and a reasoning field. */
    async function startReasoningNonStreamServer(
      reasoningField: 'reasoning_content' | 'thinking' | 'reasoning',
    ): Promise<{ url: string; close: () => Promise<void> }> {
      const http = await import('http');
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-reasoning',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'test-model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'Final answer to the user.',
                [reasoningField]: 'Let me think through this step by step…',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }));
      });
      const url = await listenOnLoopback(server);
      return {
        url,
        close: () => closeTestServer(server),
      };
    }

    /** Start an inline HTTP server that streams SSE deltas carrying both
     *  `content` deltas and a reasoning field deltas. */
    async function startReasoningStreamServer(
      reasoningField: 'reasoning_content' | 'thinking' | 'reasoning',
    ): Promise<{ url: string; close: () => Promise<void> }> {
      const http = await import('http');
      const server = http.createServer((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const id = 'chatcmpl-stream-reasoning';
        const created = Math.floor(Date.now() / 1000);
        const mk = (delta: Record<string, unknown>) => ({
          id,
          object: 'chat.completion.chunk',
          created,
          model: 'test-model',
          choices: [{ index: 0, delta, finish_reason: null }],
        });
        const fragments = [
          `data: ${JSON.stringify(mk({ [reasoningField]: 'Internal reasoning chunk 1.' }))}\n\n`,
          `data: ${JSON.stringify(mk({ [reasoningField]: 'Internal reasoning chunk 2.' }))}\n\n`,
          `data: ${JSON.stringify(mk({ content: 'Hello' }))}\n\n`,
          `data: ${JSON.stringify(mk({ content: ' world' }))}\n\n`,
          `data: ${JSON.stringify(mk({}))}\n\n`,
          `data: [DONE]\n\n`,
        ];
        let i = 0;
        const sendNext = () => {
          if (i < fragments.length) {
            res.write(fragments[i++]);
            setTimeout(sendNext, 1);
          } else {
            res.end();
          }
        };
        sendNext();
      });
      const url = await listenOnLoopback(server);
      return {
        url,
        close: () => closeTestServer(server),
      };
    }

    async function startSlowReasoningStreamServer(): Promise<{
      url: string;
      close: () => Promise<void>;
    }> {
      const http = await import('http');
      const timers = new Set<ReturnType<typeof setTimeout>>();
      const server = http.createServer((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        let index = 0;
        const send = () => {
          if (res.destroyed) return;
          if (index < 4) {
            const payload = {
              choices: [{
                index: 0,
                delta: { reasoning_content: `private-${index}` },
                finish_reason: null,
              }],
            };
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
            index++;
            const timer = setTimeout(send, 60);
            timers.add(timer);
            return;
          }
          res.write(`data: ${JSON.stringify({
            choices: [{
              index: 0,
              delta: { content: 'Visible result' },
              finish_reason: null,
            }],
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        };
        send();
      });
      const url = await listenOnLoopback(server);
      return {
        url,
        close: () => {
          for (const timer of timers) clearTimeout(timer);
          return closeTestServer(server);
        },
      };
    }

    async function startReasoningOnlyStreamServer(): Promise<{
      url: string;
      close: () => Promise<void>;
    }> {
      const http = await import('http');
      const server = http.createServer((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.end([
          `data: ${JSON.stringify({ choices: [{
            index: 0,
            delta: {
              reasoning_content: 'private-a',
              thinking: 'private-b',
              reasoning: 'private-c',
            },
            finish_reason: null,
          }] })}`,
          `data: ${JSON.stringify({ choices: [{
            index: 0,
            delta: {},
            finish_reason: 'stop',
          }] })}`,
          `data: ${JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
          })}`,
          'data: [DONE]',
          '',
        ].join('\n\n'));
      });
      const url = await listenOnLoopback(server);
      return { url, close: () => closeTestServer(server) };
    }

    it('nonStreamCompletion with reasoning_content → only content returned', async () => {
      const srv = await startReasoningNonStreamServer('reasoning_content');
      try {
        const result = await chatCompletion(
          { baseUrl: srv.url, apiKey: 'sk-test' },
          makeRequest(),
        );
        expect(isAsyncIterable(result)).toBe(false);
        const resp = result as ChatCompletionResponse;
        expect(resp.content).toBe('Final answer to the user.');
        // Reasoning content must NOT leak into the response
        expect(resp.content).not.toContain('Let me think');
        expect((resp as unknown as Record<string, unknown>).reasoning_content).toBeUndefined();
        expect(resp.providerDiagnostics).toEqual({
          reasoningFields: ['reasoning_content'],
          reasoningChunks: 1,
          reasoningCharacters: 'Let me think through this step by step…'.length,
        });
      } finally {
        await srv.close();
      }
    });

    it('nonStreamCompletion with `thinking` field → only content returned', async () => {
      const srv = await startReasoningNonStreamServer('thinking');
      try {
        const result = await chatCompletion(
          { baseUrl: srv.url, apiKey: 'sk-test' },
          makeRequest(),
        );
        const resp = result as ChatCompletionResponse;
        expect(resp.content).toBe('Final answer to the user.');
        expect(resp.content).not.toContain('Let me think');
        expect((resp as unknown as Record<string, unknown>).thinking).toBeUndefined();
      } finally {
        await srv.close();
      }
    });

    it('streamCompletion SSE with reasoning_content → content accumulated, reasoning stripped', async () => {
      const srv = await startReasoningStreamServer('reasoning_content');
      try {
        const result = await chatCompletion(
          { baseUrl: srv.url, apiKey: 'sk-test' },
          makeRequest({ stream: true }),
        );
        expect(isAsyncIterable(result)).toBe(true);
        const events = await collectStreamEvents(result as AsyncIterable<LLMStreamEvent>);

        // All text events should be content-only — no reasoning fragments
        const textEvents = events.filter((e) => e.type === 'text');
        expect(textEvents.length).toBeGreaterThan(0);
        for (const e of textEvents) {
          const txt = (e as { type: 'text'; content: string }).content;
          expect(txt).not.toContain('Internal reasoning');
        }

        // done event should have accumulated CONTENT only (not reasoning)
        const doneEvent = events.find((e) => e.type === 'done') as
          | { type: 'done'; content: string }
          | undefined;
        expect(doneEvent).toBeDefined();
        expect(doneEvent!.content).toBe('Hello world');
        expect(doneEvent!.content).not.toContain('Internal reasoning');
        expect((doneEvent as Extract<LLMStreamEvent, { type: 'done' }>).providerDiagnostics)
          .toEqual({
            reasoningFields: ['reasoning_content'],
            reasoningChunks: 2,
            reasoningCharacters:
              'Internal reasoning chunk 1.'.length +
              'Internal reasoning chunk 2.'.length,
          });
      } finally {
        await srv.close();
      }
    });

    it('streamCompletion SSE with `thinking` field → content accumulated, reasoning stripped', async () => {
      const srv = await startReasoningStreamServer('thinking');
      try {
        const result = await chatCompletion(
          { baseUrl: srv.url, apiKey: 'sk-test' },
          makeRequest({ stream: true }),
        );
        const events = await collectStreamEvents(result as AsyncIterable<LLMStreamEvent>);

        const doneEvent = events.find((e) => e.type === 'done') as
          | { type: 'done'; content: string }
          | undefined;
        expect(doneEvent).toBeDefined();
        expect(doneEvent!.content).toBe('Hello world');
        expect(doneEvent!.content).not.toContain('Internal reasoning');

        // No text event should carry reasoning fragments
        for (const e of events) {
          if (e.type === 'text') {
            expect((e as { content: string }).content).not.toContain('Internal reasoning');
          }
        }
      } finally {
        await srv.close();
      }
    });

    it('reasoning activity keeps a stream alive past the idle timeout', async () => {
      const srv = await startSlowReasoningStreamServer();
      const activity: number[] = [];
      try {
        const result = await chatCompletion(
          { baseUrl: srv.url, apiKey: 'sk-test' },
          makeRequest({
            stream: true,
            timeoutMs: 100,
            maxDurationMs: 2_000,
            onActivity: () => activity.push(Date.now()),
          }),
        );
        const events = await collectStreamEvents(
          result as AsyncIterable<LLMStreamEvent>,
        );
        const done = events.find((event) => event.type === 'done');
        expect(done).toMatchObject({ type: 'done', content: 'Visible result' });
        expect(activity.length).toBeGreaterThanOrEqual(4);
        expect(JSON.stringify(events)).not.toContain('private-');
      } finally {
        await srv.close();
      }
    });

    it('rejects reasoning/usage-only completion with safe shape diagnostics', async () => {
      const srv = await startReasoningOnlyStreamServer();
      try {
        const result = await chatCompletion(
          { baseUrl: srv.url, apiKey: 'sk-test' },
          makeRequest({ stream: true }),
        );
        let caught: unknown;
        try {
          await collectStreamEvents(result as AsyncIterable<LLMStreamEvent>);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(IncompleteOutputError);
        const incomplete = caught as IncompleteOutputError;
        expect(incomplete.code).toBe('incomplete_output');
        expect(incomplete.partialContent).toBe('');
        expect(incomplete.message).toMatch(/reasoning.*no visible content/i);
        expect(incomplete.providerDiagnostics).toEqual({
          reasoningFields: ['reasoning_content', 'thinking', 'reasoning'],
          reasoningChunks: 3,
          reasoningCharacters: 27,
        });
        expect(JSON.stringify({
          message: incomplete.message,
          providerDiagnostics: incomplete.providerDiagnostics,
        })).not.toContain('private-');
      } finally {
        await srv.close();
      }
    });

    it('enforces an absolute hard cap even when reasoning stays active', async () => {
      const srv = await startSlowReasoningStreamServer();
      try {
        const result = await chatCompletion(
          { baseUrl: srv.url, apiKey: 'sk-test' },
          makeRequest({
            stream: true,
            timeoutMs: 100,
            maxDurationMs: 150,
          }),
        );
        await expect(
          collectStreamEvents(result as AsyncIterable<LLMStreamEvent>),
        ).rejects.toThrow('maximum duration');
      } finally {
        await srv.close();
      }
    });

    it('does not expand a shorter hard cap to match a longer idle timeout', async () => {
      const srv = await startSlowReasoningStreamServer();
      try {
        const result = await chatCompletion(
          { baseUrl: srv.url, apiKey: 'sk-test' },
          makeRequest({
            stream: true,
            timeoutMs: 1_000,
            maxDurationMs: 150,
          }),
        );
        await expect(
          collectStreamEvents(result as AsyncIterable<LLMStreamEvent>),
        ).rejects.toThrow('maximum duration');
      } finally {
        await srv.close();
      }
    });
  });
});
