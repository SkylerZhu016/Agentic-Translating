// ---------------------------------------------------------------------------
// Playwright globalSetup — start the shared mock LLM server on port 41099
// before any spec runs. The mock URL is written to process.env so specs can
// read it (E2E_MOCK_LLM_URL). Teardown closes the mock server.
// ---------------------------------------------------------------------------

import { startMockLLMServer } from '../test/fixtures/mock-llm-server'

const MOCK_PORT = Number(process.env.E2E_MOCK_PORT ?? 41099)

export default async function globalSetup(): Promise<() => Promise<void>> {
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
    // eslint-disable-next-line no-console
    console.log('[e2e global-teardown] mock LLM closed')
  }
}
