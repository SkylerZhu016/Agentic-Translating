/**
 * Mock LLM server wrapper — extends test/fixtures/mock-llm.ts with a
 * `POST /__control` control channel so Playwright specs can dynamically
 * switch behaviors/models/delays at runtime without restarting the server.
 *
 * Designed for E2E: a single server instance is started once in Playwright
 * `globalSetup` on a fixed port (default 41099) and shared across all specs.
 *
 * Control channel contract:
 *   POST /__control
 *   Content-Type: application/json
 *   Body: { behavior: MockBehavior, model?: string, delayMs?: number,
 *           status?: number, jsonContent?: string, errorMessage?: string,
 *           errorType?: string, errorCode?: string, stream?: boolean,
 *           echoChars?: number }
 *   - model omitted  → configures the default/catch-all slot ('*')
 *   - model provided → configures per-model slot (overrides catch-all)
 *   - delayMs        → sets chunkDelayMs (stream behavior)
 *   204 No Content on success
 *
 * The wrapper also keeps the upstream behaviors intact for direct
 * x-mock-behavior / x-mock-model header overrides on individual requests.
 */

import http from 'http'
import { startMockLLM, type MockBehavior, type MockBehaviorConfig, type MockLLMInstance } from './mock-llm'

export interface ControlPayload {
  behavior: MockBehavior
  model?: string
  delayMs?: number
  status?: number
  jsonContent?: string
  errorMessage?: string
  errorType?: string
  errorCode?: string
  stream?: boolean
  echoChars?: number
}

/** Catch-all slot key used when `model` is omitted in a control request. */
export const DEFAULT_MODEL_SLOT = '*'

export interface MockLLMServerInstance extends MockLLMInstance {
  /** Underlying http server (exposed for graceful close in global teardown). */
  readonly raw: http.Server
}

/**
 * Start a mock LLM server with the /__control channel on a fixed port.
 *
 * @param port - TCP port to listen on (default 41099 for E2E global setup)
 */
export async function startMockLLMServer(
  { port = 41099 }: { port?: number } = {},
): Promise<MockLLMServerInstance> {
  // Build config map keyed by model name (or '*' for default).
  const behaviorMap = new Map<string, MockBehaviorConfig>()

  // Start the underlying mock LLM (random port internally; we won't use its
  // listener — we wrap it with our own server so we can interpose /__control).
  // Instead of using startMockLLM's listener, we re-implement the request
  // handler dispatch here so /__control is intercepted before LLM routing.
  //
  // Simpler approach: spin up a fronting http.Server that:
  //   - handles /__control itself
  //   - forwards every other request to a real startMockLLM() instance
  //
  // But forwarding via HTTP adds overhead and complicates streaming. Cleaner:
  // start startMockLLM() on the requested port directly, and intercept
  // /__control at the *client* layer (mock setBehavior is the only mutation we
  // need). The mock already supports per-model setBehavior; we just expose it
  // over HTTP.

  const mock = await startMockLLM({ port })

  // The upstream mock does not handle /__control — it 404s on unknown routes.
  // We need to add the control endpoint. The cleanest way without forking the
  // fixture is to spin up a tiny fronting server on the *same* port. But a
  // port can only have one listener. So: stop the upstream's listener and
  // re-listen on the same port with a composite handler.
  //
  // To do that we close the mock and capture its internal server — but the
  // fixture doesn't expose the raw http.Server. We therefore re-implement the
  // composition differently: start our own server on `port`, and start the
  // upstream mock on port 0; we then proxy non-control requests to the
  // upstream's random port.

  await mock.close()

  const upstream = await startMockLLM({ port: 0 })
  const upstreamUrl = upstream.url

  const frontServer = http.createServer(
    async (req: http.IncomingMessage, res: http.ServerResponse) => {
      // ---- CORS (so browser-originated control calls work if ever needed) ----
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, x-mock-behavior, x-mock-model, x-mock-json-content, x-mock-status, x-mock-delay-ms',
      )
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      // ---- Control channel ----
      const isControl =
        req.method === 'POST' && req.url === '/__control'

      if (isControl) {
        const body = await readJsonBody(req)
        if (body == null || typeof body !== 'object' || typeof (body as ControlPayload).behavior !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid_control_payload', message: 'behavior is required' }))
          return
        }
        const payload = body as ControlPayload
        const model = payload.model ?? DEFAULT_MODEL_SLOT
        const config: MockBehaviorConfig = {
          behavior: payload.behavior,
          chunkDelayMs: payload.delayMs,
          status: payload.status,
          jsonContent: payload.jsonContent,
          errorMessage: payload.errorMessage,
          errorType: payload.errorType,
          errorCode: payload.errorCode,
          stream: payload.stream,
          echoChars: payload.echoChars,
        }
        upstream.setBehavior(model, config)
        res.writeHead(204)
        res.end()
        return
      }

      // ---- Forward to upstream mock ----
      // For per-model behaviors configured via /__control to take effect, the
      // request body's `model` field must match the slot key. We also inject
      // x-mock-model header for the default slot so the upstream's
      // resolveBehaviorConfig picks the catch-all.
      await proxyToUpstream(req, res, upstreamUrl, behaviorMap)
    },
  )

  return new Promise<MockLLMServerInstance>((resolve, reject) => {
    frontServer.listen(port, () => {
      const addr = frontServer.address()
      const actualPort =
        addr != null && typeof addr === 'object' ? addr.port : port
      const url = `http://localhost:${actualPort}`

      const instance: MockLLMServerInstance = {
        url,
        raw: frontServer,
        close: async () => {
          await upstream.close()
          return new Promise<void>((res, rej) => {
            frontServer.close((err) => {
              if (err && (err as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') {
                res()
              } else if (err) {
                rej(err)
              } else {
                res()
              }
            })
          })
        },
        setBehavior: (model: string, config: MockBehaviorConfig) => {
          behaviorMap.set(model, config)
          upstream.setBehavior(model, config)
        },
        getRequests: () => upstream.getRequests(),
      }
      resolve(instance)
    })
    frontServer.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8')
        resolve(raw ? JSON.parse(raw) : null)
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

/**
 * Forward an incoming request to the upstream mock URL, streaming the response
 * back. For SSE responses we pipe raw bytes; for JSON we forward as-is.
 */
function proxyToUpstream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstreamUrl: string,
  _behaviorMap: Map<string, MockBehaviorConfig>,
): Promise<void> {
  return new Promise((resolve) => {
    const bodyChunks: Buffer[] = []
    req.on('data', (c: Buffer) => bodyChunks.push(c))
    req.on('end', () => {
      const bodyBuf = Buffer.concat(bodyChunks)
      const upstreamParsed = new URL(upstreamUrl)
      const proxyReq = http.request(
        {
          hostname: upstreamParsed.hostname,
          port: upstreamParsed.port,
          path: req.url,
          method: req.method,
          headers: {
            ...stripHopHeaders(req.headers),
            'content-length': String(bodyBuf.length),
          },
        },
        (upRes: http.IncomingMessage) => {
          res.writeHead(upRes.statusCode ?? 200, upRes.headers)
          upRes.pipe(res)
          upRes.on('end', () => resolve())
          upRes.on('error', () => {
            if (!res.writableEnded) res.end()
            resolve()
          })
        },
      )
      proxyReq.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'upstream_unreachable' }))
        }
        resolve()
      })
      if (bodyBuf.length > 0) proxyReq.write(bodyBuf)
      proxyReq.end()
    })
    req.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'client_read_error' }))
      }
      resolve()
    })
  })
}

function stripHopHeaders(
  headers: http.IncomingHttpHeaders,
): http.IncomingHttpHeaders {
  const out: http.IncomingHttpHeaders = { ...headers }
  delete out.host
  delete out.connection
  delete out['content-length']
  return out
}
