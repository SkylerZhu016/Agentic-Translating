/**
 * Chat SSE Route integration tests — Wave 3 Task 19
 *
 * Tests the POST /api/sessions/:id/chat route:
 *   - State guards (wrong state → 409)
 *   - Input validation (missing message → 400, missing session → 404)
 *   - SSE streaming with mock LLM (message + edit turns)
 *   - Selection context in user message
 *   - Protocol fallback hint in SSE stream
 *   - Version persistence after edits
 *   - Coordinating → 409 rejection
 *
 * Uses :memory: DB with mock LLM HTTP servers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { NextRequest } from 'next/server'
import { createRepositories } from '@/src/lib/db/repositories'
import { createSessionService } from '@/src/lib/services/session-service'
import {
  buildRevisionReferenceMessage,
  createChatHandlers,
  resolveChatConfig,
  resolveChatReviewConfig,
} from '@/src/lib/handlers/chat-handler'
import type { ConfigSnapshot } from '@/src/lib/contracts/types'
import type { ConfigSnapshotVNext, ModelBinding } from '@/src/lib/contracts/vnext'
import { encodeSSE, parseSSEChunk } from '@/src/lib/contracts/sse'
import { startMockLLM, type MockLLMInstance } from '../fixtures/mock-llm'
import {
  createProjectRepositories,
  estimateProjectContextTokens,
} from '@/src/lib/db/project-repositories'
import { getChatActivity } from '@/src/lib/chat/activity'
import { runSessionPreflight } from '@/src/lib/services/session-preflight'
import { currentRuntimeEndpoint } from '@/src/lib/services/runtime-endpoint-credentials'

// Inline migration SQL
const MIGRATION_SQL_0001 = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/db/migrations/0001_init.sql'),
  'utf-8',
)
const MIGRATION_SQL_0002 = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/db/migrations/0002_presets_and_drop_parsed_output.sql'),
  'utf-8',
)
const MIGRATION_SQL_0009 = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/db/migrations/0009_project_translation_memory.sql'),
  'utf-8',
)
const MIGRATION_SQL_0011 = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/db/migrations/0011_llm_call_records.sql'),
  'utf-8',
)

// =============================================================================
// Helpers
// =============================================================================

/** Parse an SSE response body into an array of {event, data} objects */
async function readSSEEvents(response: Response): Promise<Array<{ event: string; data: unknown }>> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: true })
    if (done) break
  }

  // Flush any remaining decoded text
  buffer += decoder.decode()

  const parsed = parseSSEChunk(buffer)
  return parsed.map((e) => ({
    event: e.event,
    data: tryParseJSON(e.data),
  }))
}

function tryParseJSON(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

async function withTestDeadline<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = 1_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

/** Restore a previously taken snapshot to session config */
function setSnapshotConfig(db: Database.Database, sessionId: string, snapshot: object) {
  db.prepare('UPDATE sessions SET config_snapshot = ? WHERE id = ?').run(
    JSON.stringify(snapshot),
    sessionId,
  )
}

function enableZhEditingBundle(db: Database.Database, sessionId: string): void {
  const session = db
    .prepare('SELECT config_snapshot FROM sessions WHERE id=?')
    .get(sessionId) as { config_snapshot: string }
  const snapshot = JSON.parse(session.config_snapshot)
  snapshot.promptBundleSnapshot = {
    promptLanguage: 'zh',
    editingPrompt: '你是最终译文编辑。只根据用户要求审慎修改。',
  }
  setSnapshotConfig(db, sessionId, snapshot)
}

function addFrozenProjectTerm(
  db: Database.Database,
  sessionId: string,
): void {
  const sessionColumns = new Set(
    (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>)
      .map((column) => column.name),
  )
  if (!sessionColumns.has('direction')) {
    db.exec("ALTER TABLE sessions ADD COLUMN direction TEXT NOT NULL DEFAULT 'en_to_zh'")
  }
  if (!sessionColumns.has('task_brief')) {
    db.exec("ALTER TABLE sessions ADD COLUMN task_brief TEXT NOT NULL DEFAULT ''")
  }
  db.prepare(
    "UPDATE sessions SET direction='en_to_zh', task_brief=? WHERE id=?",
  ).run('Keep approved names consistent.', sessionId)

  const projectRepos = createProjectRepositories(db)
  const project = projectRepos.projects.create({
    name: 'Frozen terminology project',
    description: 'User-approved terminology for this translation.',
    direction: 'en_to_zh',
    sourceLang: 'English',
    targetLang: 'Chinese',
  })
  const resource = projectRepos.resources.create(project.id, {
    kind: 'term',
    content: {
      sourceText: 'Moon Gate',
      targetText: '月门',
      instruction: null,
      note: '沿用用户批准的既有译名。',
    },
  })
  const approved = projectRepos.resources.approve(
    project.id,
    resource.resource.id,
    { revisionId: resource.currentRevision.id },
  )
  const frozenResources = projectRepos.snapshots.getResources(
    project.id,
    approved.snapshot.id,
  )
  projectRepos.sessionProjectContexts.freezeForSession({
    sessionId,
    projectId: project.id,
    projectSnapshotId: approved.snapshot.id,
    direction: 'en_to_zh',
    resourceRevisionIds: approved.snapshot.approvedResourceRevisionIds,
    tokenEstimate: estimateProjectContextTokens(frozenResources),
  })
}

// =============================================================================
// Test setup
// =============================================================================

describe('Chat SSE Route', () => {
  let db: Database.Database
  let repos: ReturnType<typeof createRepositories>
  let service: ReturnType<typeof createSessionService>
  let handlers: ReturnType<typeof createChatHandlers>
  let mockLLM: MockLLMInstance
  let sessionId: string

  const DEF_SOURCE = { sourceText: 'Hello world', sourceLang: 'English', targetLang: 'Chinese' }

  function pointLiveEndpointAt(baseUrl: string, apiKey = 'sk-test'): void {
    const endpoint = repos.endpoints.getById(1)
    if (!endpoint) throw new Error('Live test endpoint 1 is unavailable.')
    repos.endpoints.update({
      ...endpoint,
      base_url: baseUrl,
      api_key: apiKey,
    })
  }

  it('resolves request_review from the frozen review binding and its own cap', () => {
    const shared = { endpointId: 1, model: 'shared-model' }
    const frozen = {
      version: 3,
      endpoint: null,
      endpoints: [],
      agents: [],
      coordinator: null,
      prompts: {},
      endpointSnapshots: [
        {
          id: 1,
          name: 'editing',
          baseUrl: 'https://editing.invalid',
          hasApiKey: true,
          contextWindow: 32_768,
        },
        {
          id: 2,
          name: 'review',
          baseUrl: 'https://review.invalid',
          hasApiKey: true,
          contextWindow: 131_072,
        },
      ],
      modelBindings: {
        defaultWorker: shared,
        mainAgent: shared,
        editingAgent: {
          endpointId: 1,
          model: 'shared-model',
          maxOutputTokens: 2_048,
        },
        reviewAgent: {
          endpointId: 2,
          model: 'shared-model',
          maxOutputTokens: 8_192,
        },
      },
    } as ConfigSnapshot

    const editing = resolveChatConfig(frozen)
    expect(editing).toMatchObject({
      bindingRole: 'editingAgent',
      endpointId: 1,
      maxOutputTokens: 2_048,
    })
    expect(editing).not.toBeNull()
    const review = resolveChatReviewConfig(frozen, editing!)
    expect(review).toMatchObject({
      bindingRole: 'reviewAgent',
      endpointId: 2,
      model: 'shared-model',
      contextWindow: 131_072,
      maxOutputTokens: 8_192,
    })
  })

  it('includes complete body-only workflow evidence in revision reference data', () => {
    const message = buildRevisionReferenceMessage({
      promptLanguage: 'en',
      taskBrief: 'Preserve the rhetorical questions.',
      sourceText: '焉能治之？',
      decisionEvidence: {
        review: 'Candidate changed a rhetorical question into a statement.',
        filter: 'Confirmed: restore the repeated rhetorical form.',
        orchestrate: 'Revise all affected clauses while preserving repetition.',
      },
    })

    expect(message).toContain('Confirmed workflow evidence:')
    expect(message).toContain('review:\nCandidate changed')
    expect(message).toContain('filter:\nConfirmed: restore')
    expect(message).toContain('orchestrate:\nRevise all affected')
    expect(message).toContain('Close concrete defects confirmed by the selection')
    expect(message).toContain('Source text:\n焉能治之？')
  })

  beforeEach(async () => {
    // 1. Create in-memory DB + migrate
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(MIGRATION_SQL_0001); db.exec(MIGRATION_SQL_0002); db.exec(MIGRATION_SQL_0009)
    // This focused legacy-route fixture does not run the full vNext migration,
    // but the ledger's nullable foreign keys still need their parent tables.
    db.exec('CREATE TABLE orchestration_runs (id TEXT PRIMARY KEY)')
    db.exec('CREATE TABLE agent_invocations (id TEXT PRIMARY KEY)')
    db.exec(MIGRATION_SQL_0011)

    repos = createRepositories(db)
    service = createSessionService(db, repos)
    handlers = createChatHandlers(db)

    // 2. Start mock LLM server
    mockLLM = await startMockLLM()

    // 3. Seed DB
    repos.endpoints.insert({
      name: 'test-ep',
      base_url: mockLLM.url,
      api_key: 'sk-test',
    })
    repos.coordinatorConfig.upsert({
      endpoint_id: 1,
      model: 'gpt-4',
      chat_endpoint_id: 1,
      chat_model: 'gpt-4-chat',
    })
    repos.translatorAgents.insert({
      name: 'agent-alpha',
      endpoint_id: 1,
      model: 'gpt-4',
      prompt_override: null,
      sort_order: 0,
    })
    repos.promptTemplates.insert({
      kind: 'translator',
      name: 'default',
      content: 'Translate text',
      is_builtin: 1,
    })
    repos.promptTemplates.insert({
      kind: 'review',
      name: 'default',
      content: 'Review translations',
      is_builtin: 1,
    })
  })

  afterEach(async () => {
    await mockLLM.close()
    db.close()
  })

  // ===========================================================================
  // createSession helper — creates a session at 'assembled' state
  // ===========================================================================

  async function createAssembledSession(): Promise<string> {
    const s = service.createSession(DEF_SOURCE)

    // Transition to assembled: draft → translating → translated → coordinating → assembled
    const transitions: string[] = ['translating', 'translated', 'coordinating', 'assembled']
    for (const to of transitions) {
      service.transitionState(s.id, to as any)
    }

    // Add a final version (required for chat context)
    repos.finalVersions.insert({
      session_id: s.id,
      version_no: 1,
      text: '你好世界',
      source: 'assemble',
    })

    // Keep deliberately hostile legacy connection data in the immutable
    // snapshot. Every successful provider request in this fixture therefore
    // proves that chat resolves the current endpoints row instead of reusing
    // a frozen URL or key.
    const latest = repos.sessions.getById(s.id)!
    const updatedSnapshot = JSON.parse(latest.config_snapshot)
    updatedSnapshot.endpoint = {
      id: 1,
      name: 'test-ep',
      base_url: 'https://frozen-chat-endpoint.invalid',
      api_key: 'sk-frozen-chat-key-must-not-be-used',
      created_at: new Date().toISOString(),
    }
    updatedSnapshot.coordinator = {
      id: 1,
      endpoint_id: 1,
      model: 'gpt-4',
      chat_endpoint_id: 1,
      chat_model: 'echo-model', // Use echo behavior by default
      updated_at: new Date().toISOString(),
    }
    setSnapshotConfig(db, s.id, updatedSnapshot)

    return s.id
  }

  // ===========================================================================
  // Tests: Error cases
  // ===========================================================================

  describe('error cases', () => {
    it('returns 404 for non-existent session', async () => {
      const req = new NextRequest('http://localhost/api/sessions/no-such-id/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello' }),
      })

      const resp = await handlers.POST(req, {
        params: Promise.resolve({ id: 'no-such-id' }),
      })

      expect(resp.status).toBe(404)
      const body = await resp.json()
      expect(body.error).toBe('session_not_found')
    })

    it('returns 400 for missing message field', async () => {
      const req = new NextRequest('http://localhost/api/sessions/s1/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      const resp = await handlers.POST(req, {
        params: Promise.resolve({ id: 's1' }),
      })

      expect(resp.status).toBe(400)
      const body = await resp.json()
      expect(body.error).toBe('message_required')
    })

    it('does not expose provider errors in the chat SSE stream or diagnostics', async () => {
      const providerLeak =
        'upstream rejected key sk-live-secret at https://provider.invalid/v1: Hello world'
      mockLLM.setBehavior('echo-model', {
        behavior: 'error',
        status: 502,
        errorCode: 'provider_failure',
        errorMessage: providerLeak,
      })
      const sid = await createAssembledSession()
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

      try {
        const request = new NextRequest(
          `http://localhost/api/sessions/${sid}/chat`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Please revise the translation.' }),
          },
        )
        const response = await handlers.POST(request, {
          params: Promise.resolve({ id: sid }),
        })
        const events = await readSSEEvents(response)
        const complete = events.find(
          (event) => event.event === 'message_complete',
        )?.data as Record<string, unknown> | undefined

        expect(complete).toMatchObject({
          error: 'chat_request_failed',
          message: '对话修订请求失败，请稍后重试。',
        })
        expect(complete?.diagnosticId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        )

        const publicPayload = JSON.stringify(events)
        const diagnostics = JSON.stringify(consoleError.mock.calls)
        for (const sensitive of [
          'sk-live-secret',
          'https://provider.invalid/v1',
          'Hello world',
        ]) {
          expect(publicPayload).not.toContain(sensitive)
          expect(diagnostics).not.toContain(sensitive)
        }
        expect(diagnostics).toContain(complete?.diagnosticId)
      } finally {
        consoleError.mockRestore()
      }
    })

    it('does not repeat model-supplied replacement text in the terminal failure or diagnostics', async () => {
      mockLLM.setBehavior('echo-model', { behavior: 'tool_call' })
      const sid = await createAssembledSession()
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

      try {
        const request = new NextRequest(
          `http://localhost/api/sessions/${sid}/chat`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Replace a passage that is not present.' }),
          },
        )
        const response = await handlers.POST(request, {
          params: Promise.resolve({ id: sid }),
        })
        const events = await readSSEEvents(response)
        const complete = events.find(
          (event) => event.event === 'message_complete',
        )?.data as Record<string, unknown> | undefined

        expect(complete).toMatchObject({
          error: 'chat_edit_correction_failed',
          message: '模型未能定位唯一的待修改片段，请调整要求后重试。',
        })
        expect(complete?.diagnosticId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        )
        // Tool-call timeline events intentionally expose edit arguments for
        // auditability; the terminal failure payload must not repeat them.
        expect(JSON.stringify(complete)).not.toContain('original text')
        expect(JSON.stringify(consoleError.mock.calls)).not.toContain('original text')
      } finally {
        consoleError.mockRestore()
      }
    })

    it('returns 400 for empty message', async () => {
      const req = new NextRequest('http://localhost/api/sessions/s1/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '   ' }),
      })

      const resp = await handlers.POST(req, {
        params: Promise.resolve({ id: 's1' }),
      })

      expect(resp.status).toBe(400)
      const body = await resp.json()
      expect(body.error).toBe('message_required')
    })

    it('returns 400 for invalid JSON body', async () => {
      const req = new NextRequest('http://localhost/api/sessions/s1/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json {{',
      })

      const resp = await handlers.POST(req, {
        params: Promise.resolve({ id: 's1' }),
      })

      expect(resp.status).toBe(400)
      const body = await resp.json()
      expect(body.error).toBe('invalid_body')
    })

    it('returns 409 for draft state', async () => {
      const s = service.createSession(DEF_SOURCE)
      // Still in 'draft' state

      // Need to fix snapshot so it doesn't fail on missing endpoint
      const latest = repos.sessions.getById(s.id)!
      const snap = JSON.parse(latest.config_snapshot)
      snap.endpoint = {
        id: 1,
        name: 'test-ep',
        base_url: mockLLM.url,
        api_key: 'sk-test',
        created_at: new Date().toISOString(),
      }
      snap.coordinator = {
        id: 1,
        endpoint_id: 1,
        model: 'gpt-4',
        chat_endpoint_id: 1,
        chat_model: 'gpt-4-chat',
        updated_at: new Date().toISOString(),
      }
      setSnapshotConfig(db, s.id, snap)

      const req = new NextRequest(`http://localhost/api/sessions/${s.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello' }),
      })

      const resp = await handlers.POST(req, {
        params: Promise.resolve({ id: s.id }),
      })

      expect(resp.status).toBe(409)
      const body = await resp.json()
      expect(body.error).toBe('state_not_ready')
    })

    it('returns 409 for coordinating state', async () => {
      const s = service.createSession(DEF_SOURCE)
      service.transitionState(s.id, 'translating')
      service.transitionState(s.id, 'translated')
      service.transitionState(s.id, 'coordinating')
      // coordinating → not allowed for chat

      const latest = repos.sessions.getById(s.id)!
      const snap = JSON.parse(latest.config_snapshot)
      snap.endpoint = {
        id: 1,
        name: 'test-ep',
        base_url: mockLLM.url,
        api_key: 'sk-test',
        created_at: new Date().toISOString(),
      }
      snap.coordinator = {
        id: 1,
        endpoint_id: 1,
        model: 'gpt-4',
        chat_endpoint_id: 1,
        chat_model: 'gpt-4-chat',
        updated_at: new Date().toISOString(),
      }
      setSnapshotConfig(db, s.id, snap)

      const req = new NextRequest(`http://localhost/api/sessions/${s.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello' }),
      })

      const resp = await handlers.POST(req, {
        params: Promise.resolve({ id: s.id }),
      })

      expect(resp.status).toBe(409)
      const body = await resp.json()
      expect(body.error).toBe('state_not_ready')
    })
  })

  // ===========================================================================
  // Tests: Message turn (no tool calls)
  // ===========================================================================

  describe('message turn (pure discussion)', () => {
    it('reuses an unfinished identical user turn instead of duplicating it', async () => {
      mockLLM.setBehavior('echo-model', { behavior: 'echo' })
      const sid = await createAssembledSession()
      repos.chatMessages.insert({
        session_id: sid,
        role: 'user',
        content: '继续检查这一版',
        tool_calls: null,
        tool_results: null,
        version_id: null,
      })
      const req = new NextRequest(`http://localhost/api/sessions/${sid}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '继续检查这一版' }),
      })

      const resp = await handlers.POST(req, {
        params: Promise.resolve({ id: sid }),
      })
      await readSSEEvents(resp)

      const identicalUserTurns = repos.chatMessages
        .listBySession(sid)
        .filter((message) =>
          message.role === 'user' && message.content === '继续检查这一版')
      expect(identicalUserTurns).toHaveLength(1)
    })

    it('rejects a second chat turn while the first turn is still running', async () => {
      mockLLM.setBehavior('echo-model', {
        behavior: 'stream',
        chunkDelayMs: 100,
      })
      const sid = await createAssembledSession()
      const firstReq = new NextRequest(`http://localhost/api/sessions/${sid}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '第一轮' }),
      })
      const firstResp = await handlers.POST(firstReq, {
        params: Promise.resolve({ id: sid }),
      })
      const activeResp = await handlers.GET(
        new NextRequest(`http://localhost/api/sessions/${sid}/chat`),
        { params: Promise.resolve({ id: sid }) },
      )
      expect(await activeResp.json()).toMatchObject({ active: true })
      const secondReq = new NextRequest(`http://localhost/api/sessions/${sid}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '第二轮' }),
      })
      const secondResp = await handlers.POST(secondReq, {
        params: Promise.resolve({ id: sid }),
      })

      expect(secondResp.status).toBe(409)
      expect((await secondResp.json()).error).toBe('chat_already_running')
      await readSSEEvents(firstResp)
      const completeResp = await handlers.GET(
        new NextRequest(`http://localhost/api/sessions/${sid}/chat`),
        { params: Promise.resolve({ id: sid }) },
      )
      expect(await completeResp.json()).toEqual({
        active: false,
        startedAt: null,
        lastHeartbeatAt: null,
        lastProgressAt: null,
        phase: null,
      })
    })

    it.each(['response_cancel', 'request_signal'] as const)(
      'aborts the provider and settles the ledger on %s',
      async (disconnectMode) => {
      const http = await import('http')
      let heartbeat: ReturnType<typeof setInterval> | undefined
      let resolveProviderReady!: () => void
      let resolveProviderDisconnected!: () => void
      const providerReady = new Promise<void>((resolve) => {
        resolveProviderReady = resolve
      })
      const providerDisconnected = new Promise<void>((resolve) => {
        resolveProviderDisconnected = resolve
      })
      const server = http.createServer((providerRequest, providerResponse) => {
        providerRequest.resume()
        providerRequest.once('end', () => {
          providerResponse.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          })
          providerResponse.once('close', () => {
            if (heartbeat) clearInterval(heartbeat)
            resolveProviderDisconnected()
          })
          providerResponse.write(`data: ${JSON.stringify({
            choices: [{
              index: 0,
              delta: { content: 'provider partial output' },
              finish_reason: null,
            }],
          })}\n\n`)
          heartbeat = setInterval(() => {
            if (!providerResponse.destroyed) {
              providerResponse.write(': provider heartbeat\n\n')
            }
          }, 20)
          resolveProviderReady()
        })
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolve())
      })
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('disconnect test provider did not bind a TCP port')
      }
      const providerUrl = `http://127.0.0.1:${address.port}`
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      const requestAbort = new AbortController()

      try {
        const sid = await createAssembledSession()
        pointLiveEndpointAt(providerUrl)

        const request = new NextRequest(
          `http://localhost/api/sessions/${sid}/chat`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: requestAbort.signal,
            body: JSON.stringify({
              message: 'DISCONNECT_PROMPT_MUST_NOT_ENTER_ERRORS',
            }),
          },
        )
        const response = await handlers.POST(request, {
          params: Promise.resolve({ id: sid }),
        })
        const reader = response.body!.getReader()
        await withTestDeadline(
          providerReady,
          'provider never received the chat request',
        )
        const firstChunk = await reader.read()
        expect(firstChunk.done).toBe(false)
        if (disconnectMode === 'response_cancel') {
          await withTestDeadline(
            reader.cancel('browser disconnected'),
            'response reader cancellation did not settle',
          )
        } else {
          requestAbort.abort()
        }
        await withTestDeadline(
          providerDisconnected,
          'provider connection stayed open',
        )
        if (disconnectMode === 'request_signal') {
          while (true) {
            const next = await withTestDeadline(
              reader.read(),
              'chat response did not close after request abort',
            )
            if (next.done) break
          }
        }

        expect(getChatActivity(sid).active).toBe(false)
        const ledgerRows = db.prepare(`
          SELECT status, error_code, usage_source
          FROM llm_call_records
          WHERE session_id=? AND operation='chat_edit'
        `).all(sid) as Array<{
          status: string
          error_code: string | null
          usage_source: string
        }>
        expect(ledgerRows).toEqual([{
          status: 'cancelled',
          error_code: 'aborted',
          usage_source: 'unknown',
        }])
        expect(
          repos.chatMessages
            .listBySession(sid)
            .filter((message) => message.role === 'assistant'),
        ).toHaveLength(0)
        expect(repos.finalVersions.listBySession(sid)).toHaveLength(1)

        const visibleChunk = firstChunk.value
          ? new TextDecoder().decode(firstChunk.value)
          : ''
        const diagnostics = JSON.stringify(consoleError.mock.calls)
        for (const sensitive of [
          'sk-test',
          providerUrl,
          'DISCONNECT_PROMPT_MUST_NOT_ENTER_ERRORS',
        ]) {
          expect(visibleChunk).not.toContain(sensitive)
          expect(diagnostics).not.toContain(sensitive)
        }
      } finally {
        consoleError.mockRestore()
        if (heartbeat) clearInterval(heartbeat)
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (
              error &&
              (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
            ) {
              reject(error)
              return
            }
            resolve()
          })
          server.closeAllConnections()
        })
      }
      },
    )

    it('includes the current user instruction in the LLM context', async () => {
      mockLLM.setBehavior('echo-model', { behavior: 'echo' })
      const sid = await createAssembledSession()
      const instruction = '本轮唯一指令：只修改这一处'
      const req = new NextRequest(`http://localhost/api/sessions/${sid}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: instruction }),
      })

      const resp = await handlers.POST(req, {
        params: Promise.resolve({ id: sid }),
      })
      const events = await readSSEEvents(resp)
      expect(events.find((event) => event.event === 'message_complete')?.data)
        .toMatchObject({ kind: 'message' })

      const messages = repos.chatMessages.listBySession(sid)
      const assistant = messages.find((message) => message.role === 'assistant')
      expect(assistant?.content).toBe(instruction)
    })

    it('injects the frozen project archive only as user context and preserves full history', async () => {
      mockLLM.setBehavior('echo-model', { behavior: 'echo' })
      const sid = await createAssembledSession()
      enableZhEditingBundle(db, sid)
      addFrozenProjectTerm(db, sid)
      repos.chatMessages.insert({
        session_id: sid,
        role: 'user',
        content: '上一轮用户消息',
        tool_calls: null,
        tool_results: null,
        version_id: null,
      })
      repos.chatMessages.insert({
        session_id: sid,
        role: 'assistant',
        content: '上一轮助手回复',
        tool_calls: null,
        tool_results: null,
        version_id: null,
      })

      const req = new NextRequest(`http://localhost/api/sessions/${sid}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '检查项目术语是否一致。' }),
      })
      const resp = await handlers.POST(req, {
        params: Promise.resolve({ id: sid }),
      })
      await readSSEEvents(resp)

      const requestBody = mockLLM.getRequests().at(-1)?.body as {
        messages: Array<{ role: string; content: string }>
      }
      const systemText = requestBody.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n')
      const userText = requestBody.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content)
        .join('\n')
      const allPromptText = requestBody.messages
        .map((message) => message.content)
        .join('\n')

      expect(userText).toContain('用户已批准的项目翻译档案（本会话冻结快照）')
      expect(userText).toContain('Moon Gate → 月门')
      expect(systemText).not.toContain('Moon Gate')
      expect(systemText).not.toContain('月门')
      expect(allPromptText).toContain('上一轮用户消息')
      expect(allPromptText).toContain('上一轮助手回复')
      expect(allPromptText).not.toContain('sk-test')
      expect(allPromptText).not.toContain(mockLLM.url)
    })

    it('keeps the legacy revision reference unchanged without a project snapshot', async () => {
      mockLLM.setBehavior('echo-model', { behavior: 'echo' })
      const sid = await createAssembledSession()
      enableZhEditingBundle(db, sid)
      const instruction = '只检查现有译文。'
      const req = new NextRequest(`http://localhost/api/sessions/${sid}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: instruction }),
      })

      const resp = await handlers.POST(req, {
        params: Promise.resolve({ id: sid }),
      })
      await readSSEEvents(resp)

      const requestBody = mockLLM.getRequests().at(-1)?.body as {
        messages: Array<{ role: string; content: string }>
      }
      expect(requestBody.messages[1]).toEqual({
        role: 'user',
        content: buildRevisionReferenceMessage({
          promptLanguage: 'zh',
          taskBrief: '',
          sourceText: DEF_SOURCE.sourceText,
          decisionEvidence: {},
        }),
      })
      expect(requestBody.messages.map((message) => message.content).join('\n'))
        .not.toContain('用户已批准的项目翻译档案')
    })

    it('exposes only replace_text to the production translation chat model', async () => {
      mockLLM.setBehavior('echo-model', { behavior: 'echo' })
      const sid = await createAssembledSession()
      const req = new NextRequest(`http://localhost/api/sessions/${sid}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '请检查当前译文' }),
      })

      const resp = await handlers.POST(req, {
        params: Promise.resolve({ id: sid }),
      })
      await readSSEEvents(resp)

      const request = mockLLM.getRequests().at(-1)?.body as {
        tools?: Array<{ function?: { name?: string } }>
      }
      expect(request.tools?.map((tool) => tool.function?.name)).toEqual([
        'replace_text',
      ])
      expect(
        db.prepare('SELECT COUNT(*) FROM orchestration_runs').pluck().get(),
      ).toBe(0)
      expect(
        db.prepare('SELECT COUNT(*) FROM agent_invocations').pluck().get(),
      ).toBe(0)
    })

    it('returns SSE stream with expected events for a message turn', async () => {
      // Configure mock LLM to return a fixed content
      mockLLM.setBehavior('echo-model', { behavior: 'json_content', jsonContent: '好的，我来帮您。' })

      const sid = await createAssembledSession()

      const req = new NextRequest(`http://localhost/api/sessions/${sid}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '请把"Hello"改成"你好"' }),
      })

      const resp = await handlers.POST(req, {
        params: Promise.resolve({ id: sid }),
      })

      expect(resp.status).toBe(200)
      expect(resp.headers.get('Content-Type')).toBe('text/event-stream')

      const events = await readSSEEvents(resp)

      // Should have at least: message_start, delta*, message_complete, done
      expect(events.length).toBeGreaterThanOrEqual(3)

      const eventNames = events.map((e) => e.event)
      expect(eventNames[0]).toBe('message_start')
      expect(eventNames).toContain('delta')
      expect(eventNames).toContain('message_complete')
      expect(eventNames[eventNames.length - 1]).toBe('done')

      // message_complete should indicate kind:'message'
      const completeEvent = events.find((e) => e.event === 'message_complete')
      expect(completeEvent).toBeDefined()
      expect((completeEvent!.data as any).kind).toBe('message')

      // Verify user message was persisted
      const messages = repos.chatMessages.listBySession(sid)
      expect(messages.length).toBeGreaterThanOrEqual(2) // user + assistant
      const userMsg = messages.find((m) => m.role === 'user')
      expect(userMsg).toBeDefined()
      expect(userMsg!.content).toContain('请把')
    })

    it('does not block an ordinary edit when an unused frozen review endpoint was deleted', async () => {
      sessionId = await createAssembledSession()
      const binding = (
        endpointId: number,
        model: string,
      ): ModelBinding => ({
        endpointId,
        model,
        contextWindow: 131_072,
        maxOutputTokens: 2_048,
      })
      const editingBinding = binding(1, 'echo-model')
      const reviewBinding = binding(999, 'deleted-review-model')
      const vnext: ConfigSnapshotVNext = {
        version: 3,
        direction: 'en_to_zh',
        promptBundleSnapshot: {
          direction: 'en_to_zh',
          promptLanguage: 'zh',
          mainAgentSystemPrompt: '主编提示',
          workerBasePrompt: '译者提示',
          reviewPrompt: '审查提示',
          filterPrompt: '筛选提示',
          orchestratePrompt: '统筹提示',
          assemblePrompt: '组装提示',
          editingPrompt: '只处理当前用户的编辑请求。',
          toolDescriptions: {},
          version: 1,
        },
        agentVariantSnapshots: [
          {
            id: 'semantic',
            archetypeId: 'semantic-fidelity',
            direction: 'en_to_zh',
            catalogName: '语义',
            catalogDescription: '语义忠实',
            rolePrompt: '忠实翻译',
            promptLanguage: 'zh',
            promptVersion: 1,
            enabled: true,
            endpointOverrideId: null,
            modelOverride: null,
            sortOrder: 1,
          },
          {
            id: 'natural',
            archetypeId: 'target-naturalness',
            direction: 'en_to_zh',
            catalogName: '自然',
            catalogDescription: '自然表达',
            rolePrompt: '自然翻译',
            promptLanguage: 'zh',
            promptVersion: 1,
            enabled: true,
            endpointOverrideId: null,
            modelOverride: null,
            sortOrder: 2,
          },
        ],
        endpointSnapshots: [
          {
            id: 1,
            name: 'editing',
            baseUrl: mockLLM.url,
            chatCompletionsPath: '/v1/chat/completions',
            hasApiKey: true,
            contextWindow: 131_072,
          },
          {
            id: 999,
            name: 'deleted review',
            baseUrl: 'https://deleted-review.invalid',
            chatCompletionsPath: '/v1/chat/completions',
            hasApiKey: true,
            contextWindow: 131_072,
          },
        ],
        modelBindings: {
          defaultWorker: editingBinding,
          mainAgent: editingBinding,
          reviewAgent: reviewBinding,
          filterAgent: editingBinding,
          orchestrateAgent: editingBinding,
          assembleAgent: editingBinding,
          editingAgent: editingBinding,
        },
        presetRevisionSnapshot: null,
        taskBrief: '',
        constraints: {},
        orchestrationPolicy: {
          teamPolicy: 'fixed',
          reviewMode: 'main_editor',
          maxAgentCalls: 4,
          candidateAnnotationMode: 'body_only',
        },
      }
      vnext.preflight = runSessionPreflight({
        sourceText: DEF_SOURCE.sourceText,
        snapshot: vnext,
      })
      expect(vnext.preflight.status).toBe('pass')
      setSnapshotConfig(db, sessionId, vnext)

      const response = await handlers.POST(
        new NextRequest(`http://localhost/api/sessions/${sessionId}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: '请说明当前译文，不要调用审查工具。' }),
        }),
        { params: Promise.resolve({ id: sessionId }) },
      )
      expect(response.status).toBe(200)
      const events = await readSSEEvents(response)
      expect(events.map((event) => event.event)).toContain('message_complete')
      expect(JSON.stringify(events)).not.toContain('runtime_endpoint_deleted')

      const chatSnapshot = vnext as unknown as ConfigSnapshot
      const editing = resolveChatConfig(chatSnapshot, db)
      const review = resolveChatReviewConfig(chatSnapshot, editing!)
      expect(review).toMatchObject({ endpointId: 999, apiKey: '' })
      try {
        currentRuntimeEndpoint(db, review!.endpointId)
        throw new Error('expected deleted review endpoint failure')
      } catch (error) {
        expect(error).toMatchObject({ code: 'runtime_endpoint_deleted' })
      }
    })

    it('user message includes selection context when selection is provided', async () => {
      mockLLM.setBehavior('echo-model', { behavior: 'json_content', jsonContent: '好的。' })

      const sid = await createAssembledSession()

      const req = new NextRequest(`http://localhost/api/sessions/${sid}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: '把这段话改得有诗意',
          selection: { text: '你好世界', start: 0, end: 4 },
        }),
      })

      const response = await handlers.POST(req, {
        params: Promise.resolve({ id: sid }),
      })
      const events = await readSSEEvents(response)
      expect(events.find((event) => event.event === 'message_complete')?.data)
        .toMatchObject({ kind: 'message' })

      const messages = repos.chatMessages.listBySession(sid)
      const userMsg = messages.find((m) => m.role === 'user')
      expect(userMsg).toBeDefined()
      expect(userMsg!.content).toContain('把这段话改得有诗意')
      expect(userMsg!.content).toContain('选中片段')
      expect(userMsg!.content).toContain('你好世界')
      expect(userMsg!.content).toContain('位置 0-4')
    })
  })

  // ===========================================================================
  // Tests: Edit turn (tool calls + version persistence)
  // ===========================================================================

  describe('edit turn (tool calls + version)', () => {
    it('persists new version after successful tool_call edit', async () => {
      // Use a custom round server for tool_call behavior
      const http = await import('http')

      const server = await new Promise<{
        url: string
        close: () => Promise<void>
      }>((resolve) => {
        const srv = http.createServer((req, res) => {
          const chunks: Buffer[] = []
          req.on('data', (c: Buffer) => chunks.push(c))
          req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf-8')
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            })

            const response = {
              id: 'chatcmpl-tool',
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: 'echo-model',
              choices: [{
                index: 0,
                message: {
                  role: 'assistant',
                  content: '我来修改一下。',
                  tool_calls: [{
                    id: 'call_edit1',
                    type: 'function' as const,
                    function: {
                      name: 'replace_text',
                      arguments: JSON.stringify({
                        old_string: '你好世界',
                        new_string: '您好世界',
                      }),
                    },
                  }],
                },
                finish_reason: 'tool_calls',
              }],
              usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
            }

            res.end(JSON.stringify(response))
          })
        })

        srv.listen(0, () => {
          const addr = srv.address() as { port: number }
          resolve({
            url: `http://localhost:${addr.port}`,
            close: () => new Promise<void>((res) => srv.close(() => res())),
          })
        })
      })

      // Provider routing is live configuration, not immutable session data.
      const sid = await createAssembledSession()
      pointLiveEndpointAt(server.url)

      try {
        const req = new NextRequest(`http://localhost/api/sessions/${sid}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: '把世界改成全人类' }),
        })

        const resp = await handlers.POST(req, {
          params: Promise.resolve({ id: sid }),
        })

        expect(resp.status).toBe(200)
        const events = await readSSEEvents(resp)

        // Should have tool_call and tool_result events
        const eventNames = events.map((e) => e.event)
        expect(eventNames).toContain('tool_call')
        expect(eventNames).toContain('tool_result')

        // Verify new version in DB
        const versions = repos.finalVersions.listBySession(sid)
        expect(versions.length).toBeGreaterThanOrEqual(2) // original + new edit
        const editVersion = versions.find((v) => v.source === 'edit')
        expect(editVersion).toBeDefined()
        expect(editVersion!.version_no).toBeGreaterThan(1)
        expect(editVersion!.text).toBe('您好世界')

        // SSE tool_result event must carry version_no = previous + 1
        const toolResultEvents = events.filter((e) => e.event === 'tool_result')
        const versionResult = toolResultEvents.find(
          (e) => typeof (e.data as any).version_no === 'number',
        )
        expect(versionResult).toBeDefined()
        expect((versionResult!.data as any).version_no).toBe(editVersion!.version_no)
        expect((versionResult!.data as any).ok).toBe(true)

        // Verify assistant message linked to version
        const messages = repos.chatMessages.listBySession(sid)
        const assistantMsg = messages.find((m) => m.role === 'assistant')
        expect(assistantMsg).toBeDefined()
        expect(assistantMsg!.version_id).toBe(editVersion!.id)
      } finally {
        await server.close()
      }
    })

    it('persists only the repaired tool batch after an invalid old_string', async () => {
      const http = await import('http')
      let requestCount = 0

      const server = await new Promise<{
        url: string
        close: () => Promise<void>
      }>((resolve) => {
        const srv = http.createServer((req, res) => {
          const chunks: Buffer[] = []
          req.on('data', (chunk: Buffer) => chunks.push(chunk))
          req.on('end', () => {
            requestCount += 1
            const oldString = requestCount === 1 ? '不存在的片段' : '你好世界'
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              id: `chatcmpl-repair-${requestCount}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: 'echo-model',
              choices: [{
                index: 0,
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [{
                    id: `call_repair_${requestCount}`,
                    type: 'function',
                    function: {
                      name: 'replace_text',
                      arguments: JSON.stringify({
                        old_string: oldString,
                        new_string: '您好世界',
                      }),
                    },
                  }],
                },
                finish_reason: 'tool_calls',
              }],
              usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
            }))
          })
        })

        srv.listen(0, () => {
          const address = srv.address() as { port: number }
          resolve({
            url: `http://localhost:${address.port}`,
            close: () => new Promise<void>((done) => srv.close(() => done())),
          })
        })
      })

      const sid = await createAssembledSession()
      pointLiveEndpointAt(server.url)

      try {
        const response = await handlers.POST(
          new NextRequest(`http://localhost/api/sessions/${sid}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: '请修正称呼' }),
          }),
          { params: Promise.resolve({ id: sid }) },
        )
        const events = await readSSEEvents(response)
        const completion = events.find((event) => event.event === 'message_complete')

        expect((completion?.data as { error?: string }).error).toBeUndefined()
        expect(requestCount).toBe(2)
        expect(repos.finalVersions.getLatestBySession(sid)?.text).toBe('您好世界')
        const assistant = repos.chatMessages
          .listBySession(sid)
          .find((message) => message.role === 'assistant')
        expect(JSON.parse(assistant?.tool_calls ?? '[]')).toEqual([
          { old_string: '你好世界', new_string: '您好世界' },
        ])
      } finally {
        await server.close()
      }
    })
  })

  // ===========================================================================
  // Tests: Protocol fallback
  // ===========================================================================

  describe('protocol fallback', () => {
    it('includes fallback hint delta when model does not support tools', async () => {
      // Use a server that returns tools_not_supported on first call, then JSON fence
      const http = await import('http')

      const server = await new Promise<{
        url: string
        close: () => Promise<void>
        requestCount: () => number
      }>((resolve) => {
        let count = 0
        const srv = http.createServer((req, res) => {
          const chunks: Buffer[] = []
          req.on('data', (c: Buffer) => chunks.push(c))
          req.on('end', () => {
            let body: Record<string, unknown> = {}
            try {
              body = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
            } catch { /* ignore */ }

            count++
            const hasTools =
              Array.isArray((body as Record<string, unknown>).tools) &&
              ((body as Record<string, unknown>).tools as unknown[]).length > 0

            if (count === 1 && hasTools) {
              // First attempt with tools → return 400 error to trigger ToolsNotSupportedError
              res.writeHead(400, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
              })
              res.end(JSON.stringify({
                error: {
                  message: 'tools is not supported',
                  type: 'invalid_request_error',
                  code: 'unsupported_tools',
                },
              }))
              return
            }

            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            })

            // Fallback attempt → return JSON fence response
            res.end(JSON.stringify({
              id: 'chatcmpl-fence',
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: 'echo-model',
              choices: [{
                index: 0,
                message: {
                  role: 'assistant',
                  content: '我来修改。\n\n```json\n{"old_string": "你好世界", "new_string": "您好世界"}\n```\n',
                },
                finish_reason: 'stop',
              }],
              usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
            }))
          })
        })

        srv.listen(0, () => {
          const addr = srv.address() as { port: number }
          resolve({
            url: `http://localhost:${addr.port}`,
            close: () => new Promise<void>((res) => srv.close(() => res())),
            requestCount: () => count,
          })
        })
      })

      const sid = await createAssembledSession()
      pointLiveEndpointAt(server.url)

      try {
        const req = new NextRequest(`http://localhost/api/sessions/${sid}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: '修改译文' }),
        })

        const resp = await handlers.POST(req, {
          params: Promise.resolve({ id: sid }),
        })

        expect(resp.status).toBe(200)
        const events = await readSSEEvents(resp)

        // Should have a delta with fallback hint
        const deltas = events.filter((e) => e.event === 'delta')
        const fallbackHint = deltas.find((d) =>
          typeof (d.data as any).text === 'string' &&
          (d.data as any).text.includes('兼容模式')
        )
        expect(fallbackHint).toBeDefined()

        // Should still succeed with edit
        const versions = repos.finalVersions.listBySession(sid)
        expect(versions.length).toBeGreaterThanOrEqual(2)
      } finally {
        await server.close()
      }
    })
  })

  // ===========================================================================
  // Tests: State transitions
  // ===========================================================================

  describe('allowed states', () => {
    it('allows chat in assembled state', async () => {
      mockLLM.setBehavior('echo-model', { behavior: 'json_content', jsonContent: 'ok' })
      const sid = await createAssembledSession()

      const req = new NextRequest(`http://localhost/api/sessions/${sid}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'test' }),
      })

      const resp = await handlers.POST(req, {
        params: Promise.resolve({ id: sid }),
      })

      expect(resp.status).toBe(200)
      const events = await readSSEEvents(resp)
      expect(events.find((event) => event.event === 'message_complete')?.data)
        .toMatchObject({ kind: 'message' })
    })

    it('allows chat in refining state', async () => {
      mockLLM.setBehavior('echo-model', { behavior: 'json_content', jsonContent: 'ok' })

      const s = service.createSession(DEF_SOURCE)
      for (const to of ['translating', 'translated', 'coordinating', 'assembled', 'refining']) {
        service.transitionState(s.id, to as any)
      }

      // Add a version
      repos.finalVersions.insert({
        session_id: s.id,
        version_no: 1,
        text: '你好世界',
        source: 'assemble',
      })

      // Fix snapshot
      const latest = repos.sessions.getById(s.id)!
      const snap = JSON.parse(latest.config_snapshot)
      snap.endpoint = {
        id: 1,
        name: 'test-ep',
        base_url: mockLLM.url,
        api_key: 'sk-test',
        created_at: new Date().toISOString(),
      }
      snap.coordinator = {
        id: 1,
        endpoint_id: 1,
        model: 'gpt-4',
        chat_endpoint_id: 1,
        chat_model: 'echo-model',
        updated_at: new Date().toISOString(),
      }
      setSnapshotConfig(db, s.id, snap)

      const req = new NextRequest(`http://localhost/api/sessions/${s.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'test' }),
      })

      const resp = await handlers.POST(req, {
        params: Promise.resolve({ id: s.id }),
      })

      expect(resp.status).toBe(200)
      const events = await readSSEEvents(resp)
      expect(events.find((event) => event.event === 'message_complete')?.data)
        .toMatchObject({ kind: 'message' })
    })
  })

  // ===========================================================================
  // Tests: Discussion round (no tool_call → no version_id, text unchanged)
  // ===========================================================================

  describe('discussion round', () => {
    it('creates no new version and links message to null version_id', async () => {
      mockLLM.setBehavior('echo-model', { behavior: 'json_content', jsonContent: 'Test response.' })

      const sid = await createAssembledSession()

      const req = new NextRequest(`http://localhost/api/sessions/${sid}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '这段翻译怎么样？' }),
      })

      const resp = await handlers.POST(req, {
        params: Promise.resolve({ id: sid }),
      })

      expect(resp.status).toBe(200)
      const events = await readSSEEvents(resp)

      // No new version should be created
      const versions = repos.finalVersions.listBySession(sid)
      expect(versions.length).toBe(1) // only the assemble version
      expect(versions[0].source).toBe('assemble')

      // 讨论轮：文本不变 — 唯一版本仍为原始 assembled 文本
      expect(versions[0].text).toBe('你好世界')
      expect(versions[0].version_no).toBe(1)

      // Assistant message should have null version_id
      const messages = repos.chatMessages.listBySession(sid)
      const assistantMsg = messages.find((m) => m.role === 'assistant')
      expect(assistantMsg).toBeDefined()
      expect(assistantMsg!.version_id).toBeNull()

      // 讨论轮：无 tool_call / tool_result 事件（纯文本响应）
      const eventNames = events.map((e) => e.event)
      expect(eventNames).not.toContain('tool_call')
      expect(eventNames).not.toContain('tool_result')

      // message_complete 应标 kind:'message'，无 version_no
      const complete = events.find((e) => e.event === 'message_complete')
      expect(complete).toBeDefined()
      expect((complete!.data as any).kind).toBe('message')
      expect((complete!.data as any).version_no).toBeUndefined()
    })
  })
})
