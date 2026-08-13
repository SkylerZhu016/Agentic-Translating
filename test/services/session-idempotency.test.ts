import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { migrate } from '../../src/lib/db/migrate'
import { seed } from '../../src/lib/db/seed'
import { createRepositories } from '../../src/lib/db/repositories'
import { createVNextRepositories } from '../../src/lib/db/vnext-repositories'
import { createHandlers } from '../../app/api/sessions/handlers'

describe('session creation idempotency', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    seed(db)
    const repos = createRepositories(db)
    repos.endpoints.insert({
      name: 'test',
      base_url: 'https://example.test',
      chat_completions_path: '/v1/chat/completions',
      api_key: 'test-key',
    })
    repos.coordinatorConfig.upsert({
      endpoint_id: 1,
      model: 'test-model',
      chat_endpoint_id: 1,
      chat_model: 'test-model',
    })
  })

  afterEach(() => db.close())

  it('returns the same session for the same clientRequestId', async () => {
    const POST = createHandlers(db).POST
    const clientRequestId = crypto.randomUUID()
    const makeRequest = () =>
      new NextRequest('http://localhost/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientRequestId,
          sourceText: 'Hello',
          direction: 'en_to_zh',
        }),
      })

    const first = await (await POST(makeRequest())).json()
    const second = await (await POST(makeRequest())).json()

    expect(second.id).toBe(first.id)
    expect(
      (
        db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as {
          count: number
        }
      ).count,
    ).toBe(1)
    expect(
      (
        db.prepare(
          `SELECT request_hash FROM session_idempotency_records
           WHERE client_request_id=?`,
        ).get(clientRequestId) as { request_hash: string }
      ).request_hash,
    ).toMatch(/^[0-9a-f]{64}$/)
  })

  it.each([
    {
      label: 'source',
      first: { sourceText: 'Hello' },
      second: { sourceText: 'Different source' },
    },
    {
      label: 'configuration',
      first: {
        sourceText: 'Hello',
        constraints: { preserveParagraphs: true },
      },
      second: {
        sourceText: 'Hello',
        constraints: { preserveParagraphs: false },
      },
    },
  ])('rejects the same key with a different $label', async ({ first, second }) => {
    const POST = createHandlers(db).POST
    const clientRequestId = crypto.randomUUID()
    const request = (overrides: Record<string, unknown>) =>
      new NextRequest('http://localhost/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientRequestId,
          direction: 'en_to_zh',
          ...overrides,
        }),
      })

    expect((await POST(request(first))).status).toBe(200)
    const conflict = await POST(request(second))

    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual(
      expect.objectContaining({ error: 'idempotency_conflict' }),
    )
    expect(
      (
        db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as {
          count: number
        }
      ).count,
    ).toBe(1)
  })

  it('safely backfills a compatible legacy session request', async () => {
    const POST = createHandlers(db).POST
    const clientRequestId = crypto.randomUUID()
    const makeRequest = () =>
      new NextRequest('http://localhost/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientRequestId,
          sourceText: 'Legacy replay',
          direction: 'en_to_zh',
        }),
      })

    const first = await (await POST(makeRequest())).json()
    db.prepare(
      'DELETE FROM session_idempotency_records WHERE client_request_id=?',
    ).run(clientRequestId)

    const replay = await POST(makeRequest())
    expect(replay.status).toBe(200)
    expect((await replay.json()).id).toBe(first.id)
    expect(
      db.prepare(
        `SELECT session_id FROM session_idempotency_records
         WHERE client_request_id=?`,
      ).get(clientRequestId),
    ).toEqual({ session_id: first.id })
  })

  it('backfills an equivalent legacy preset replay with preset-overridden Agent IDs', async () => {
    const vnext = createVNextRepositories(db)
    const variants = vnext.agents.listVariants('en_to_zh', false)
    const binding = {
      endpointId: 1,
      model: 'test-model',
      contextWindow: null,
    }
    vnext.workflowPresets.create(
      {
        id: 'idempotency-preset',
        name: 'Idempotency preset',
        description: '',
        direction: 'en_to_zh',
      },
      {
        id: 'idempotency-preset-r1',
        presetId: 'idempotency-preset',
        revisionNo: 1,
        contract: {
          sourceLang: 'English',
          targetLang: 'Chinese',
          taskBriefTemplate: '',
          teamPolicy: 'dynamic',
          reviewMode: 'main_editor',
          agentVariantIds: variants.map((variant) => variant.id),
          agentVariantSnapshots: variants,
          defaultWorkerBinding: binding,
          agentBindingOverrides: {},
          mainAgentBinding: binding,
          editingAgentBinding: binding,
          promptBundleVersion: 1,
          maxAgentCalls: 5,
          batchConcurrency: 2,
          constraints: {},
        },
        createdAt: new Date().toISOString(),
      },
    )
    const clientRequestId = crypto.randomUUID()
    const makeRequest = () =>
      new NextRequest('http://localhost/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientRequestId,
          sourceText: 'Preset replay',
          direction: 'en_to_zh',
          presetRevisionId: 'idempotency-preset-r1',
          allowedAgentVariantIds: variants.map((variant) => variant.id),
        }),
      })

    const POST = createHandlers(db).POST
    const first = await (await POST(makeRequest())).json()
    db.prepare(
      'DELETE FROM session_idempotency_records WHERE client_request_id=?',
    ).run(clientRequestId)

    const replay = await POST(makeRequest())
    expect(replay.status).toBe(200)
    expect((await replay.json()).id).toBe(first.id)
  })
})
