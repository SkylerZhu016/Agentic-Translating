/**
 * LLM Client tests — TDD for Wave 2 Task 8
 *
 * Tests the OpenAI-compatible chatCompletion client against the mock-llm fixture.
 * Covers: non-streaming, streaming text, streaming tool_call delta merging,
 * error normalization, ToolsNotSupportedError, abort propagation,
 * non-stream fallback, AbortSignal.any merging, network errors.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
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

    it('echoes user message content', async () => {
      llm.setBehavior('test-model', { behavior: 'echo' });

      const result = await chatCompletion(endpoint, makeRequest({
        messages: [{ role: 'user', content: 'Echo this back' }],
      }));

      expect(isAsyncIterable(result)).toBe(false);
      const resp = result as ChatCompletionResponse;
      expect(resp.content).toBe('Echo this back');
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
      llm.setBehavior('test-model', {
        behavior: 'stream',
        chunkDelayMs: 100, // slow enough to abort mid-stream
      });

      const controller = new AbortController();

      const result = await chatCompletion(
        endpoint,
        makeRequest({ stream: true, signal: controller.signal }),
      );

      // Start consuming the async generator (this kicks off the fetch)
      const consumePromise = collectStreamEvents(
        result as AsyncIterable<LLMStreamEvent>,
      );

      // Abort after a short delay (during streaming)
      await new Promise((r) => setTimeout(r, 30));
      controller.abort();

      // The consumption should now throw AbortedError
      await expect(consumePromise).rejects.toThrow(AbortedError);

      try {
        await consumePromise;
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AbortedError);
        const e = err as AbortedError;
        expect(e.code).toBe('aborted');
        expect(e.retryable).toBe(false);
      }

      // Verify the mock server received the request (connection was made)
      const requests = llm.getRequests();
      expect(requests.length).toBe(1);
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

    it('handles empty messages array gracefully', async () => {
      llm.setBehavior('test-model', { behavior: 'echo' });

      const result = await chatCompletion(
        endpoint,
        makeRequest({ messages: [{ role: 'user', content: '' }] }),
      );
      const resp = result as ChatCompletionResponse;

      // Echo of empty content should be empty
      expect(resp.content).toBe('');
    });
  });
});
