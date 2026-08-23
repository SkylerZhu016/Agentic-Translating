import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConfigSnapshot } from '@/src/lib/contracts/types'
import { chatCompletion, isAsyncIterable } from '@/src/lib/llm/client'
import { encryptSecret } from '@/src/lib/security/secrets'
import {
  RuntimeEndpointCredentialError,
  currentRuntimeEndpoint,
  resolveRuntimeEndpoint,
  withoutSnapshotCredentials,
} from '@/src/lib/services/runtime-endpoint-credentials'

describe('runtime endpoint credential rotation', () => {
  let db: Database.Database | null = null

  afterEach(() => {
    vi.unstubAllGlobals()
    db?.close()
    db = null
  })

  function setup(currentKey = 'sk-current') {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE endpoints (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        chat_completions_path TEXT NOT NULL,
        api_key TEXT NOT NULL,
        context_window INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1
      )
    `)
    db.prepare(`
      INSERT INTO endpoints (
        id, name, base_url, chat_completions_path, api_key,
        context_window, enabled
      ) VALUES (1, 'live-name', 'https://live.invalid', '/live/chat', ?, 65536, 1)
    `).run(encryptSecret(currentKey))
    const snapshot = {
      version: 3,
      endpoint: null,
      agents: [],
      coordinator: null,
      prompts: {},
      endpointSnapshots: [{
        id: 1,
        name: 'frozen-name',
        baseUrl: 'https://frozen.invalid',
        chatCompletionsPath: '/frozen/chat',
        apiKey: encryptSecret('sk-rotated-away'),
        hasApiKey: true,
        contextWindow: 131_072,
      }],
    } as unknown as ConfigSnapshot
    return { db, snapshot }
  }

  it('uses every connection field from the same live row and ignores frozen wire data', () => {
    const fixture = setup('sk-first-current')
    expect(resolveRuntimeEndpoint(fixture.db, fixture.snapshot, 1)).toEqual({
      id: 1,
      name: 'live-name',
      baseUrl: 'https://live.invalid',
      chatCompletionsPath: '/live/chat',
      contextWindow: 65_536,
      apiKey: 'sk-first-current',
    })

    fixture.db.prepare(`
      UPDATE endpoints
      SET base_url='https://rotated.invalid',
          chat_completions_path='/rotated/chat', api_key=?
      WHERE id=1
    `).run(encryptSecret('sk-rotated-current'))

    expect(resolveRuntimeEndpoint(fixture.db, fixture.snapshot, 1)).toMatchObject({
      baseUrl: 'https://rotated.invalid',
      chatCompletionsPath: '/rotated/chat',
      apiKey: 'sk-rotated-current',
    })
  })

  it('re-resolves live URL, path, and key together immediately before fetch', async () => {
    const fixture = setup('sk-before-rotation')
    const stale = resolveRuntimeEndpoint(fixture.db, fixture.snapshot, 1)
    fixture.db.prepare(`
      UPDATE endpoints
      SET base_url='https://current.invalid',
          chat_completions_path='/current/chat', api_key=?
      WHERE id=1
    `).run(encryptSecret('sk-current-at-fetch'))

    const fetchMock = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => new Response(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: { content: 'ok' },
      }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await chatCompletion({
      ...stale,
      resolveRuntimeEndpoint: () => currentRuntimeEndpoint(fixture.db, 1),
    }, {
      model: 'test-model',
      messages: [{ role: 'user', content: 'test' }],
      stream: false,
    })
    expect(isAsyncIterable(result)).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://current.invalid/current/chat')
    expect((init?.headers as Record<string, string>).Authorization)
      .toBe('Bearer sk-current-at-fetch')
    expect(String(url)).not.toContain('frozen.invalid')
    expect(JSON.stringify(init)).not.toContain('sk-rotated-away')
  })

  it('fails explicitly when the frozen endpoint was deleted or its current key is empty', () => {
    const fixture = setup()
    fixture.db.prepare('DELETE FROM endpoints WHERE id=1').run()
    expect(() => resolveRuntimeEndpoint(fixture.db, fixture.snapshot, 1))
      .toThrowError(RuntimeEndpointCredentialError)

    fixture.db.prepare(`
      INSERT INTO endpoints (
        id, name, base_url, chat_completions_path, api_key,
        context_window, enabled
      ) VALUES (1, 'live-name', 'https://live.invalid', '/live/chat', ?, 65536, 1)
    `).run(encryptSecret(''))
    try {
      resolveRuntimeEndpoint(fixture.db, fixture.snapshot, 1)
      throw new Error('expected unavailable key failure')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'runtime_endpoint_key_unavailable',
        endpointId: 1,
      })
    }
  })

  it('fails closed for disabled or invalid live endpoints without snapshot fallback', () => {
    const fixture = setup()
    fixture.db.prepare('UPDATE endpoints SET enabled=0 WHERE id=1').run()
    try {
      resolveRuntimeEndpoint(fixture.db, fixture.snapshot, 1)
      throw new Error('expected disabled endpoint failure')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'runtime_endpoint_disabled', endpointId: 1,
      })
    }

    fixture.db.prepare(`
      UPDATE endpoints
      SET enabled=1, base_url='javascript:alert(1)'
      WHERE id=1
    `).run()
    try {
      resolveRuntimeEndpoint(fixture.db, fixture.snapshot, 1)
      throw new Error('expected invalid endpoint failure')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'runtime_endpoint_address_invalid', endpointId: 1,
      })
    }

    fixture.db.prepare(`
      UPDATE endpoints
      SET base_url='https://live.invalid', api_key=?
      WHERE id=1
    `).run(encryptSecret(''))
    try {
      resolveRuntimeEndpoint(fixture.db, fixture.snapshot, 1)
      throw new Error('expected unavailable key failure')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'runtime_endpoint_key_unavailable', endpointId: 1,
      })
    }
  })

  it('never falls back to a frozen address or snapshot key when the live row fails', async () => {
    const fixture = setup()
    fixture.db.prepare('UPDATE endpoints SET api_key=? WHERE id=1')
      .run(encryptSecret(''))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(chatCompletion({
      baseUrl: 'https://hostile-frozen.invalid',
      chatCompletionsPath: '/frozen/chat',
      apiKey: 'snapshot-key-must-not-be-used',
      resolveRuntimeEndpoint: () => currentRuntimeEndpoint(fixture.db, 1),
    }, {
      model: 'test-model',
      messages: [{ role: 'user', content: 'test' }],
      stream: false,
    })).rejects.toMatchObject({ code: 'runtime_endpoint_key_unavailable' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps an unreadable encrypted credential to the stable unavailable-key error', () => {
    const fixture = setup()
    fixture.db.prepare('UPDATE endpoints SET api_key=? WHERE id=1')
      .run('enc:v1:not-valid-ciphertext')

    try {
      resolveRuntimeEndpoint(fixture.db, fixture.snapshot, 1)
      throw new Error('expected unavailable key failure')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'runtime_endpoint_key_unavailable',
        endpointId: 1,
      })
    }
  })

  it('removes legacy credential copies without changing frozen metadata', () => {
    const legacy = {
      version: 3,
      endpoint: {
        id: 1,
        base_url: 'https://frozen.invalid',
        api_key: 'one',
        apiKey: 'camel-one',
      },
      endpoints: [{
        id: 1,
        base_url: 'https://frozen.invalid',
        api_key: 'two',
        apiKey: 'camel-two',
      }],
      endpointSnapshots: [{
        id: 1,
        baseUrl: 'https://frozen.invalid',
        apiKey: 'three',
        hasApiKey: true,
        headers: {
          Authorization: 'opaque-authorization',
          'X-Api-Key': 'opaque-x-api-key',
          'X-Trace-Id': 'preserve-trace-id',
        },
      }],
      workflowHash: 'must-stay-identical',
    }

    const sanitized = withoutSnapshotCredentials(legacy)
    expect(JSON.stringify(sanitized)).not.toContain('one')
    expect(JSON.stringify(sanitized)).not.toContain('two')
    expect(JSON.stringify(sanitized)).not.toContain('three')
    expect(JSON.stringify(sanitized)).not.toContain('camel-one')
    expect(JSON.stringify(sanitized)).not.toContain('camel-two')
    expect(JSON.stringify(sanitized)).not.toContain('opaque-authorization')
    expect(JSON.stringify(sanitized)).not.toContain('opaque-x-api-key')
    expect(sanitized).toMatchObject({
      endpoint: { id: 1, base_url: 'https://frozen.invalid' },
      endpoints: [{ id: 1, base_url: 'https://frozen.invalid' }],
      endpointSnapshots: [{
        id: 1,
        baseUrl: 'https://frozen.invalid',
        hasApiKey: true,
        headers: { 'X-Trace-Id': 'preserve-trace-id' },
      }],
      workflowHash: 'must-stay-identical',
    })
  })

  it.each([null, [], 'snapshot', 42, true])(
    'rejects non-object snapshot root %j without reflecting its content',
    (invalidRoot) => {
      expect(() => withoutSnapshotCredentials(invalidRoot))
        .toThrow('snapshot_root_invalid')
      try {
        withoutSnapshotCredentials(invalidRoot)
      } catch (error) {
        expect(error instanceof Error ? error.message : String(error))
          .not.toContain(JSON.stringify(invalidRoot)!)
      }
    },
  )

  it.each([
    { endpoint: [{ api_key: 'opaque-endpoint' }] },
    { endpoints: { api_key: 'opaque-endpoints' } },
    { endpoints: ['opaque-entry'] },
    { endpointSnapshots: { apiKey: 'opaque-snapshots' } },
    { endpointSnapshots: [null] },
  ])('rejects invalid known endpoint container shape %#', (invalidSnapshot) => {
    expect(() => withoutSnapshotCredentials(invalidSnapshot))
      .toThrow('snapshot_container_invalid')
  })
})
