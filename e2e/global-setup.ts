// ---------------------------------------------------------------------------
// Playwright globalSetup — start the shared mock LLM server on port 41099
// before any spec runs. The mock URL is written to process.env so specs can
// read it (E2E_MOCK_LLM_URL). Teardown closes the mock server.
// ---------------------------------------------------------------------------

import { startMockLLMServer } from '../test/fixtures/mock-llm-server'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'

const MOCK_PORT = Number(process.env.E2E_MOCK_PORT ?? 41099)
const APP_PORT = Number(process.env.E2E_PORT ?? 3100)

async function waitForApp(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`E2E standalone server exited with code ${child.exitCode}`)
    }
    try {
      const response = await fetch(`http://localhost:${APP_PORT}`)
      if (response.ok) return
    } catch {
      // The standalone server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Timed out waiting for the E2E standalone server')
}

async function stopApp(child: ChildProcess): Promise<void> {
  if (child.exitCode != null) return
  child.kill()
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ])
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const e2eDataDirectory = path.join(process.cwd(), '.omo', 'e2e-data')
  process.env.AGENTIC_DATA_DIR = e2eDataDirectory
  const app = spawn(
    process.execPath,
    [path.join(process.cwd(), '.next', 'standalone', 'server.js')],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(APP_PORT),
        NODE_ENV: 'production',
        E2E_TEST: 'true',
        AGENTIC_SECRET_KEY:
          'e2e-only-secret-key-never-use-in-production',
        AGENTIC_DATA_DIR: e2eDataDirectory,
        NEXT_RUNTIME: 'nodejs',
      },
      stdio: 'inherit',
      windowsHide: true,
    },
  )
  await waitForApp(app)

  const mock = await startMockLLMServer({ port: MOCK_PORT })
  process.env.E2E_MOCK_LLM_URL = mock.url

  // Default behavior: echo (so any unplanned LLM call returns something sane
  // rather than a non_stream placeholder). Specs override per-test via
  // POST /__control.
  mock.setBehavior('*', { behavior: 'echo' })

  // eslint-disable-next-line no-console
  console.log(`[e2e global-setup] mock LLM listening at ${mock.url}`)

  return async () => {
    await mock.close()
    await stopApp(app)
    // eslint-disable-next-line no-console
    console.log('[e2e global-teardown] mock LLM closed')
  }
}
