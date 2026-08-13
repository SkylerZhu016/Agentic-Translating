import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../../src/lib/db/migrate'
import { createRepositories } from '../../src/lib/db/repositories'
import {
  AuthError,
  ToolsNotSupportedError,
  type ChatCompletionRequest,
  type LLMStreamEvent,
  type chatCompletion,
} from '../../src/lib/llm/client'
import { runEndpointCapabilityCheck } from '../../src/lib/onboarding/capability-doctor'
import { createOnboardingRepository } from '../../src/lib/onboarding/repository'

const databases: Database.Database[] = []

function setupEndpoint(apiKey = 'capability-secret') {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  databases.push(db)
  const endpointId = Number(
    createRepositories(db).endpoints.insert({
      name: 'provider',
      base_url: 'https://provider.test',
      chat_completions_path: '/v1/chat/completions',
      api_key: apiKey,
    }).lastInsertRowid,
  )
  return { db, endpointId }
}

async function* doneStream(
  transport: 'sse' | 'json_fallback' = 'sse',
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  },
): AsyncIterable<LLMStreamEvent> {
  yield { type: 'text', content: 'OK' }
  yield { type: 'done', content: 'OK', transport, ...(usage ? { usage } : {}) }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) db.close()
})

describe('endpoint capability doctor', () => {
  it('preserves successful chat, usage, and tools when other probes fail', async () => {
    const { db, endpointId } = setupEndpoint()
    let completionCall = 0
    const complete = vi.fn(
      async (_endpoint: unknown, request: ChatCompletionRequest) => {
        completionCall += 1
        if (completionCall === 1) {
          return {
            content: 'OK',
            usage: {
              prompt_tokens: 2,
              completion_tokens: 1,
              total_tokens: 3,
            },
          }
        }
        if (completionCall === 2) {
          request.onActivity?.()
          return doneStream('json_fallback', {
            prompt_tokens: 3,
            completion_tokens: 2,
            total_tokens: 5,
          })
        }
        return {
          content: '',
          toolCalls: [
            { id: 'call-1', name: 'capability_probe', arguments: '{}' },
          ],
        }
      },
    )
    const monotonicValues = [100, 127]

    const profile = await runEndpointCapabilityCheck(
      db,
      endpointId,
      { model: 'model-a' },
      {
        discoverModels: vi.fn(async () => {
          throw new Error('provider rejected capability-secret')
        }),
        complete: complete as unknown as typeof chatCompletion,
        now: () => new Date('2026-08-09T06:00:00.000Z'),
        monotonicNow: () => monotonicValues.shift() ?? 127,
        createDiagnosticId: () => '1ea656c5-c26f-47bf-8f26-3f05e06188f7',
      },
    )

    expect(profile.models.supported).toBe(false)
    expect(profile.models.error).toContain('[REDACTED]')
    expect(profile.models.error).not.toContain('capability-secret')
    expect(profile.chat).toEqual({ supported: true, error: null })
    expect(profile.usage).toEqual({ supported: true, error: null })
    expect(profile.streaming).toEqual({
      supported: false,
      error: 'provider_returned_json_fallback',
    })
    expect(profile.tools).toEqual({ supported: true, error: null })
    expect(profile.firstByteMs).toBe(27)
    expect(profile.reasoningContent).toEqual({
      supported: false,
      error: 'not_probed',
    })
    expect(JSON.stringify(profile)).not.toContain('capability-secret')

    const repository = createOnboardingRepository(db)
    expect(repository.getCapabilityProfile(endpointId)).toEqual(profile)
    expect(repository.getState()).toMatchObject({
      lastDoctorRunAt: '2026-08-09T06:00:00.000Z',
      selectedEndpointId: endpointId,
    })

    const ledgerRows = db.prepare(`
      SELECT session_id, run_id, invocation_id, endpoint_id, operation,
             requested_model, status, input_tokens, output_tokens,
             usage_source, first_byte_ms, latency_ms, error_code
      FROM llm_call_records
      ORDER BY operation
    `).all() as Array<Record<string, unknown>>
    expect(ledgerRows).toHaveLength(3)
    expect(ledgerRows.map((row) => row.operation)).toEqual([
      'capability.chat',
      'capability.stream',
      'capability.tools',
    ])
    expect(ledgerRows.every((row) =>
      row.session_id === null &&
      row.run_id === null &&
      row.invocation_id === null &&
      row.endpoint_id === endpointId &&
      row.requested_model === 'model-a' &&
      row.status === 'complete' &&
      typeof row.first_byte_ms === 'number' &&
      typeof row.latency_ms === 'number',
    )).toBe(true)
    expect(ledgerRows[0]).toMatchObject({
      input_tokens: 2,
      output_tokens: 1,
      usage_source: 'provider',
      error_code: null,
    })
    expect(ledgerRows[1]).toMatchObject({
      input_tokens: 3,
      output_tokens: 2,
      usage_source: 'provider',
      error_code: null,
    })
  })

  it('continues streaming and tool probes after the plain chat probe fails', async () => {
    const { db, endpointId } = setupEndpoint()
    let completionCall = 0
    const complete = vi.fn(
      async (_endpoint: unknown, request: ChatCompletionRequest) => {
        completionCall += 1
        if (completionCall === 1) throw new AuthError('bad key', 401)
        if (completionCall === 2) {
          request.onActivity?.()
          return doneStream('sse')
        }
        return {
          content: '',
          toolCalls: [
            { id: 'call-2', name: 'capability_probe', arguments: '{}' },
          ],
        }
      },
    )

    const profile = await runEndpointCapabilityCheck(
      db,
      endpointId,
      { model: 'model-a' },
      {
        discoverModels: vi.fn(async () => [
          { id: 'model-a', ownedBy: null },
        ]),
        complete: complete as unknown as typeof chatCompletion,
        now: () => new Date('2026-08-09T07:00:00.000Z'),
        monotonicNow: () => 10,
        createDiagnosticId: () => 'ad44e6ef-3912-4230-bfd1-5651214bb346',
      },
    )

    expect(profile.chat.supported).toBe(false)
    expect(profile.chat.error).toContain('auth_error:http_401')
    expect(profile.usage.supported).toBe(false)
    expect(profile.streaming.supported).toBe(true)
    expect(profile.tools.supported).toBe(true)
    expect(completionCall).toBe(3)
    expect(db.prepare(`
      SELECT operation, status, error_code
      FROM llm_call_records
      ORDER BY operation
    `).all()).toEqual([
      {
        operation: 'capability.chat',
        status: 'failed',
        error_code: 'auth_error',
      },
      {
        operation: 'capability.stream',
        status: 'complete',
        error_code: null,
      },
      {
        operation: 'capability.tools',
        status: 'complete',
        error_code: null,
      },
    ])
  })

  it('records unsupported tools without erasing other probe results', async () => {
    const { db, endpointId } = setupEndpoint()
    let completionCall = 0
    const complete = vi.fn(
      async (_endpoint: unknown, request: ChatCompletionRequest) => {
        completionCall += 1
        if (completionCall === 1) return { content: 'OK' }
        if (completionCall === 2) {
          request.onActivity?.()
          return doneStream('sse')
        }
        throw new ToolsNotSupportedError('tools are not supported')
      },
    )

    const profile = await runEndpointCapabilityCheck(
      db,
      endpointId,
      { model: 'model-a' },
      {
        discoverModels: vi.fn(async () => [
          { id: 'model-a', ownedBy: null },
        ]),
        complete: complete as unknown as typeof chatCompletion,
        now: () => new Date('2026-08-09T08:00:00.000Z'),
        monotonicNow: () => 10,
        createDiagnosticId: () => 'd10cf5fc-246d-49c6-96fd-024343d077a4',
      },
    )

    expect(profile.models.supported).toBe(true)
    expect(profile.chat.supported).toBe(true)
    expect(profile.usage).toEqual({
      supported: false,
      error: 'usage_not_returned',
    })
    expect(profile.streaming.supported).toBe(true)
    expect(profile.tools.supported).toBe(false)
    expect(profile.tools.error).toContain('tools_not_supported')
  })

  it('records an empty plain-chat probe as a safe failed call', async () => {
    const { db, endpointId } = setupEndpoint()
    let completionCall = 0
    const complete = vi.fn(
      async (_endpoint: unknown, request: ChatCompletionRequest) => {
        completionCall += 1
        if (completionCall === 1) {
          return {
            content: '',
            usage: {
              prompt_tokens: 4,
              completion_tokens: 0,
              total_tokens: 4,
            },
          }
        }
        if (completionCall === 2) return doneStream('sse')
        request.onActivity?.()
        return {
          content: '',
          toolCalls: [
            { id: 'call-tool-only', name: 'capability_probe', arguments: '{}' },
          ],
        }
      },
    )

    const profile = await runEndpointCapabilityCheck(
      db,
      endpointId,
      { model: 'model-a' },
      {
        discoverModels: vi.fn(async () => [{ id: 'model-a', ownedBy: null }]),
        complete: complete as unknown as typeof chatCompletion,
        createDiagnosticId: () => '532c39c7-b956-4a77-8221-8740df38128f',
      },
    )

    expect(profile.chat).toEqual({ supported: false, error: 'empty_response' })
    expect(profile.usage).toEqual({ supported: true, error: null })
    expect(profile.streaming.supported).toBe(true)
    expect(profile.tools.supported).toBe(true)
    expect(db.prepare(`
      SELECT status, input_tokens, output_tokens, usage_source, error_code
      FROM llm_call_records
      WHERE operation = 'capability.chat'
    `).get()).toEqual({
      status: 'failed',
      input_tokens: 4,
      output_tokens: 0,
      usage_source: 'provider',
      error_code: 'empty_response',
    })
    expect(db.prepare(`
      SELECT status, error_code
      FROM llm_call_records
      WHERE operation = 'capability.tools'
    `).get()).toEqual({ status: 'complete', error_code: null })
  })

  it('uses the discovered model when the request omits one', async () => {
    const { db, endpointId } = setupEndpoint()
    const requestedModels: string[] = []
    let completionCall = 0
    const complete = vi.fn(
      async (_endpoint: unknown, request: ChatCompletionRequest) => {
        requestedModels.push(request.model)
        completionCall += 1
        if (completionCall === 1) return { content: 'OK' }
        if (completionCall === 2) {
          request.onActivity?.()
          return doneStream('sse')
        }
        return {
          content: '',
          toolCalls: [
            { id: 'call-3', name: 'capability_probe', arguments: '{}' },
          ],
        }
      },
    )

    const profile = await runEndpointCapabilityCheck(db, endpointId, {}, {
      discoverModels: vi.fn(async () => [
        { id: 'discovered-model', ownedBy: null },
      ]),
      complete: complete as unknown as typeof chatCompletion,
      now: () => new Date('2026-08-09T09:00:00.000Z'),
      monotonicNow: () => 10,
      createDiagnosticId: () => '3fe9d56b-e0ce-4102-8063-e5f8677e1705',
    })

    expect(profile.testedModel).toBe('discovered-model')
    expect(requestedModels).toEqual([
      'discovered-model',
      'discovered-model',
      'discovered-model',
    ])
  })

  it('persists every sub-result when no test model can be selected', async () => {
    const { db, endpointId } = setupEndpoint()
    const complete = vi.fn()
    const profile = await runEndpointCapabilityCheck(db, endpointId, {}, {
      discoverModels: vi.fn(async () => []),
      complete: complete as unknown as typeof chatCompletion,
      now: () => new Date('2026-08-09T10:00:00.000Z'),
      createDiagnosticId: () => '7e3351fc-2d24-4137-a1a3-b4bd6bb89e30',
    })

    expect(profile.testedModel).toBe('')
    expect(profile.models).toEqual({ supported: true, count: 0, error: null })
    expect(profile.chat.error).toBe('no_test_model')
    expect(profile.streaming.error).toBe('no_test_model')
    expect(profile.usage.error).toBe('no_test_model')
    expect(profile.tools.error).toBe('no_test_model')
    expect(complete).not.toHaveBeenCalled()
    expect(
      createOnboardingRepository(db).getCapabilityProfile(endpointId),
    ).toEqual(profile)
    expect(
      db.prepare('SELECT COUNT(*) FROM llm_call_records').pluck().get(),
    ).toBe(0)
  })

  it('returns probe results even when the accounting table is unavailable', async () => {
    const { db, endpointId } = setupEndpoint()
    db.exec('DROP TABLE llm_call_records')
    let completionCall = 0
    const complete = vi.fn(
      async (_endpoint: unknown, request: ChatCompletionRequest) => {
        completionCall += 1
        if (completionCall === 2) return doneStream('sse')
        if (completionCall === 3) {
          return {
            content: '',
            toolCalls: [
              { id: 'call-ledger-down', name: 'capability_probe', arguments: '{}' },
            ],
          }
        }
        request.onActivity?.()
        return { content: 'OK' }
      },
    )

    const profile = await runEndpointCapabilityCheck(
      db,
      endpointId,
      { model: 'model-a' },
      {
        discoverModels: vi.fn(async () => [{ id: 'model-a', ownedBy: null }]),
        complete: complete as unknown as typeof chatCompletion,
        createDiagnosticId: () => 'e5e138b1-4b56-4b95-aac0-4c3f1a381d7c',
      },
    )

    expect(profile.chat.supported).toBe(true)
    expect(profile.streaming.supported).toBe(true)
    expect(profile.tools.supported).toBe(true)
    expect(completionCall).toBe(3)
  })
})
