/**
 * mock-llm 自测
 *
 * 覆盖所有 8 种 behavior + 服务器生命周期 + 请求日志。
 * 所有测试均通过 MockLLM 实例本身进行，不调真实 LLM。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { startMockLLM, type MockLLMInstance } from './mock-llm';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 向 MockLLM 发送 chat completion 请求的快捷函数 */
async function postChatCompletion(
  url: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<Response> {
  const hdrs: Record<string, string> = {
    'Content-Type': 'application/json',
    ...headers,
  };
  return fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: hdrs,
    body: JSON.stringify(body),
  });
}

/** 解析 SSE 流为 delta content 片段数组 */
async function collectSSEContent(response: Response): Promise<string[]> {
  if (!response.body) throw new Error('No response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const contents: string[] = [];
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed?.choices?.[0]?.delta;
          if (delta?.content) {
            contents.push(delta.content);
          }
        } catch {
          // skip malformed lines
        }
      }
    }
  }

  return contents;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('MockLLM', () => {
  let llm: MockLLMInstance;

  afterEach(async () => {
    if (llm) {
      await llm.close();
    }
  });

  // =========================================================================
  // Server lifecycle
  // =========================================================================

  describe('lifecycle', () => {
    it('starts and stops on a random port', async () => {
      llm = await startMockLLM();
      expect(llm.url).toMatch(/^http:\/\/localhost:\d+$/);
      expect(() => new URL(llm.url)).not.toThrow();
      // close and verify port is released
      const port = Number(new URL(llm.url).port);
      await llm.close();
      // try listening on same port — should succeed (released)
      // assign to llm so afterEach can clean it up
      llm = await startMockLLM({ port });
      expect(llm.url).toContain(String(port));
    });

    it('starts on a specific port', async () => {
      llm = await startMockLLM({ port: 0 });
      expect(llm.url).toMatch(/^http:\/\/localhost:\d+$/);
    });

    it('getRequests starts empty', async () => {
      llm = await startMockLLM();
      expect(llm.getRequests()).toHaveLength(0);
    });

    it('rejects non-chat-completions routes with 404', async () => {
      llm = await startMockLLM();
      const res = await fetch(`${llm.url}/v1/models`, { method: 'GET' });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.message).toBe('Not Found');
    });
  });

  // =========================================================================
  // non_stream
  // =========================================================================

  describe('non_stream behavior', () => {
    it('returns full JSON chat completion', async () => {
      llm = await startMockLLM();
      llm.setBehavior('test-model', { behavior: 'non_stream' });

      const res = await postChatCompletion(llm.url, {
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = await res.json();
      expect(body.object).toBe('chat.completion');
      expect(body.choices).toHaveLength(1);
      expect(body.choices[0].message.role).toBe('assistant');
      expect(body.choices[0].message.content).toBeTruthy();
      expect(body.choices[0].finish_reason).toBe('stop');
    });
  });

  // =========================================================================
  // stream
  // =========================================================================

  describe('stream behavior', () => {
    it('returns SSE delta stream', async () => {
      llm = await startMockLLM();
      llm.setBehavior('stream-model', { behavior: 'stream', chunkDelayMs: 1 });

      const res = await postChatCompletion(llm.url, {
        model: 'stream-model',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const contents = await collectSSEContent(res);
      expect(contents.length).toBeGreaterThan(0);
      // Should contain our mock streaming text
      const joined = contents.join('');
      expect(joined).toContain('mock streaming response');
    });
  });

  // =========================================================================
  // error
  // =========================================================================

  describe('error behavior', () => {
    it('returns 500 with OpenAI error shape by default', async () => {
      llm = await startMockLLM();
      llm.setBehavior('err-model', { behavior: 'error' });

      const res = await postChatCompletion(llm.url, {
        model: 'err-model',
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.message).toBe('Mock server error');
      expect(body.error.type).toBe('server_error');
      expect(body.error.code).toBe('mock_error');
    });

    it('returns custom status via x-mock-status header', async () => {
      llm = await startMockLLM();
      llm.setBehavior('err-model', { behavior: 'error', status: 429 });

      const res = await postChatCompletion(
        llm.url,
        { model: 'err-model', messages: [{ role: 'user', content: 'Hi' }] },
        { 'x-mock-status': '429' },
      );

      expect(res.status).toBe(429);
    });

    it('returns custom error fields via config', async () => {
      llm = await startMockLLM();
      llm.setBehavior('err-model', {
        behavior: 'error',
        status: 400,
        errorMessage: 'Rate limit exceeded',
        errorType: 'rate_limit_error',
        errorCode: 'rate_limited',
      });

      const res = await postChatCompletion(llm.url, {
        model: 'err-model',
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toBe('Rate limit exceeded');
      expect(body.error.type).toBe('rate_limit_error');
      expect(body.error.code).toBe('rate_limited');
    });
  });

  // =========================================================================
  // malformed_json
  // =========================================================================

  describe('malformed_json behavior', () => {
    it('returns 200 with unparseable JSON body', async () => {
      llm = await startMockLLM();
      llm.setBehavior('mal-model', { behavior: 'malformed_json' });

      const res = await postChatCompletion(llm.url, {
        model: 'mal-model',
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      // Should not be valid JSON — content value is broken
      expect(() => JSON.parse(text)).toThrow();
    });
  });

  // =========================================================================
  // json_content
  // =========================================================================

  describe('json_content behavior', () => {
    it('returns configurable JSON string as content via setBehavior', async () => {
      llm = await startMockLLM();
      const customJson = JSON.stringify({
        translation: '你好世界',
        confidence: 0.95,
      });
      llm.setBehavior('json-model', {
        behavior: 'json_content',
        jsonContent: customJson,
      });

      const res = await postChatCompletion(llm.url, {
        model: 'json-model',
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.choices[0].message.content).toBe(customJson);
      // The content is a JSON string — parse it
      const parsed = JSON.parse(body.choices[0].message.content);
      expect(parsed.translation).toBe('你好世界');
    });

    it('uses configurable JSON string as content via header', async () => {
      llm = await startMockLLM();
      llm.setBehavior('json-hdr-model', { behavior: 'json_content' });

      const res = await postChatCompletion(
        llm.url,
        { model: 'json-hdr-model', messages: [{ role: 'user', content: 'Hi' }] },
        { 'x-mock-json-content': '{"key":"header_value"}' },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      const parsed = JSON.parse(body.choices[0].message.content);
      expect(parsed.key).toBe('header_value');
    });

    it('uses default JSON content when no header or config given', async () => {
      llm = await startMockLLM();
      llm.setBehavior('json-model', { behavior: 'json_content' });

      const res = await postChatCompletion(llm.url, {
        model: 'json-model',
        messages: [{ role: 'user', content: 'Hi' }],
      });

      const body = await res.json();
      const parsed = JSON.parse(body.choices[0].message.content);
      expect(parsed.key).toBe('default_value');
    });
  });

  // =========================================================================
  // no_tools_error
  // =========================================================================

  describe('no_tools_error behavior', () => {
    it('returns 400 when tools are present in the request', async () => {
      llm = await startMockLLM();
      llm.setBehavior('no-tools-model', {
        behavior: 'no_tools_error',
      });

      const res = await postChatCompletion(llm.url, {
        model: 'no-tools-model',
        messages: [{ role: 'user', content: 'Translate' }],
        tools: [
          {
            type: 'function',
            function: { name: 'translate', parameters: { type: 'object' } },
          },
        ],
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toBe('tools is not supported');
    });

    it('returns 200 when no tools in the request', async () => {
      llm = await startMockLLM();
      llm.setBehavior('no-tools-model', {
        behavior: 'no_tools_error',
      });

      const res = await postChatCompletion(llm.url, {
        model: 'no-tools-model',
        messages: [{ role: 'user', content: 'Translate' }],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.choices[0].message.content).toBeTruthy();
    });
  });

  // =========================================================================
  // tool_call
  // =========================================================================

  describe('tool_call behavior', () => {
    it('returns non-stream response with tool_calls', async () => {
      llm = await startMockLLM();
      llm.setBehavior('tool-model', {
        behavior: 'tool_call',
        stream: false,
      });

      const res = await postChatCompletion(llm.url, {
        model: 'tool-model',
        messages: [{ role: 'user', content: 'Replace text' }],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      const msg = body.choices[0].message;
      expect(msg.tool_calls).toHaveLength(1);
      expect(msg.tool_calls[0].type).toBe('function');
      expect(msg.tool_calls[0].function.name).toBe('replace_text');
      const args = JSON.parse(msg.tool_calls[0].function.arguments);
      expect(args.old_string).toBe('original text');
      expect(args.new_string).toBe('replaced text');
      expect(body.choices[0].finish_reason).toBe('tool_calls');
    });

    it('returns stream response with tool_calls delta', async () => {
      llm = await startMockLLM();
      llm.setBehavior('tool-stream-model', {
        behavior: 'tool_call',
        stream: true,
      });

      const res = await postChatCompletion(llm.url, {
        model: 'tool-stream-model',
        messages: [{ role: 'user', content: 'Replace text' }],
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      // Parse SSE and look for tool_calls delta
      if (!res.body) throw new Error('No body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let foundToolCall = false;
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              const toolCalls = parsed?.choices?.[0]?.delta?.tool_calls;
              if (toolCalls) {
                foundToolCall = true;
                expect(toolCalls[0].function.name).toBe('replace_text');
                const args = JSON.parse(toolCalls[0].function.arguments);
                expect(args.old_string).toBe('original text');
              }
            } catch {
              // skip
            }
          }
        }
      }

      expect(foundToolCall).toBe(true);
    });
  });

  // =========================================================================
  // echo
  // =========================================================================

  describe('echo behavior', () => {
    it('echoes the last user message content', async () => {
      llm = await startMockLLM();
      llm.setBehavior('echo-model', { behavior: 'echo' });

      const res = await postChatCompletion(llm.url, {
        model: 'echo-model',
        messages: [
          { role: 'system', content: 'You are a helper.' },
          { role: 'user', content: 'Hello, world!' },
        ],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.choices[0].message.content).toBe('Hello, world!');
    });

    it('echoes only first N characters via echoChars', async () => {
      llm = await startMockLLM();
      llm.setBehavior('echo-model', {
        behavior: 'echo',
        echoChars: 5,
      });

      const res = await postChatCompletion(llm.url, {
        model: 'echo-model',
        messages: [{ role: 'user', content: 'Hello, world!' }],
      });

      const body = await res.json();
      expect(body.choices[0].message.content).toBe('Hello');
    });

    it('returns empty string if last user message has no content', async () => {
      llm = await startMockLLM();
      llm.setBehavior('echo-model', { behavior: 'echo' });

      const res = await postChatCompletion(llm.url, {
        model: 'echo-model',
        messages: [{ role: 'user', content: '' }],
      });

      const body = await res.json();
      expect(body.choices[0].message.content).toBe('');
    });
  });

  // =========================================================================
  // Request logging
  // =========================================================================

  describe('request logging', () => {
    it('records request details', async () => {
      llm = await startMockLLM();
      llm.setBehavior('log-model', { behavior: 'non_stream' });

      await postChatCompletion(llm.url, {
        model: 'log-model',
        messages: [{ role: 'user', content: 'Test logging' }],
      });

      const logs = llm.getRequests();
      expect(logs).toHaveLength(1);
      expect(logs[0].method).toBe('POST');
      expect(logs[0].url).toBe('/v1/chat/completions');
      expect(logs[0].timestamp).toBeTruthy();
      expect(logs[0].headers).toBeDefined();
      expect(logs[0].body).toBeDefined();
      const body = logs[0].body as Record<string, unknown>;
      expect(body?.messages).toHaveLength(1);
    });

    it('accumulates multiple requests', async () => {
      llm = await startMockLLM();
      llm.setBehavior('acc-model', { behavior: 'non_stream' });

      await postChatCompletion(llm.url, {
        model: 'acc-model',
        messages: [{ role: 'user', content: 'Req 1' }],
      });
      await postChatCompletion(llm.url, {
        model: 'acc-model',
        messages: [{ role: 'user', content: 'Req 2' }],
      });

      expect(llm.getRequests()).toHaveLength(2);
    });

    it('getRequests returns a defensive copy', async () => {
      llm = await startMockLLM();
      llm.setBehavior('copy-model', { behavior: 'non_stream' });

      await postChatCompletion(llm.url, {
        model: 'copy-model',
        messages: [{ role: 'user', content: 'Test' }],
      });

      const logs = llm.getRequests();
      expect(logs).toHaveLength(1);
      // Mutating the copy should not affect internal state
      logs.length = 0;
      expect(llm.getRequests()).toHaveLength(1);
    });
  });

  // =========================================================================
  // x-mock-behavior header override
  // =========================================================================

  describe('x-mock-behavior header', () => {
    it('takes priority over setBehavior config', async () => {
      llm = await startMockLLM();
      llm.setBehavior('hdr-model', { behavior: 'non_stream' });

      const res = await postChatCompletion(
        llm.url,
        {
          model: 'hdr-model',
          messages: [{ role: 'user', content: 'Override test' }],
        },
        { 'x-mock-behavior': 'echo' },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      // echo behavior: should echo user message
      expect(body.choices[0].message.content).toBe('Override test');
    });
  });

  // =========================================================================
  // CORS preflight
  // =========================================================================

  describe('CORS', () => {
    it('responds to OPTIONS preflight', async () => {
      llm = await startMockLLM();

      const res = await fetch(`${llm.url}/v1/chat/completions`, {
        method: 'OPTIONS',
      });

      expect(res.status).toBe(204);
    });
  });
});
