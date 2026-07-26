/**
 * Mock LLM — OpenAI 兼容的模拟 HTTP 服务器
 *
 * 使用裸 Node http.createServer（零框架依赖），用于测试中替代真实 LLM 调用。
 *
 * 支持的 behaviors（通过 setBehavior() 或 x-mock-behavior 请求头配置）:
 *   stream         — SSE delta 流，可配 chunkDelayMs
 *   non_stream     — 完整 JSON 响应
 *   error          — 可配 status + OpenAI 风格 error body
 *   malformed_json — content 返回非法 JSON
 *   json_content   — content 返回可配 JSON 字符串（x-mock-json-content 请求头）
 *   no_tools_error — 带 tools 的请求 → 400；不带 tools → 200
 *   tool_call      — 返回含 tool_calls（replace_text 函数）的响应
 *   echo           — 回显最后 user message 前 N 字符
 */

import http from 'http';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MockBehavior =
  | 'stream'
  | 'non_stream'
  | 'error'
  | 'malformed_json'
  | 'json_content'
  | 'no_tools_error'
  | 'tool_call'
  | 'echo';

export interface MockBehaviorConfig {
  behavior: MockBehavior;
  /** SSE 流中每个 chunk 之间的延迟（ms），默认 10 */
  chunkDelayMs?: number;
  /** error behavior 的 HTTP 状态码，默认 500 */
  status?: number;
  /** json_content behavior 中 content 返回的 JSON 字符串 */
  jsonContent?: string;
  /** echo behavior 中回显的字符数，默认全部 */
  echoChars?: number;
  /** tool_call 是否使用流式响应，默认 false */
  stream?: boolean;
  /** error behavior 的 error.type 字段，默认 "server_error" */
  errorType?: string;
  /** error behavior 的 error.code 字段，默认 "mock_error" */
  errorCode?: string;
  /** error behavior 的 error.message 字段，默认 "Mock server error" */
  errorMessage?: string;
}

export interface RequestLogEntry {
  timestamp: string;
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface MockLLMInstance {
  /** 服务器基础 URL，例如 http://localhost:1234 */
  url: string;
  /** 优雅关闭服务器并释放端口 */
  close: () => Promise<void>;
  /**
   * 按 model 设置行为。
   * 请求头 x-mock-model 匹配时使用此配置。
   * 请求头 x-mock-behavior 存在时优先于 setBehavior。
   */
  setBehavior: (model: string, config: MockBehaviorConfig) => void;
  /** Clear all per-model and catch-all behavior overrides. */
  resetBehaviors: () => void;
  /** 获取所有已记录请求的快照 */
  getRequests: () => RequestLogEntry[];
}

function buildRequestedToolCall(body: unknown) {
  const request =
    body && typeof body === 'object'
      ? body as Record<string, unknown>
      : {}
  const tools = Array.isArray(request.tools)
    ? request.tools as Array<{
        function?: { name?: string }
      }>
    : []
  const choice = request.tool_choice
  const forcedName =
    choice && typeof choice === 'object'
      ? (
          choice as {
            function?: { name?: string }
          }
        ).function?.name
      : undefined
  const name = forcedName ?? tools[0]?.function?.name ?? 'replace_text'
  const messages = Array.isArray(request.messages)
    ? request.messages as Array<{ content?: string }>
    : []
  const prompt = messages.map((message) => message.content ?? '').join('\n')

  if (name === 'call_agents') {
    const ids = [...prompt.matchAll(
      /^- ([a-z0-9][a-z0-9.-]+):/gim,
    )].map((match) => match[1])
      .filter((id) => !id.startsWith('cultural-context.'))
    return {
      name,
      arguments: {
        calls: ids.slice(0, 2).map((agentVariantId) => ({
          agentVariantId,
          additionalInstruction: 'Produce a complete, careful candidate.',
          selectionReason: 'Mock complementary role selection.',
        })),
      },
    }
  }
  if (name === 'write_draft') {
    const ids = [...new Set(
      [...prompt.matchAll(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      )].map((match) => match[0]),
    )]
    return {
      name,
      arguments: {
        text: 'Mock evidence-backed final translation.',
        reason: 'Synthesized from the latest successful candidate bodies.',
        evidenceInvocationIds: ids.slice(-2),
      },
    }
  }
  if (name === 'submit_final') {
    const versionId = Number(prompt.match(/versionId=(\d+)/)?.[1] ?? 1)
    return {
      name,
      arguments: {
        versionId,
        summary: 'Mock final submission.',
      },
    }
  }
  return {
    name: 'replace_text',
    arguments: {
      old_string: 'original text',
      new_string: 'replaced text',
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJSONBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : null);
      } catch {
        resolve(null);
      }
    });
    // 如果客户端断开，静默解析失败
    req.on('error', () => resolve(null));
  });
}

function extractRequestHeaders(
  req: http.IncomingMessage,
): Record<string, string | string[] | undefined> {
  const headers: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key] = value;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/**
 * 解析请求对应的行为配置。
 * 优先级: x-mock-behavior 请求头 > model（来自 x-mock-model 头或请求体）对应的 setBehavior 配置 > non_stream 默认
 */
function resolveBehaviorConfig(
  behaviorMap: Map<string, MockBehaviorConfig>,
  req: http.IncomingMessage,
  body?: unknown,
): MockBehaviorConfig {
  const headerBehavior = req.headers['x-mock-behavior'] as string | undefined;
  const model = req.headers['x-mock-model'] as string | undefined;
  // 也尝试从请求体中提取 model 字段
  const bodyModel =
    body != null && typeof body === 'object'
      ? ((body as Record<string, unknown>).model as string | undefined)
      : undefined;
  const effectiveModel = model ?? bodyModel;

  let config: MockBehaviorConfig;

  if (headerBehavior) {
    config = { behavior: headerBehavior as MockBehavior };
  } else if (effectiveModel && behaviorMap.has(effectiveModel)) {
    config = { ...behaviorMap.get(effectiveModel)! };
  } else {
    config = { behavior: 'non_stream' };
  }

  // 请求头覆盖 setBehavior 中的对应字段
  if (req.headers['x-mock-json-content']) {
    config.jsonContent = req.headers['x-mock-json-content'] as string;
  }
  if (req.headers['x-mock-status']) {
    config.status = Number(req.headers['x-mock-status']);
  }
  if (req.headers['x-mock-delay-ms']) {
    config.chunkDelayMs = Number(req.headers['x-mock-delay-ms']);
  }

  return config;
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

function buildOpenAIError(status: number, message: string, type: string, code: string) {
  return {
    error: { message, type, code },
  };
}

function buildChatCompletion(
  id: string,
  created: number,
  model: string,
  content: string,
  toolCalls?: unknown[],
  finishReason: string = 'stop',
) {
  const message: Record<string, unknown> = {
    role: 'assistant',
    content,
  };
  if (toolCalls && toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function buildStreamChunk(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export async function startMockLLM(
  { port = 0 }: { port?: number } = {},
): Promise<MockLLMInstance> {
  const behaviorMap = new Map<string, MockBehaviorConfig>();
  const requests: RequestLogEntry[] = [];

  const server = http.createServer(
    async (req: http.IncomingMessage, res: http.ServerResponse) => {
      // ---- 请求日志 ----
      const logEntry: RequestLogEntry = {
        timestamp: new Date().toISOString(),
        url: req.url ?? '',
        method: req.method ?? '',
        headers: extractRequestHeaders(req),
      };
      requests.push(logEntry);

      // ---- CORS ----
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, OPTIONS',
      );
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, x-mock-behavior, x-mock-model, x-mock-json-content, x-mock-status, x-mock-delay-ms',
      );

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // ---- 路由: 仅 POST /v1/chat/completions ----
      const isChatCompletions =
        req.method === 'POST' &&
        req.url != null &&
        req.url.startsWith('/v1/chat/completions');

      if (!isChatCompletions) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(
            buildOpenAIError(404, 'Not Found', 'not_found', 'not_found'),
          ),
        );
        return;
      }

      const body = await parseJSONBody(req);
      logEntry.body = body;

      const config = resolveBehaviorConfig(behaviorMap, req, body);

      const responseId = `chatcmpl-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);
      const model: string =
        (body != null && typeof body === 'object' && 'model' in body
          ? ((body as Record<string, unknown>).model as string | undefined)
          : undefined) ?? 'mock-model';

      const hasTools =
        body != null &&
        typeof body === 'object' &&
        Array.isArray((body as Record<string, unknown>).tools) &&
        ((body as Record<string, unknown>).tools as unknown[]).length > 0;

      // ===================================================================
      // behavior dispatch
      // ===================================================================

      try {
        switch (config.behavior) {
          // ---------------------------------------------------------------
          // stream — SSE delta 流
          // ---------------------------------------------------------------
          case 'stream': {
            const content =
              'This is a mock streaming response from the LLM fixture.';
            const tokens = content.split(/(\s+)/).filter(Boolean);
            const delayMs = config.chunkDelayMs ?? 10;

            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            });

            for (const token of tokens) {
              const chunk = buildStreamChunk(
                responseId,
                created,
                model,
                { content: token },
                null,
              );
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              if (delayMs > 0) {
                await new Promise((r) => setTimeout(r, delayMs));
              }
            }

            // 结束 chunk
            const finalChunk = buildStreamChunk(
              responseId,
              created,
              model,
              {},
              'stop',
            );
            res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            break;
          }

          // ---------------------------------------------------------------
          // non_stream — 完整 JSON 响应
          // ---------------------------------------------------------------
          case 'non_stream': {
            const response = buildChatCompletion(
              responseId,
              created,
              model,
              'This is a mock non-streaming response.',
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
            break;
          }

          // ---------------------------------------------------------------
          // error — 可配 status + OpenAI 风格 error body
          // ---------------------------------------------------------------
          case 'error': {
            const status = config.status ?? 500;
            const errBody = buildOpenAIError(
              status,
              config.errorMessage ?? 'Mock server error',
              config.errorType ?? 'server_error',
              config.errorCode ?? 'mock_error',
            );
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(errBody));
            break;
          }

          // ---------------------------------------------------------------
          // malformed_json — content 返回非法 JSON
          // ---------------------------------------------------------------
          case 'malformed_json': {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            // 返回真正的非法 JSON（外层结构就断了，不是 JSON）
            res.end('{"id":"chatcmpl-xxx","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"broken}],"finish_reason":"stop"}');
            break;
          }

          // ---------------------------------------------------------------
          // json_content — content 返回可配 JSON 字符串
          // ---------------------------------------------------------------
          case 'json_content': {
            const jsonContent =
              config.jsonContent ?? '{"key": "default_value"}';
            const response = buildChatCompletion(
              responseId,
              created,
              model,
              jsonContent,
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
            break;
          }

          // ---------------------------------------------------------------
          // no_tools_error — 带 tools → 400；不带 tools → 200
          // ---------------------------------------------------------------
          case 'no_tools_error': {
            if (hasTools) {
              const errBody = buildOpenAIError(
                400,
                'tools is not supported',
                'invalid_request_error',
                'unsupported_tools',
              );
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(errBody));
            } else {
              const response = buildChatCompletion(
                responseId,
                created,
                model,
                'No tools response: operation successful.',
              );
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(response));
            }
            break;
          }

          // ---------------------------------------------------------------
          // tool_call — 返回含 tool_calls 的响应（replace_text）
          // ---------------------------------------------------------------
          case 'tool_call': {
            const toolCallContent = 'I will search for that.';
            const useStream = config.stream ?? false;
            const requestedTool = buildRequestedToolCall(body);

            const toolCall = {
              id: `call_${Date.now()}`,
              type: 'function',
              function: {
                name: requestedTool.name,
                arguments: JSON.stringify(requestedTool.arguments),
              },
            };

            if (useStream) {
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
              });

              // 内容 delta
              const contentChunk = buildStreamChunk(
                responseId,
                created,
                model,
                { content: toolCallContent },
                null,
              );
              res.write(`data: ${JSON.stringify(contentChunk)}\n\n`);

              // tool_calls delta（流式模式下 tool_calls 数组元素含 index）
              const toolCallChunk = buildStreamChunk(
                responseId,
                created,
                model,
                {
                  tool_calls: [
                    {
                      index: 0,
                      ...toolCall,
                    },
                  ],
                },
                'tool_calls',
              );
              res.write(`data: ${JSON.stringify(toolCallChunk)}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
            } else {
              const response = buildChatCompletion(
                responseId,
                created,
                model,
                toolCallContent,
                [toolCall],
                'tool_calls',
              );
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(response));
            }
            break;
          }

          // ---------------------------------------------------------------
          // echo — 回显最后 user message 前 N 字符
          // ---------------------------------------------------------------
          case 'echo': {
            const messages: unknown[] =
              body != null && typeof body === 'object'
                ? ((body as Record<string, unknown>).messages as unknown[]) ??
                  []
                : [];
            const userMessages = messages.filter(
              (m: unknown) =>
                m != null &&
                typeof m === 'object' &&
                (m as Record<string, unknown>).role === 'user',
            );
            const lastUserMsg =
              userMessages.length > 0
                ? (userMessages[userMessages.length - 1] as Record<
                    string,
                    unknown
                  >)
                : null;
            const content: string =
              (lastUserMsg?.content as string | undefined) ?? '';
            const chars = config.echoChars ?? content.length;
            const echoText = content.slice(0, Math.max(0, chars));

            const response = buildChatCompletion(
              responseId,
              created,
              model,
              echoText,
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
            break;
          }

          // ---------------------------------------------------------------
          // fallback
          // ---------------------------------------------------------------
          default: {
            const response = buildChatCompletion(
              responseId,
              created,
              model,
              'Default mock response.',
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
          }
        }
      } catch (err) {
        // 防止未捕获异常导致进程崩溃
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify(
              buildOpenAIError(500, 'Internal mock error', 'server_error', 'internal_error'),
            ),
          );
        }
      }
    },
  );

  // ---- 启动 ----
  return new Promise<MockLLMInstance>((resolve, reject) => {
    server.listen(port, () => {
      const addr = server.address();
      const actualPort =
        addr != null && typeof addr === 'object' ? addr.port : port;
      const url = `http://localhost:${actualPort}`;

      resolve({
        url,
        close: () => {
          behaviorMap.clear();
          return new Promise<void>((res, rej) => {
            server.close((err) => {
              // ERR_SERVER_NOT_RUNNING 表示服务器已关闭，视为成功
              if (err && (err as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') {
                res();
              } else if (err) {
                rej(err);
              } else {
                res();
              }
            });
          });
        },
        setBehavior: (model: string, config: MockBehaviorConfig) => {
          behaviorMap.set(model, config);
        },
        resetBehaviors: () => {
          behaviorMap.clear();
        },
        getRequests: () => [...requests],
      });
    });
    server.on('error', reject);
  });
}
