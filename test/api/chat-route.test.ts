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

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { NextRequest } from 'next/server'
import { createRepositories } from '@/src/lib/db/repositories'
import { createSessionService } from '@/src/lib/services/session-service'
import { createChatHandlers } from '@/src/lib/handlers/chat-handler'
import { encodeSSE, parseSSEChunk } from '@/src/lib/contracts/sse'
import { startMockLLM, type MockLLMInstance } from '../fixtures/mock-llm'

// Inline migration SQL
const MIGRATION_SQL_0001 = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/db/migrations/0001_init.sql'),
  'utf-8',
)
const MIGRATION_SQL_0002 = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/db/migrations/0002_presets_and_drop_parsed_output.sql'),
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

/** Restore a previously taken snapshot to session config */
function setSnapshotConfig(db: Database.Database, sessionId: string, snapshot: object) {
  db.prepare('UPDATE sessions SET config_snapshot = ? WHERE id = ?').run(
    JSON.stringify(snapshot),
    sessionId,
  )
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

  beforeEach(async () => {
    // 1. Create in-memory DB + migrate
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(MIGRATION_SQL_0001); db.exec(MIGRATION_SQL_0002)

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

    // Re-snapshot with mock LLM URL (the snapshot was taken at create time
    // before we set up the mock LLM, so we need to update it)
    const latest = repos.sessions.getById(s.id)!
    const updatedSnapshot = JSON.parse(latest.config_snapshot)
    updatedSnapshot.endpoint = {
      id: 1,
      name: 'test-ep',
      base_url: mockLLM.url,
      api_key: 'sk-test',
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

      await handlers.POST(req, { params: Promise.resolve({ id: sid }) })

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

      // Override the session's endpoint to point to our custom server
      const sid = await createAssembledSession()

      const latest = repos.sessions.getById(sid)!
      const snap = JSON.parse(latest.config_snapshot)
      snap.endpoint.base_url = server.url
      for (const endpoint of snap.endpoints ?? []) {
        endpoint.base_url = server.url
      }
      setSnapshotConfig(db, sid, snap)

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
      const latest = repos.sessions.getById(sid)!
      const snap = JSON.parse(latest.config_snapshot)
      snap.endpoint.base_url = server.url
      for (const endpoint of snap.endpoints ?? []) {
        endpoint.base_url = server.url
      }
      setSnapshotConfig(db, sid, snap)

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
