import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../../src/lib/db/migrate'
import { createRepositories } from '../../src/lib/db/repositories'
import type { EndpointCapabilityProfile } from '../../src/lib/onboarding/contracts'
import { createOnboardingRepository } from '../../src/lib/onboarding/repository'

vi.mock('../../src/lib/onboarding/capability-doctor', async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import('../../src/lib/onboarding/capability-doctor')
    >()
  return { ...original, runEndpointCapabilityCheck: vi.fn() }
})

import {
  EndpointCapabilityNotFoundError,
  runEndpointCapabilityCheck,
} from '../../src/lib/onboarding/capability-doctor'
import {
  GET as getOnboarding,
  PUT as putOnboarding,
} from '../../app/api/onboarding/status/route'
import { POST as checkCapabilities } from '../../app/api/endpoints/[id]/capability-check/route'
import { GET as getCapabilities } from '../../app/api/endpoints/[id]/capabilities/route'
import { PUT as updateEndpoint } from '../../app/api/endpoints/[id]/route'

function sampleProfile(endpointId: number): EndpointCapabilityProfile {
  return {
    endpointId,
    checkedAt: '2026-08-09T09:00:00.000Z',
    expiresAt: '2099-08-10T09:00:00.000Z',
    models: { supported: true, count: 1, error: null },
    chat: { supported: true, error: null },
    streaming: { supported: true, error: null },
    usage: { supported: true, error: null },
    tools: { supported: false, error: 'tools_not_supported' },
    reasoningContent: { supported: false, error: 'not_probed' },
    firstByteMs: 18,
    testedModel: 'model-a',
    diagnosticId: '87f97fc5-340e-4bfe-bd77-314203381182',
  }
}

describe('onboarding and capability API routes', () => {
  let db: Database.Database
  let endpointId: number

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    endpointId = Number(
      createRepositories(db).endpoints.insert({
        name: 'provider',
        base_url: 'https://provider.test',
        api_key: 'route-secret',
      }).lastInsertRowid,
    )
    globalThis.__db = db
    vi.mocked(runEndpointCapabilityCheck).mockReset()
  })

  afterEach(() => {
    delete globalThis.__db
    db.close()
  })

  it('GET and PUT onboarding status use the fixed safe response contract', async () => {
    const initial = await getOnboarding()
    expect(initial.status).toBe(200)
    expect(await initial.json()).toMatchObject({
      state: {
        schemaVersion: 1,
        completedAt: null,
        dismissedAt: null,
        selectedEndpointId: null,
        generatedPresetRevisionIds: [],
      },
      hasRunnableConfig: false,
      recommendedAction: 'start',
    })

    const updated = await putOnboarding(
      new Request('http://localhost/api/onboarding/status', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          dismissedAt: '2026-08-09T09:00:00.000Z',
          selectedEndpointId: endpointId,
        }),
      }),
    )
    expect(updated.status).toBe(200)
    const payload = await updated.json()
    expect(payload.state.dismissedAt).toBe('2026-08-09T09:00:00.000Z')
    expect(payload.state.selectedEndpointId).toBe(endpointId)
    expect(payload.recommendedAction).toBe('none')
    expect(JSON.stringify(payload)).not.toContain('route-secret')
  })

  it('PUT onboarding rejects unknown endpoint references', async () => {
    const response = await putOnboarding(
      new Request('http://localhost/api/onboarding/status', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ selectedEndpointId: 999 }),
      }),
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Endpoint not found' })
  })

  it('POST capability-check returns a direct profile without exposing keys', async () => {
    const profile = sampleProfile(endpointId)
    vi.mocked(runEndpointCapabilityCheck).mockResolvedValue(profile)

    const response = await checkCapabilities(
      new Request(
        `http://localhost/api/endpoints/${endpointId}/capability-check`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'model-a' }),
        },
      ),
      { params: Promise.resolve({ id: String(endpointId) }) },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(profile)
    expect(runEndpointCapabilityCheck).toHaveBeenCalledWith(
      db,
      endpointId,
      { model: 'model-a' },
    )
    expect(JSON.stringify(profile)).not.toContain('route-secret')
  })

  it('POST capability-check maps an unknown endpoint to 404', async () => {
    vi.mocked(runEndpointCapabilityCheck).mockRejectedValue(
      new EndpointCapabilityNotFoundError(999),
    )
    const response = await checkCapabilities(
      new Request('http://localhost/api/endpoints/999/capability-check', {
        method: 'POST',
        body: '{}',
      }),
      { params: Promise.resolve({ id: '999' }) },
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'endpoint_not_found' })
  })

  it('GET capabilities returns the persisted profile and a stable missing error', async () => {
    const profile = sampleProfile(endpointId)
    createOnboardingRepository(db).saveCapabilityProfile(profile)

    const response = await getCapabilities(
      new Request(`http://localhost/api/endpoints/${endpointId}/capabilities`),
      { params: Promise.resolve({ id: String(endpointId) }) },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(profile)

    const secondId = Number(
      createRepositories(db).endpoints.insert({
        name: 'unchecked',
        base_url: 'https://unchecked.test',
        api_key: 'another-secret',
      }).lastInsertRowid,
    )
    const missing = await getCapabilities(
      new Request(`http://localhost/api/endpoints/${secondId}/capabilities`),
      { params: Promise.resolve({ id: String(secondId) }) },
    )
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({
      error: 'capability_profile_not_found',
    })
  })

  it('does not serve expired profiles and invalidates a profile after endpoint edits', async () => {
    const expired = {
      ...sampleProfile(endpointId),
      expiresAt: '2000-01-01T00:00:00.000Z',
    }
    const repository = createOnboardingRepository(db)
    repository.saveCapabilityProfile(expired)

    const stale = await getCapabilities(
      new Request(`http://localhost/api/endpoints/${endpointId}/capabilities`),
      { params: Promise.resolve({ id: String(endpointId) }) },
    )
    expect(stale.status).toBe(410)
    expect(await stale.json()).toMatchObject({
      error: 'capability_profile_expired',
      expiresAt: expired.expiresAt,
    })

    repository.saveCapabilityProfile(sampleProfile(endpointId))
    const updateRequest = new Request(
      `http://localhost/api/endpoints/${endpointId}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'provider-updated' }),
      },
    ) as Parameters<typeof updateEndpoint>[0]
    const updated = await updateEndpoint(updateRequest, {
      params: Promise.resolve({ id: String(endpointId) }),
    })
    expect(updated.status).toBe(200)
    expect(repository.getCapabilityProfile(endpointId)).toBeNull()
  })
})
