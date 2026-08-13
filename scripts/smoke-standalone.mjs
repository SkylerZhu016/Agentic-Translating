import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

const root = process.cwd()
const standalone = path.join(root, '.next', 'standalone')
const serverEntry = path.join(standalone, 'server.js')
const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'agentic-standalone-smoke-'))
const timeoutMs = 30_000
const outputLimit = 24_000

function appendBounded(current, chunk) {
  const combined = current + chunk.toString()
  return combined.length > outputLimit
    ? combined.slice(combined.length - outputLimit)
    : combined
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : null
      server.close((error) => {
        if (error) reject(error)
        else if (port == null || port === 3000) resolve(reservePort())
        else resolve(port)
      })
    })
  })
}

async function waitForReady(url, child) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'server_not_ready'
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `standalone server exited with ${child.exitCode ?? child.signalCode}`,
      )
    }
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        signal: AbortSignal.timeout(1_500),
      })
      const payload = await response.json().catch(() => null)
      if (
        response.ok &&
        payload &&
        typeof payload === 'object' &&
        payload.ready === true
      ) {
        return payload
      }
      lastError = `health_${response.status}: ${JSON.stringify(payload)}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`standalone health check timed out: ${lastError}`)
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill()
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ])
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await Promise.race([
      once(child, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ])
  }
}

let child = null
let stdout = ''
let stderr = ''

try {
  if (!existsSync(serverEntry)) {
    throw new Error('Standalone server.js does not exist; run build:standalone first.')
  }
  const port = await reservePort()
  child = spawn(process.execPath, [serverEntry], {
    cwd: standalone,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOSTNAME: '127.0.0.1',
      PORT: String(port),
      AGENTIC_DATA_DIR: dataRoot,
      AGENTIC_SECRET_KEY: randomBytes(32).toString('hex'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  })
  child.stdout.on('data', (chunk) => {
    stdout = appendBounded(stdout, chunk)
  })
  child.stderr.on('data', (chunk) => {
    stderr = appendBounded(stderr, chunk)
  })

  const spawnError = new Promise((_, reject) => child.once('error', reject))
  const payload = await Promise.race([
    waitForReady(`http://127.0.0.1:${port}/api/health/ready`, child),
    spawnError,
  ])
  console.log(
    `Standalone smoke passed on an ephemeral non-3000 port (migration ${payload.migrationVersion}).`,
  )
} catch (error) {
  const details = [
    error instanceof Error ? error.stack ?? error.message : String(error),
    stdout ? `stdout:\n${stdout}` : '',
    stderr ? `stderr:\n${stderr}` : '',
  ].filter(Boolean).join('\n')
  console.error(details)
  process.exitCode = 1
} finally {
  if (child) await stopChild(child)
  const tempBase = path.resolve(os.tmpdir()) + path.sep
  const resolvedDataRoot = path.resolve(dataRoot)
  if (!resolvedDataRoot.startsWith(tempBase)) {
    throw new Error(`Refusing to clean smoke data outside temp: ${resolvedDataRoot}`)
  }
  rmSync(resolvedDataRoot, { recursive: true, force: true })
}
