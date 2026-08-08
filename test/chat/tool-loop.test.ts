/**
 * Chat Tool Loop tests — TDD for Wave 2 Task 12
 *
 * Tests runChatTurn against the mock-llm fixture and custom inline servers
 * for multi-round scenarios.
 *
 * Coverage:
 *   - Pure message (no tool_calls) → kind:'message', text untouched
 *   - Successful tool_call (single + multiple edits) → kind:'edited'
 *   - Streaming tool_call → callbacks fire during stream, final done has toolCalls
 *   - Ambiguous match → error injection → second round success (self-correction)
 *   - Not found → error injection → self-correction
 *   - ToolsNotSupportedError → protocol fallback → JSON fence success
 *   - Loop exhausted → chat_loop_exhausted after CHAT_LOOP_MAX failures
 *   - Batch transactional: one edit fails → rollback + error injection
 */

import { describe, it, expect, afterEach, beforeEach, beforeAll } from 'vitest';
import http from 'http';
import { startMockLLM, type MockLLMInstance } from '../fixtures/mock-llm';
import type { ChatTurnResult } from '../../src/lib/chat/tool-loop';

// ---------------------------------------------------------------------------
// Type narrowing helpers
// ---------------------------------------------------------------------------

function okMsg(r: ChatTurnResult): { ok: true; kind: 'message'; text: string } {
  if (!r.ok || r.kind !== 'message') throw new Error('Expected kind:message');
  return r;
}

function okEdit(r: ChatTurnResult): { ok: true; kind: 'edited'; newText: string; diffSummary: string } {
  if (!r.ok || r.kind !== 'edited') throw new Error('Expected kind:edited');
  return r;
}

function fail(r: ChatTurnResult): ChatTurnResult & { ok: false } {
  if (r.ok) throw new Error('Expected ok:false');
  return r;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ToolLoopTestContext {
  llm: MockLLMInstance;
  endpoint: { baseUrl: string; apiKey: string };
}

function makeMessages(
  overrides?: Array<{ role: string; content: string }>,
): Array<{ role: string; content: string }> {
  return overrides ?? [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Please edit the text.' },
  ];
}

// ---------------------------------------------------------------------------
// Inline custom HTTP server factory for multi-round tests
// ---------------------------------------------------------------------------

type RoundHandler = (
  round: number,
  body: Record<string, unknown>,
) => { status: number; body: unknown; headers?: Record<string, string> };

function startRoundServer(handler: RoundHandler): Promise<{
  url: string;
  close: () => Promise<void>;
  requestCount: () => number;
}> {
  return new Promise((resolve) => {
    let count = 0;
    const server = http.createServer((req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        count++;
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        } catch { /* ignore */ }

        const result = handler(count, body);

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          ...result.headers,
        };
        res.writeHead(result.status, headers);
        res.end(JSON.stringify(result.body));
      });
    });

    server.listen(0, () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://localhost:${addr.port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
        requestCount: () => count,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runChatTurn', () => {
  let runChatTurn: typeof import('../../src/lib/chat/tool-loop').runChatTurn;

  beforeAll(async () => {
    const mod = await import('../../src/lib/chat/tool-loop');
    runChatTurn = mod.runChatTurn;
  });

  // =========================================================================
  // 1. Pure message — no tool_calls
  // =========================================================================

  describe('pure message (no tool_calls)', () => {
    let ctx: ToolLoopTestContext;

    beforeEach(async () => {
      const llm = await startMockLLM();
      llm.setBehavior('test-model', { behavior: 'echo' });
      ctx = { llm, endpoint: { baseUrl: llm.url, apiKey: 'sk-test' } };
    });

    afterEach(async () => {
      await ctx.llm.close();
    });

    it('returns kind:message with text, onDelta called', async () => {
      const deltas: string[] = [];
      const result = await runChatTurn({
        endpoint: ctx.endpoint,
        model: 'test-model',
        messages: makeMessages(),
        currentText: 'original text',
        callbacks: { onDelta: (text) => deltas.push(text) },
      });

      const r = okMsg(result);
      expect(r.text).toBeDefined();
      expect(r.text.length).toBeGreaterThan(0);
      expect(deltas.length).toBeGreaterThan(0);
    });

    it('onDelta receives all text chunks', async () => {
      const deltas: string[] = [];
      await runChatTurn({
        endpoint: ctx.endpoint,
        model: 'test-model',
        messages: makeMessages([{ role: 'user', content: 'Hello world' }]),
        currentText: 'irrelevant',
        callbacks: { onDelta: (text) => deltas.push(text) },
      });

      const fullText = deltas.join('');
      expect(fullText).toContain('Hello world');
    });

    it('works without callbacks', async () => {
      const result = await runChatTurn({
        endpoint: ctx.endpoint,
        model: 'test-model',
        messages: makeMessages(),
        currentText: 'some text',
      });

      const r = okMsg(result);
    });
  });

  // =========================================================================
  // 2. Successful tool_call — single + multiple replacements
  // =========================================================================

  describe('successful tool_call', () => {
    let ctx: ToolLoopTestContext;

    beforeEach(async () => {
      const llm = await startMockLLM();
      ctx = { llm, endpoint: { baseUrl: llm.url, apiKey: 'sk-test' } };
    });

    afterEach(async () => {
      await ctx.llm.close();
    });

    it('single tool_call replaces text and returns kind:edited', async () => {
      ctx.llm.setBehavior('test-model', { behavior: 'tool_call', stream: false });

      const currentText = 'This is original text here.';
      const onToolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
      const onToolResults: Array<{ ok: boolean }> = [];

      const result = await runChatTurn({
        endpoint: ctx.endpoint,
        model: 'test-model',
        messages: makeMessages(),
        currentText,
        callbacks: {
          onToolCall: (name, args) => onToolCalls.push({ name, args }),
          onToolResult: (ok) => onToolResults.push({ ok }),
        },
      });

      const r = okEdit(result);
      expect(r.newText).toBe('This is replaced text here.');
      expect(r.diffSummary).toBeDefined();
      expect(r.diffSummary).toContain('original text');
      expect(r.diffSummary).toContain('replaced text');

      expect(onToolCalls.length).toBe(1);
      expect(onToolCalls[0].name).toBe('replace_text');
      expect(onToolCalls[0].args.old_string).toBe('original text');
      expect(onToolCalls[0].args.new_string).toBe('replaced text');
      expect(onToolResults.length).toBe(1);
      expect(onToolResults[0].ok).toBe(true);
    });

    it('multiple tool_calls in one response → batch applied', async () => {
      const server = await startRoundServer((_round, _body) => ({
        status: 200,
        body: {
          id: 'chatcmpl-batch',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'test-model',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: 'Making changes.',
              tool_calls: [
                {
                  id: 'call_1', type: 'function',
                  function: { name: 'replace_text', arguments: JSON.stringify({ old_string: 'first', new_string: '1st' }) },
                },
                {
                  id: 'call_2', type: 'function',
                  function: { name: 'replace_text', arguments: JSON.stringify({ old_string: 'second', new_string: '2nd' }) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      }));

      try {
        const result = await runChatTurn({
          endpoint: { baseUrl: server.url, apiKey: 'sk-test' },
          model: 'test-model',
          messages: makeMessages(),
          currentText: 'first part and second part',
        });

        const r = okEdit(result);
          expect(r.newText).toBe('1st part and 2nd part');
      } finally {
        await server.close();
      }
    });

    it('tool_call with no-op (old==new) is skipped', async () => {
      const server = await startRoundServer((_round, _body) => ({
        status: 200,
        body: {
          id: 'chatcmpl-noop',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'test-model',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: 'No change needed.',
              tool_calls: [
                {
                  id: 'call_noop', type: 'function',
                  function: { name: 'replace_text', arguments: JSON.stringify({ old_string: 'hello', new_string: 'hello' }) },
                },
                {
                  id: 'call_real', type: 'function',
                  function: { name: 'replace_text', arguments: JSON.stringify({ old_string: 'world', new_string: 'earth' }) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      }));

      try {
        const result = await runChatTurn({
          endpoint: { baseUrl: server.url, apiKey: 'sk-test' },
          model: 'test-model',
          messages: makeMessages(),
          currentText: 'hello world',
        });

        const r = okEdit(result);
          expect(r.newText).toBe('hello earth');
      } finally {
        await server.close();
      }
    });
  });

  // =========================================================================
  // 3. Streaming tool_call
  // =========================================================================

  describe('streaming tool_call', () => {
    let ctx: ToolLoopTestContext;

    beforeEach(async () => {
      const llm = await startMockLLM();
      ctx = { llm, endpoint: { baseUrl: llm.url, apiKey: 'sk-test' } };
    });

    afterEach(async () => {
      await ctx.llm.close();
    });

    it('streaming tool_call fires onDelta and succeeds with kind:edited', async () => {
      ctx.llm.setBehavior('test-model', { behavior: 'tool_call', stream: true });

      const deltas: string[] = [];
      const result = await runChatTurn({
        endpoint: ctx.endpoint,
        model: 'test-model',
        messages: makeMessages(),
        currentText: 'This is original text.',
        callbacks: { onDelta: (text) => deltas.push(text) },
        stream: true,
      });

      const r = okEdit(result);
      expect(r.newText).toBe('This is replaced text.');
      expect(deltas.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 4. Self-correction: ambiguous match
  // =========================================================================

  describe('self-correction: ambiguous', () => {
    it('ambiguous → error injection → second round succeeds', async () => {
      const server = await startRoundServer((round, body) => {
        const msgs = (body.messages as Array<{ role: string; content: string }>) ?? [];

        if (round === 1) {
          return {
            status: 200,
            body: {
              id: 'chatcmpl-amb-1',
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: 'test-model',
              choices: [{
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'Let me replace X.',
                  tool_calls: [{
                    id: 'call_amb', type: 'function',
                    function: { name: 'replace_text', arguments: JSON.stringify({ old_string: 'X', new_string: 'Z' }) },
                  }],
                },
                finish_reason: 'tool_calls',
              }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            },
          };
        }

        const hasToolError = msgs.some((m) => m.role === 'tool' && m.content?.includes('ambiguous'));
        expect(hasToolError).toBe(true);

        return {
          status: 200,
          body: {
            id: 'chatcmpl-amb-2',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'test-model',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: 'Let me be more specific.',
                tool_calls: [{
                  id: 'call_fix', type: 'function',
                  function: { name: 'replace_text', arguments: JSON.stringify({ old_string: 'X Y X', new_string: 'Z Y Z' }) },
                }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 },
          },
        };
      });

      try {
        const result = await runChatTurn({
          endpoint: { baseUrl: server.url, apiKey: 'sk-test' },
          model: 'test-model',
          messages: makeMessages(),
          currentText: 'X Y X',
        });

        const r = okEdit(result);
          expect(r.newText).toBe('Z Y Z');
        expect(server.requestCount()).toBe(2);
      } finally {
        await server.close();
      }
    });
  });

  // =========================================================================
  // 5. Self-correction: not_found
  // =========================================================================

  describe('self-correction: not_found', () => {
    it('not_found → error injection → second round succeeds', async () => {
      const server = await startRoundServer((round, body) => {
        const msgs = (body.messages as Array<{ role: string; content: string }>) ?? [];

        if (round === 1) {
          return {
            status: 200,
            body: {
              id: 'chatcmpl-nf-1',
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: 'test-model',
              choices: [{
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'I will replace that.',
                  tool_calls: [{
                    id: 'call_nf', type: 'function',
                    function: { name: 'replace_text', arguments: JSON.stringify({ old_string: 'nonexistent phrase', new_string: 'something else' }) },
                  }],
                },
                finish_reason: 'tool_calls',
              }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            },
          };
        }

        const hasToolError = msgs.some((m) => m.role === 'tool' && m.content?.includes('not found'));
        expect(hasToolError).toBe(true);

        return {
          status: 200,
          body: {
            id: 'chatcmpl-nf-2',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'test-model',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: 'Sorry, let me use the correct text.',
                tool_calls: [{
                  id: 'call_fix', type: 'function',
                  function: { name: 'replace_text', arguments: JSON.stringify({ old_string: 'hello', new_string: 'hi' }) },
                }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 },
          },
        };
      });

      try {
        const result = await runChatTurn({
          endpoint: { baseUrl: server.url, apiKey: 'sk-test' },
          model: 'test-model',
          messages: makeMessages(),
          currentText: 'hello world',
        });

        const r = okEdit(result);
          expect(r.newText).toBe('hi world');
        expect(server.requestCount()).toBe(2);
      } finally {
        await server.close();
      }
    });
  });

  // =========================================================================
  // 6. Protocol fallback: ToolsNotSupportedError → JSON fence
  // =========================================================================

  describe('protocol fallback: JSON fence', () => {
    it('fallback JSON fence path completes replacement', async () => {
      const server = await startRoundServer((round, body) => {
        const hasTools =
          Array.isArray((body as Record<string, unknown>).tools) &&
          ((body as Record<string, unknown>).tools as unknown[]).length > 0;

        if (round === 1 && hasTools) {
          return {
            status: 400,
            body: { error: { message: 'tools is not supported', type: 'invalid_request_error', code: 'unsupported_tools' } },
          };
        }

        return {
          status: 200,
          body: {
            id: 'chatcmpl-fence',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'test-model',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: 'I will make the change.\n\n```json\n{"old_string": "hello", "new_string": "hi"}\n```\n\nDone.',
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
          },
        };
      });

      let fallbackCalled = false;

      try {
        const result = await runChatTurn({
          endpoint: { baseUrl: server.url, apiKey: 'sk-test' },
          model: 'test-model',
          messages: makeMessages(),
          currentText: 'hello world',
          callbacks: { onProtocolFallback: () => { fallbackCalled = true; } },
        });

        expect(fallbackCalled).toBe(true);
        const r = okEdit(result);
          expect(r.newText).toBe('hi world');
        expect(server.requestCount()).toBe(2);
      } finally {
        await server.close();
      }
    });

    it('fallback with multiple JSON fence blocks → batch applied', async () => {
      const server = await startRoundServer((round, body) => {
        const hasTools =
          Array.isArray((body as Record<string, unknown>).tools) &&
          ((body as Record<string, unknown>).tools as unknown[]).length > 0;

        if (round === 1 && hasTools) {
          return {
            status: 400,
            body: { error: { message: 'tools not supported', type: 'invalid_request_error', code: 'unsupported_tools' } },
          };
        }

        return {
          status: 200,
          body: {
            id: 'chatcmpl-multi-fence',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'test-model',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content:
                  'Changes:\n\n```json\n{"old_string": "A", "new_string": "X"}\n```\n\n```json\n{"old_string": "B", "new_string": "Y"}\n```\n',
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
          },
        };
      });

      try {
        const result = await runChatTurn({
          endpoint: { baseUrl: server.url, apiKey: 'sk-test' },
          model: 'test-model',
          messages: makeMessages(),
          currentText: 'A and B',
        });

        const r = okEdit(result);
          expect(r.newText).toBe('X and Y');
        expect(server.requestCount()).toBe(2);
      } finally {
        await server.close();
      }
    });

    it('fallback JSON fence with invalid JSON → error injected, loop continues', async () => {
      const server = await startRoundServer((round, body) => {
        const hasTools =
          Array.isArray((body as Record<string, unknown>).tools) &&
          ((body as Record<string, unknown>).tools as unknown[]).length > 0;

        if (round === 1 && hasTools) {
          return {
            status: 400,
            body: { error: { message: 'tools not supported', type: 'invalid_request_error', code: 'unsupported_tools' } },
          };
        }

        if (round === 2) {
          return {
            status: 200,
            body: {
              id: 'chatcmpl-bad-fence',
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: 'test-model',
              choices: [{
                index: 0,
                message: { role: 'assistant', content: '```json\n{not valid json}\n```' },
                finish_reason: 'stop',
              }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            },
          };
        }

        return {
          status: 200,
          body: {
            id: 'chatcmpl-good-fence',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'test-model',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: '```json\n{"old_string": "hello", "new_string": "hi"}\n```' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
        };
      });

      try {
        const result = await runChatTurn({
          endpoint: { baseUrl: server.url, apiKey: 'sk-test' },
          model: 'test-model',
          messages: makeMessages(),
          currentText: 'hello world',
        });

        const r = okEdit(result);
          expect(r.newText).toBe('hi world');
      } finally {
        await server.close();
      }
    });
  });

  // =========================================================================
  // 7. Bounded correction
  // =========================================================================

  describe('bounded edit correction', () => {
    it('stops after one failed correction instead of spending the full tool loop', async () => {
      const server = await startRoundServer((_round, _body) => ({
        status: 200,
        body: {
          id: 'chatcmpl-always-amb',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'test-model',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: 'Let me try...',
              tool_calls: [{
                id: `call_amb_${Date.now()}`, type: 'function',
                function: { name: 'replace_text', arguments: JSON.stringify({ old_string: 'X', new_string: 'Z' }) },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      }));

      try {
        const result = await runChatTurn({
          endpoint: { baseUrl: server.url, apiKey: 'sk-test' },
          model: 'test-model',
          messages: makeMessages(),
          currentText: 'X Y X',
        });

        const r = fail(result);
        expect(r.code).toBe('chat_edit_correction_failed');
        expect(server.requestCount()).toBe(2);
      } finally {
        await server.close();
      }
    });

    it('tools_not_supported followed by all invalid JSON fences → exhausted', async () => {
      const server = await startRoundServer((round, body) => {
        const hasTools =
          Array.isArray((body as Record<string, unknown>).tools) &&
          ((body as Record<string, unknown>).tools as unknown[]).length > 0;

        if (round === 1 && hasTools) {
          return {
            status: 400,
            body: { error: { message: 'tools not supported', type: 'invalid_request_error', code: 'unsupported_tools' } },
          };
        }

        return {
          status: 200,
          body: {
            id: `chatcmpl-bad-${round}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'test-model',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: '```json\n{broken\n```' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
        };
      });

      try {
        const result = await runChatTurn({
          endpoint: { baseUrl: server.url, apiKey: 'sk-test' },
          model: 'test-model',
          messages: makeMessages(),
          currentText: 'hello world',
        });

        const r = fail(result);
        expect(r.code).toBe('chat_loop_exhausted');
      } finally {
        await server.close();
      }
    });
  });

  // =========================================================================
  // 8. Batch transactional: one failure rolls back all
  // =========================================================================

  describe('batch transactional', () => {
    it('one edit fails in batch → entire batch rolled back, error injected', async () => {
      const server = await startRoundServer((round, body) => {
        const msgs = (body.messages as Array<{ role: string; content: string }>) ?? [];

        if (round === 1) {
          return {
            status: 200,
            body: {
              id: 'chatcmpl-batch-fail-1',
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: 'test-model',
              choices: [{
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'I will make two changes.',
                  tool_calls: [
                    {
                      id: 'call_a', type: 'function',
                      function: { name: 'replace_text', arguments: JSON.stringify({ old_string: 'first', new_string: '1st' }) },
                    },
                    {
                      id: 'call_b', type: 'function',
                      function: { name: 'replace_text', arguments: JSON.stringify({ old_string: 'nonexistent', new_string: 'X' }) },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            },
          };
        }

        const hasToolError = msgs.some((m) => m.role === 'tool' && m.content?.includes('not found'));
        expect(hasToolError).toBe(true);

        return {
          status: 200,
          body: {
            id: 'chatcmpl-batch-fix',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'test-model',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: 'Fixed.',
                tool_calls: [{
                  id: 'call_fix', type: 'function',
                  function: { name: 'replace_text', arguments: JSON.stringify({ old_string: 'first', new_string: '1st' }) },
                }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
          },
        };
      });

      try {
        const result = await runChatTurn({
          endpoint: { baseUrl: server.url, apiKey: 'sk-test' },
          model: 'test-model',
          messages: makeMessages(),
          currentText: 'first text here',
        });

        const r = okEdit(result);
          expect(r.newText).toBe('1st text here');
        expect(server.requestCount()).toBe(2);
      } finally {
        await server.close();
      }
    });
  });

  // =========================================================================
  // 9. Unknown tool call name → ignored, treated as message
  // =========================================================================

  describe('unknown tool call name', () => {
    it('backfills unknown tool results and continues the loop until a message arrives', async () => {
      let secondRequestTools: unknown = null
      const server = await startRoundServer((round, body) => {
        if (round === 1) {
          return {
            status: 200,
            body: {
              id: 'chatcmpl-unknown',
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: 'test-model',
              choices: [{
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'I want to use a different tool.',
                  tool_calls: [{
                    id: 'call_other', type: 'function',
                    function: { name: 'some_other_tool', arguments: JSON.stringify({ key: 'value' }) },
                  }],
                },
                finish_reason: 'tool_calls',
              }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            },
          };
        }
        // Round 2: model replies with a plain message after seeing the tool result
        secondRequestTools = (body.messages as Array<{ role: string }>).filter((m) => m.role === 'tool');
        return {
          status: 200,
          body: {
            id: 'chatcmpl-msg',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'test-model',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: 'OK, no such tool. Here is my answer.',
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
        };
      });

      try {
        const result = await runChatTurn({
          endpoint: { baseUrl: server.url, apiKey: 'sk-test' },
          model: 'test-model',
          messages: makeMessages(),
          currentText: 'hello world',
        });

        const r = okMsg(result);
        expect(r.text).toContain('Here is my answer');
        // Unknown tool got a stable backfill so the model could continue
        expect(secondRequestTools).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: 'tool',
              tool_call_id: 'call_other',
              content: 'Unknown tool — ignored.',
            }),
          ]),
        );
      } finally {
        await server.close();
      }
    });
  });

  // =========================================================================
  // 10. Edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('rejects mixed programming and translation tools before applying side effects', async () => {
      const server = await startRoundServer(() => ({
        status: 200,
        body: {
          id: 'chatcmpl-mixed-tools',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'test-model',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: 'mixed batch',
              tool_calls: [
                {
                  id: 'call_read', type: 'function',
                  function: { name: 'file_read', arguments: JSON.stringify({ path: 'missing.txt' }) },
                },
                {
                  id: 'call_edit', type: 'function',
                  function: { name: 'replace_text', arguments: JSON.stringify({ old_string: 'hello', new_string: 'hi' }) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      }));

      try {
        const result = await runChatTurn({
          endpoint: { baseUrl: server.url, apiKey: 'sk-test' },
          model: 'test-model',
          messages: makeMessages(),
          currentText: 'hello world',
        });
        expect(result).toMatchObject({
          ok: false,
          code: 'mixed_tool_batch_not_supported',
        });
        expect(server.requestCount()).toBe(1);
      } finally {
        await server.close();
      }
    });

    it('empty tool_calls array → kind:message', async () => {
      const server = await startRoundServer((_round, _body) => ({
        status: 200,
        body: {
          id: 'chatcmpl-empty-tc',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'test-model',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'No changes needed.', tool_calls: [] },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      }));

      try {
        const result = await runChatTurn({
          endpoint: { baseUrl: server.url, apiKey: 'sk-test' },
          model: 'test-model',
          messages: makeMessages(),
          currentText: 'hello world',
        });

        const r = okMsg(result);
        expect(r.text).toContain('No changes');
        expect(server.requestCount()).toBe(1);
      } finally {
        await server.close();
      }
    });

    it('tool_call with invalid JSON arguments → error injected, self-correct', async () => {
      const server = await startRoundServer((round, _body) => {
        if (round === 1) {
          return {
            status: 200,
            body: {
              id: 'chatcmpl-bad-json',
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: 'test-model',
              choices: [{
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'Here is my edit.',
                  tool_calls: [{
                    id: 'call_bad_json', type: 'function',
                    function: { name: 'replace_text', arguments: '{not valid json' },
                  }],
                },
                finish_reason: 'tool_calls',
              }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            },
          };
        }

        const messages = (_body.messages as Array<{ role: string; content?: string }>) ?? [];
        expect(messages.some((message) =>
          message.role === 'tool' && message.content?.includes('invalid JSON arguments')
        )).toBe(true);

        return {
          status: 200,
          body: {
            id: 'chatcmpl-fixed',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'test-model',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: 'Fixed JSON.',
                tool_calls: [{
                  id: 'call_fix', type: 'function',
                  function: { name: 'replace_text', arguments: JSON.stringify({ old_string: 'hello', new_string: 'hi' }) },
                }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 },
          },
        };
      });

      try {
        const result = await runChatTurn({
          endpoint: { baseUrl: server.url, apiKey: 'sk-test' },
          model: 'test-model',
          messages: makeMessages(),
          currentText: 'hello world',
        });

        const r = okEdit(result);
        expect(r.newText).toBe('hi world');
        expect(server.requestCount()).toBe(2);
      } finally {
        await server.close();
      }
    });
  });
});
