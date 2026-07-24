import { describe, expect, it } from 'vitest'
import {
  redactSecrets,
  toPublicEndpointDto,
} from '../../src/lib/security/public-dto'

describe('public DTO secret redaction', () => {
  it('removes nested snake_case and camelCase API keys', () => {
    const input = {
      api_key: 'root-secret',
      endpoints: [
        { name: 'one', apiKey: 'nested-secret', hasApiKey: true },
      ],
    }
    const output = redactSecrets(input)
    expect(JSON.stringify(output)).not.toContain('root-secret')
    expect(JSON.stringify(output)).not.toContain('nested-secret')
    expect(output.endpoints[0].hasApiKey).toBe(true)
  })

  it('returns only a has_api_key marker for endpoint DTOs', () => {
    const output = toPublicEndpointDto({
      id: 1,
      name: 'endpoint',
      base_url: 'https://example.test/v1',
      api_key: 'secret',
      context_window: 128000,
      created_at: '2026-01-01',
    })
    expect(output.has_api_key).toBe(true)
    expect(output).not.toHaveProperty('api_key')
  })
})
