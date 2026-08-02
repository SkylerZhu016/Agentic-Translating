import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../../src/lib/db/migrate'
import { createRepositories } from '../../src/lib/db/repositories'

vi.mock('../../src/lib/llm/model-discovery', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../src/lib/llm/model-discovery')>()
  return {
    ...original,
    discoverEndpointModels: vi.fn(),
  }
})

import { discoverEndpointModels } from '../../src/lib/llm/model-discovery'
import { GET } from '../../app/api/endpoints/[id]/models/route'

describe('GET /api/endpoints/:id/models', () => {
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
        chat_completions_path: '/v1/chat/completions',
        api_key: 'route-secret',
      }).lastInsertRowid,
    )
    globalThis.__db = db
    vi.mocked(discoverEndpointModels).mockReset()
  })

  afterEach(() => {
    delete globalThis.__db
    db.close()
  })

  it('returns only the safe model catalogue', async () => {
    vi.mocked(discoverEndpointModels).mockResolvedValue([
      { id: 'glm-5.2', ownedBy: null },
    ])

    const response = await GET(new Request('http://localhost'), {
      params: Promise.resolve({ id: String(endpointId) }),
    })
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload.models).toEqual([{ id: 'glm-5.2', ownedBy: null }])
    expect(JSON.stringify(payload)).not.toContain('route-secret')
    expect(discoverEndpointModels).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://provider.test',
        chatCompletionsPath: '/v1/chat/completions',
        apiKey: 'route-secret',
      }),
    )
  })

  it('rejects unknown endpoints without making a provider request', async () => {
    const response = await GET(new Request('http://localhost'), {
      params: Promise.resolve({ id: '9999' }),
    })

    expect(response.status).toBe(404)
    expect(discoverEndpointModels).not.toHaveBeenCalled()
  })
})
