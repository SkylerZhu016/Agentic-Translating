import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const HARNESS = fileURLToPath(new URL('../../scripts/dev-harness.mts', import.meta.url))
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error) => {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server has no TCP address')
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
}

async function runHarness(base: string, args: string[]): Promise<{
  code: number | null
  stdout: string
  stderr: string
}> {
  const cwd = mkdtempSync(path.join(tmpdir(), 'agentic-harness-test-'))
  tempDirs.push(cwd)
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', HARNESS, ...args, `--base=${base}`],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('dev harness subprocess timed out'))
    }, 10_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

describe('dev-harness protocol terminal semantics', () => {
  it('rejects a legacy translation stream that never reports fanout_complete', async () => {
    await withServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/sessions/s1/translate') {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end('event: done\ndata: {}\n\n')
        return
      }
      sendJson(response, 404, { error: 'not_found' })
    }, async (base) => {
      const result = await runHarness(base, ['translate', '--session=s1', '--json'])
      expect(result.code).toBe(1)
      expect(result.stdout).toContain('"exitCode": 1')
      expect(result.stderr).toContain('without fanout_complete event')
    })
  })

  it('rejects a chat stream that never reports message_complete', async () => {
    await withServer((request, response) => {
      if (request.method === 'GET' && request.url === '/api/sessions/s1/chat') {
        sendJson(response, 200, { active: false })
        return
      }
      if (request.method === 'POST' && request.url === '/api/sessions/s1/chat') {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end('event: done\ndata: {}\n\n')
        return
      }
      sendJson(response, 404, { error: 'not_found' })
    }, async (base) => {
      const result = await runHarness(base, [
        'chat',
        '--session=s1',
        '--message=revise',
        '--json',
      ])
      expect(result.code).toBe(1)
      expect(result.stdout).toContain('"exitCode": 1')
      expect(result.stderr).toContain('without message_complete event')
    })
  })

  it('passes a caller-supplied idempotency key when creating a session', async () => {
    const requestId = '11111111-1111-4111-8111-111111111111'
    const requestIds: string[] = []
    await withServer(async (request, response) => {
      if (request.method === 'POST' && request.url === '/api/sessions') {
        const body = JSON.parse(await readBody(request)) as { clientRequestId?: string }
        requestIds.push(String(body.clientRequestId ?? ''))
        sendJson(response, 200, {
          id: 's1',
          direction: 'en_to_zh',
          state: 'draft',
          public_config_snapshot: { version: 3 },
        })
        return
      }
      sendJson(response, 404, { error: 'not_found' })
    }, async (base) => {
      const first = await runHarness(base, [
        'create',
        '--text=hello',
        '--direction=en_to_zh',
        `--request-id=${requestId}`,
      ])
      const second = await runHarness(base, [
        'create',
        '--text=hello',
        '--direction=en_to_zh',
        `--request-id=${requestId}`,
      ])
      expect(first.code).toBe(0)
      expect(second.code).toBe(0)
      expect(requestIds).toEqual([requestId, requestId])
    })
  })
})
