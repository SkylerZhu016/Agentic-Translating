// ---------------------------------------------------------------------------
// Playwright config — E2E suite for Agentic Translating
//
// - testDir: e2e/
// - webServer: `npm run build && npm start` on port 3100 (production form)
// - globalSetup: starts shared mock LLM on port 41099 with /__control channel
// - baseURL: http://localhost:3100
// - trace/video: retained only on failure (retain-on-failure)
// - evidence: screenshots saved to .omo/evidence/e2e/ via per-test helper
// ---------------------------------------------------------------------------

import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT ?? 3100)
const MOCK_PORT = Number(process.env.E2E_MOCK_PORT ?? 41099)

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // shared DB + single mock server — serialize specs
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 0 : 0,
  workers: 1, // single worker: shared SQLite DB + shared mock
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  globalSetup: './e2e/global-setup.ts',

  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: `npm run build && npm start`,
    url: `http://localhost:${PORT}`,
    timeout: 180_000, // build can take ~60-90s; allow headroom
    reuseExistingServer: !process.env.CI,
    port: PORT,
    env: {
      PORT: String(PORT),
      NODE_ENV: 'production', // verify production form (not dev)
      // Next.js reads NEXT_RUNTIME at instrumentation time; ensure nodejs path.
      NEXT_RUNTIME: 'nodejs',
    },
  },
})
