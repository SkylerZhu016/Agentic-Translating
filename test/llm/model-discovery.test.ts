import { describe, expect, it, vi } from 'vitest'
import {
  discoverEndpointModels,
} from '../../src/lib/llm/model-discovery'

describe('model discovery', () => {
  it('uses the provider model endpoint without exposing credentials in output', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://provider.test/v1/models')
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Bearer temporary-secret',
      )
      return Response.json({
        data: [
          { id: 'glm-5.2', owned_by: 'provider' },
          { id: 'deepseek-v4-flash' },
          { id: 'glm-5.2', owned_by: 'duplicate' },
          { malformed: true },
        ],
      })
    })

    const models = await discoverEndpointModels(
      {
        baseUrl: 'https://provider.test',
        chatCompletionsPath: '/v1/chat/completions',
        apiKey: 'temporary-secret',
      },
      { fetchImpl: fetchImpl as typeof fetch },
    )

    expect(models).toEqual([
      { id: 'deepseek-v4-flash', ownedBy: null },
      { id: 'glm-5.2', ownedBy: 'duplicate' },
    ])
    expect(JSON.stringify(models)).not.toContain('temporary-secret')
  })

  it('returns a concise error instead of proxying an upstream response body', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('<html>private upstream error</html>', { status: 502 }),
    )

    await expect(
      discoverEndpointModels(
        {
          baseUrl: 'https://provider.test',
          apiKey: 'secret',
        },
        { fetchImpl: fetchImpl as typeof fetch },
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'ModelDiscoveryError',
        message: '模型列表请求失败（HTTP 502）',
        status: 502,
      }),
    )
  })
})
