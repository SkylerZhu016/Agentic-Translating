import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  db: {
    prepare: vi.fn(() => ({ get: vi.fn(() => ({ ok: 1 })) })),
  },
  migrate: vi.fn(),
  getAppliedVersion: vi.fn(() => 17),
}))

vi.mock('@/src/lib/db', () => ({ getDb: () => mocks.db }))
vi.mock('@/src/lib/db/migrate', () => ({
  migrate: mocks.migrate,
  getAppliedVersion: mocks.getAppliedVersion,
}))

import { GET } from '../../app/api/health/ready/route'

describe('desktop ready health nonce', () => {
  const previousNonce = process.env.AGENTIC_DESKTOP_STARTUP_NONCE

  afterEach(() => {
    if (previousNonce === undefined) {
      delete process.env.AGENTIC_DESKTOP_STARTUP_NONCE
    } else {
      process.env.AGENTIC_DESKTOP_STARTUP_NONCE = previousNonce
    }
    vi.clearAllMocks()
  })

  it('echoes the per-start nonce after the database readiness probe succeeds', async () => {
    process.env.AGENTIC_DESKTOP_STARTUP_NONCE = 'nonce-for-this-start'

    const response = await GET()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ready: true,
      migrationVersion: 17,
      startupNonce: 'nonce-for-this-start',
    })
  })

  it('does not invent a nonce for non-desktop health checks', async () => {
    delete process.env.AGENTIC_DESKTOP_STARTUP_NONCE

    const response = await GET()

    await expect(response.json()).resolves.toMatchObject({
      ready: true,
      startupNonce: null,
    })
  })
})
