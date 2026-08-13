import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../../src/lib/db/migrate'
import { seed } from '../../src/lib/db/seed'
import { createRepositories } from '../../src/lib/db/repositories'

vi.mock('../../src/lib/llm/client', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../src/lib/llm/client')>()
  return {
    ...original,
    chatCompletion: vi.fn(),
  }
})

import {
  AuthError,
  chatCompletion,
  type ChatCompletionRequest,
} from '../../src/lib/llm/client'
import { POST as testSavedAgent } from '../../app/api/agent-catalog/[id]/test/route'
import { POST as previewAgent } from '../../app/api/agent-catalog/preview/route'

function request(body: unknown) {
  return new Request('http://localhost/api/agent-catalog/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('Agent test LLM ledger integration', () => {
  let db: Database.Database
  let endpointId: number

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    seed(db)
    endpointId = Number(
      createRepositories(db).endpoints.insert({
        name: 'private endpoint name',
        base_url: 'https://private.example.invalid/tenant-path',
        chat_completions_path: '/v1/chat/completions',
        api_key: 'temporary-test-key',
      }).lastInsertRowid,
    )
    globalThis.__db = db
    vi.mocked(chatCompletion).mockReset()
  })

  afterEach(() => {
    delete globalThis.__db
    db.close()
  })

  it('records a saved-Agent physical request with provider usage', async () => {
    vi.mocked(chatCompletion).mockImplementation(
      async (_endpoint, llmRequest: ChatCompletionRequest) => {
        llmRequest.onActivity?.()
        return {
          content: 'translated body\n---\nprivate annotation',
          usage: {
            prompt_tokens: 31,
            completion_tokens: 7,
            total_tokens: 38,
          },
        }
      },
    )

    const response = await testSavedAgent(request({
      sourceText: 'PRIVATE-SOURCE-MUST-NOT-BE-LEDGERED',
      endpointId,
      model: 'provider/model-v1',
    }), {
      params: Promise.resolve({ id: 'semantic-fidelity.en-to-zh' }),
    })

    expect(response.status).toBe(200)
    expect((await response.json()).body).toBe('translated body')
    const row = db.prepare(`
      SELECT session_id, run_id, invocation_id, endpoint_id, operation,
             requested_model, status, input_tokens, output_tokens,
             reasoning_tokens, usage_source, first_byte_ms, latency_ms,
             error_code
      FROM llm_call_records
    `).get() as Record<string, unknown>
    expect(row).toMatchObject({
      session_id: null,
      run_id: null,
      invocation_id: null,
      endpoint_id: endpointId,
      operation: 'agent.test',
      requested_model: 'provider/model-v1',
      status: 'complete',
      input_tokens: 31,
      output_tokens: 7,
      reasoning_tokens: null,
      usage_source: 'provider',
      error_code: null,
    })
    expect(typeof row.first_byte_ms).toBe('number')
    expect(typeof row.latency_ms).toBe('number')
    const persisted = JSON.stringify(row)
    expect(persisted).not.toContain('PRIVATE-SOURCE-MUST-NOT-BE-LEDGERED')
    expect(persisted).not.toContain('private annotation')
    expect(persisted).not.toContain('temporary-test-key')
    expect(persisted).not.toContain('private.example.invalid')
  })

  it('records an unsaved prompt preview under the same safe operation', async () => {
    vi.mocked(chatCompletion).mockResolvedValue({ content: 'preview result' })

    const response = await previewAgent(request({
      direction: 'en_to_zh',
      promptLanguage: 'zh',
      rolePrompt: 'Inspect meaning and produce a complete translation.',
      sourceText: 'Preview source.',
      taskBrief: '',
      additionalInstruction: '',
      endpointId,
      model: 'preview-model',
    }))

    expect(response.status).toBe(200)
    expect(db.prepare(`
      SELECT endpoint_id, operation, requested_model, status
      FROM llm_call_records
    `).get()).toEqual({
      endpoint_id: endpointId,
      operation: 'agent.test',
      requested_model: 'preview-model',
      status: 'complete',
    })
  })

  it('stores only a controlled code when the provider request fails', async () => {
    const privateError =
      'provider exposed private tenant detail and temporary-test-key'
    vi.mocked(chatCompletion).mockRejectedValue(
      new AuthError(privateError, 401),
    )

    const response = await testSavedAgent(request({
      sourceText: 'private source',
      endpointId,
      model: 'test-model',
    }), {
      params: Promise.resolve({ id: 'semantic-fidelity.en-to-zh' }),
    })

    expect(response.status).toBe(502)
    const publicError = await response.json() as {
      error: string
      diagnosticId: string
    }
    expect(publicError).toEqual({
      error: 'agent_test_failed',
      diagnosticId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    })
    expect(JSON.stringify(publicError)).not.toContain(privateError)
    expect(JSON.stringify(publicError)).not.toContain('temporary-test-key')
    const rows = db.prepare('SELECT * FROM llm_call_records').all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      endpoint_id: endpointId,
      operation: 'agent.test',
      requested_model: 'test-model',
      status: 'failed',
      error_code: 'auth_error',
    })
    const persisted = JSON.stringify(rows)
    expect(persisted).not.toContain(privateError)
    expect(persisted).not.toContain('temporary-test-key')
  })

  it('returns the same safe diagnostic DTO for an unsaved preview failure', async () => {
    const privateError =
      'https://private.example.invalid/tenant-path temporary-test-key Preview source.'
    vi.mocked(chatCompletion).mockRejectedValue(new Error(privateError))

    const response = await previewAgent(request({
      direction: 'en_to_zh',
      promptLanguage: 'zh',
      rolePrompt: 'Private role prompt.',
      sourceText: 'Preview source.',
      taskBrief: '',
      additionalInstruction: '',
      endpointId,
      model: 'preview-model',
    }))

    expect(response.status).toBe(502)
    const publicError = await response.json() as {
      error: string
      diagnosticId: string
    }
    expect(publicError.error).toBe('agent_test_failed')
    expect(publicError.diagnosticId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    const encoded = JSON.stringify(publicError)
    expect(encoded).not.toContain(privateError)
    expect(encoded).not.toContain('private.example.invalid')
    expect(encoded).not.toContain('temporary-test-key')
    expect(encoded).not.toContain('Preview source.')
    expect(encoded).not.toContain('Private role prompt.')
  })

  it('records an empty Agent response as failed instead of complete', async () => {
    vi.mocked(chatCompletion).mockResolvedValue({
      content: '',
      usage: {
        prompt_tokens: 9,
        completion_tokens: 0,
        total_tokens: 9,
      },
    })

    const response = await testSavedAgent(request({
      sourceText: 'Source.',
      endpointId,
      model: 'test-model',
    }), {
      params: Promise.resolve({ id: 'semantic-fidelity.en-to-zh' }),
    })

    expect(response.status).toBe(502)
    expect(db.prepare(`
      SELECT status, input_tokens, output_tokens, usage_source, error_code
      FROM llm_call_records
    `).get()).toEqual({
      status: 'failed',
      input_tokens: 9,
      output_tokens: 0,
      usage_source: 'provider',
      error_code: 'empty_response',
    })
  })

  it('returns the Agent result when the accounting table is unavailable', async () => {
    db.exec('DROP TABLE llm_call_records')
    vi.mocked(chatCompletion).mockResolvedValue({ content: 'result survives' })

    const response = await testSavedAgent(request({
      sourceText: 'Source.',
      endpointId,
      model: 'test-model',
    }), {
      params: Promise.resolve({ id: 'semantic-fidelity.en-to-zh' }),
    })

    expect(response.status).toBe(200)
    expect((await response.json()).body).toBe('result survives')
  })
})
