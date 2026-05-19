import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import type { NextRequest } from 'next/server'

// ── Helper: build a minimal NextRequest-like object for route handlers ──
function mockReq(method: string, url: string, body?: unknown): NextRequest {
  const headers = new Headers()
  if (body !== undefined) {
    headers.set('content-type', 'application/json')
  }

  const urlObj = new URL(url)
  const req = new Request(urlObj, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  // Patch nextUrl onto the Request (Next.js App Router provides this)
  const reqWithNextUrl = req as Request & { nextUrl: URL }
  reqWithNextUrl.nextUrl = urlObj

  return reqWithNextUrl as unknown as NextRequest
}

// ── DB setup ───────────────────────────────────────────────────────
const MIGRATION_SQL = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/db/migrations/0001_init.sql'),
  'utf-8',
)

function createTestDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')

  // Run domain schema
  db.exec(MIGRATION_SQL)

  // Create migrations tracking table (normally created by migrate() function)
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    applied_at TEXT DEFAULT (datetime('now'))
  )`)

  // Insert migration record so migrate() is a no-op when handlers call it
  db.prepare('INSERT INTO migrations (version, name) VALUES (?, ?)').run(1, '0001_init.sql')

  // Set global singleton so getDb() returns this in-memory instance
  ;(globalThis as Record<string, unknown>).__db = db

  return db
}

// ── Dynamic import helpers (re-import each test to avoid stale state) ──

let endpointRouteModule: typeof import('@/app/api/endpoints/route') | null = null
let endpointIdRouteModule: typeof import('@/app/api/endpoints/[id]/route') | null = null
let agentRouteModule: typeof import('@/app/api/agents/route') | null = null
let agentIdRouteModule: typeof import('@/app/api/agents/[id]/route') | null = null
let coordinatorModule: typeof import('@/app/api/coordinator/route') | null = null
let promptsModule: typeof import('@/app/api/prompts/route') | null = null
let promptsIdModule: typeof import('@/app/api/prompts/[id]/route') | null = null
let promptsResetModule: typeof import('@/app/api/prompts/reset/route') | null = null
let settingsModule: typeof import('@/app/api/settings/route') | null = null

async function loadModules() {
  endpointRouteModule = await import('@/app/api/endpoints/route')
  endpointIdRouteModule = await import('@/app/api/endpoints/[id]/route')
  agentRouteModule = await import('@/app/api/agents/route')
  agentIdRouteModule = await import('@/app/api/agents/[id]/route')
  coordinatorModule = await import('@/app/api/coordinator/route')
  promptsModule = await import('@/app/api/prompts/route')
  promptsIdModule = await import('@/app/api/prompts/[id]/route')
  promptsResetModule = await import('@/app/api/prompts/reset/route')
  settingsModule = await import('@/app/api/settings/route')
}

async function getEndpointRoute() {
  if (!endpointRouteModule) await loadModules()
  return endpointRouteModule!
}
async function getEndpointIdRoute() {
  if (!endpointIdRouteModule) await loadModules()
  return endpointIdRouteModule!
}
async function getAgentRoute() {
  if (!agentRouteModule) await loadModules()
  return agentRouteModule!
}
async function getAgentIdRoute() {
  if (!agentIdRouteModule) await loadModules()
  return agentIdRouteModule!
}
async function getCoordinatorRoute() {
  if (!coordinatorModule) await loadModules()
  return coordinatorModule!
}
async function getPromptsRoute() {
  if (!promptsModule) await loadModules()
  return promptsModule!
}
async function getPromptsIdRoute() {
  if (!promptsIdModule) await loadModules()
  return promptsIdModule!
}
async function getPromptsResetRoute() {
  if (!promptsResetModule) await loadModules()
  return promptsResetModule!
}
async function getSettingsRoute() {
  if (!settingsModule) await loadModules()
  return settingsModule!
}

// ===========================================================================
// Tests
// ===========================================================================

describe('Config CRUD Routes', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb()
  })

  afterEach(() => {
    db.close()
    delete (globalThis as Record<string, unknown>).__db
  })

  // ── Endpoints ────────────────────────────────────────────────────

  describe('endpoints', () => {
    it('GET /api/endpoints returns empty list', async () => {
      const { GET } = await getEndpointRoute()
      const res = await GET(mockReq('GET', 'http://localhost/api/endpoints'))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual([])
    })

    it('POST /api/endpoints creates an endpoint', async () => {
      const { POST } = await getEndpointRoute()
      const res = await POST(
        mockReq('POST', 'http://localhost/api/endpoints', {
          name: 'OpenAI',
          base_url: 'https://api.openai.com/v1',
          api_key: 'sk-test',
        }),
      )
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.name).toBe('OpenAI')
      expect(body.base_url).toBe('https://api.openai.com/v1')
      expect(body.id).toBe(1)
    })

    it('POST /api/endpoints rejects invalid body', async () => {
      const { POST } = await getEndpointRoute()
      const res = await POST(
        mockReq('POST', 'http://localhost/api/endpoints', {
          name: '',
          base_url: 'not-a-url',
        }),
      )
      expect(res.status).toBe(400)
    })

    it('PUT /api/endpoints/[id] updates an endpoint', async () => {
      // Seed an endpoint first
      const { POST } = await getEndpointRoute()
      await POST(
        mockReq('POST', 'http://localhost/api/endpoints', {
          name: 'OpenAI',
          base_url: 'https://api.openai.com/v1',
          api_key: 'sk-test',
        }),
      )

      const { PUT } = await getEndpointIdRoute()
      const res = await PUT(
        mockReq('PUT', 'http://localhost/api/endpoints/1', { name: 'OpenAI Updated' }),
        { params: Promise.resolve({ id: '1' }) },
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.name).toBe('OpenAI Updated')
      expect(body.base_url).toBe('https://api.openai.com/v1')
    })

    it('PUT /api/endpoints/[id] returns 404 for missing endpoint', async () => {
      const { PUT } = await getEndpointIdRoute()
      const res = await PUT(
        mockReq('PUT', 'http://localhost/api/endpoints/999', { name: 'X' }),
        { params: Promise.resolve({ id: '999' }) },
      )
      expect(res.status).toBe(404)
    })

    it('DELETE /api/endpoints/[id] with no references succeeds', async () => {
      // Seed
      const { POST } = await getEndpointRoute()
      await POST(
        mockReq('POST', 'http://localhost/api/endpoints', {
          name: 'OpenAI',
          base_url: 'https://api.openai.com/v1',
          api_key: 'sk-test',
        }),
      )

      const { DELETE: DEL } = await getEndpointIdRoute()
      const res = await DEL(
        mockReq('DELETE', 'http://localhost/api/endpoints/1'),
        { params: Promise.resolve({ id: '1' }) },
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.success).toBe(true)
    })

    it('DELETE /api/endpoints/[id] returns usedBySessions when referenced', async () => {
      // Seed endpoint
      const { POST: epPost } = await getEndpointRoute()
      await epPost(
        mockReq('POST', 'http://localhost/api/endpoints', {
          name: 'OpenAI',
          base_url: 'https://api.openai.com/v1',
          api_key: 'sk-test',
        }),
      )

      // Create a session that references this endpoint in its config_snapshot
      const { createRepositories } = await import('@/src/lib/db/repositories')
      const repos = createRepositories(db)
      const snapshot = JSON.stringify({
        endpoint: { id: 1, name: 'OpenAI', base_url: 'https://api.openai.com/v1', api_key: 'sk-test' },
        agents: [],
        coordinator: null,
        prompts: {},
      })
      repos.sessions.insert({
        id: 's1',
        source_text: 'Hello',
        source_lang: '英文',
        target_lang: '中文',
        state: 'draft',
        config_snapshot: snapshot,
      })

      const { DELETE: DEL } = await getEndpointIdRoute()
      const res = await DEL(
        mockReq('DELETE', 'http://localhost/api/endpoints/1'),
        { params: Promise.resolve({ id: '1' }) },
      )
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.usedBySessions).toEqual(['s1'])
    })

    it('DELETE /api/endpoints/[id] returns 404 for missing endpoint', async () => {
      const { DELETE: DEL } = await getEndpointIdRoute()
      const res = await DEL(
        mockReq('DELETE', 'http://localhost/api/endpoints/999'),
        { params: Promise.resolve({ id: '999' }) },
      )
      expect(res.status).toBe(404)
    })
  })

  // ── Agents ───────────────────────────────────────────────────────

  describe('agents', () => {
    async function seedEndpoint() {
      const { POST } = await getEndpointRoute()
      await POST(
        mockReq('POST', 'http://localhost/api/endpoints', {
          name: 'OpenAI',
          base_url: 'https://api.openai.com/v1',
          api_key: 'sk-test',
        }),
      )
    }

    it('GET /api/agents returns empty list initially', async () => {
      const { GET } = await getAgentRoute()
      const res = await GET(mockReq('GET', 'http://localhost/api/agents'))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual([])
    })

    it('POST /api/agents creates an agent', async () => {
      await seedEndpoint()
      const { POST } = await getAgentRoute()
      const res = await POST(
        mockReq('POST', 'http://localhost/api/agents', {
          name: 'Agent A',
          endpoint_id: 1,
          model: 'gpt-4o',
          sort_order: 0,
        }),
      )
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.name).toBe('Agent A')
      expect(body.model).toBe('gpt-4o')
    })

    it('POST /api/agents rejects non-existent endpoint_id', async () => {
      const { POST } = await getAgentRoute()
      const res = await POST(
        mockReq('POST', 'http://localhost/api/agents', {
          name: 'Agent A',
          endpoint_id: 999,
          model: 'gpt-4o',
        }),
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('999')
    })

    it('POST /api/agents rejects empty model', async () => {
      await seedEndpoint()
      const { POST } = await getAgentRoute()
      const res = await POST(
        mockReq('POST', 'http://localhost/api/agents', {
          name: 'Agent A',
          endpoint_id: 1,
          model: '',
        }),
      )
      expect(res.status).toBe(400)
    })

    it('PUT /api/agents/[id] updates an agent', async () => {
      await seedEndpoint()
      const { POST } = await getAgentRoute()
      await POST(
        mockReq('POST', 'http://localhost/api/agents', {
          name: 'Agent A',
          endpoint_id: 1,
          model: 'gpt-4o',
        }),
      )

      const { PUT } = await getAgentIdRoute()
      const res = await PUT(
        mockReq('PUT', 'http://localhost/api/agents/1', { name: 'Agent A Updated', model: 'gpt-4-turbo' }),
        { params: Promise.resolve({ id: '1' }) },
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.name).toBe('Agent A Updated')
      expect(body.model).toBe('gpt-4-turbo')
    })

    it('DELETE /api/agents/[id] removes an agent', async () => {
      await seedEndpoint()
      const { POST } = await getAgentRoute()
      await POST(
        mockReq('POST', 'http://localhost/api/agents', {
          name: 'Agent A',
          endpoint_id: 1,
          model: 'gpt-4o',
        }),
      )

      const { DELETE: DEL } = await getAgentIdRoute()
      const res = await DEL(
        mockReq('DELETE', 'http://localhost/api/agents/1'),
        { params: Promise.resolve({ id: '1' }) },
      )
      expect(res.status).toBe(200)

      const { GET } = await getAgentRoute()
      const listRes = await GET(mockReq('GET', 'http://localhost/api/agents'))
      const list = await listRes.json()
      expect(list).toEqual([])
    })
  })

  // ── Coordinator ──────────────────────────────────────────────────

  describe('coordinator', () => {
    it('GET /api/coordinator returns 404 when not configured', async () => {
      const { GET } = await getCoordinatorRoute()
      const res = await GET(mockReq('GET', 'http://localhost/api/coordinator'))
      expect(res.status).toBe(404)
    })

    it('PUT /api/coordinator creates config', async () => {
      const { PUT } = await getCoordinatorRoute()
      const res = await PUT(
        mockReq('PUT', 'http://localhost/api/coordinator', {
          model: 'gpt-4o',
          chat_model: 'gpt-4o-mini',
        }),
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.model).toBe('gpt-4o')
      expect(body.chat_model).toBe('gpt-4o-mini')
    })

    it('PUT /api/coordinator warns on flash model', async () => {
      const { PUT } = await getCoordinatorRoute()
      const res = await PUT(
        mockReq('PUT', 'http://localhost/api/coordinator', {
          model: 'gemini-1.5-flash',
          chat_model: 'gpt-4o-mini',
        }),
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.warning).toBe('不推荐使用flash模型进行统筹')
      expect(body.warning_id).toBe('flash_coordinator')
    })

    it('PUT /api/coordinator with suppress_warnings clears the warning', async () => {
      const { PUT } = await getCoordinatorRoute()

      // First: trigger flash warning
      await PUT(
        mockReq('PUT', 'http://localhost/api/coordinator', {
          model: 'gemini-1.5-flash',
          chat_model: 'gpt-4o-mini',
        }),
      )

      // Second: suppress it
      const res = await PUT(
        mockReq('PUT', 'http://localhost/api/coordinator', {
          model: 'gemini-1.5-flash',
          chat_model: 'gpt-4o-mini',
          suppress_warnings: ['flash_coordinator'],
        }),
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      // After suppression, no warning
      expect(body.warning).toBeUndefined()

      // Third: subsequent update also no warning
      const res2 = await PUT(
        mockReq('PUT', 'http://localhost/api/coordinator', {
          model: 'gemini-1.5-flash',
          chat_model: 'gpt-4o-mini',
        }),
      )
      const body2 = await res2.json()
      expect(body2.warning).toBeUndefined()
    })

    it('PUT /api/coordinator fallback preserves existing values', async () => {
      const { PUT } = await getCoordinatorRoute()

      // Create initial config
      await PUT(
        mockReq('PUT', 'http://localhost/api/coordinator', {
          model: 'gpt-4o',
          chat_endpoint_id: null,
          chat_model: 'gpt-4o-mini',
        }),
      )

      // Partial update — only model, chat_model should fallback
      const res = await PUT(
        mockReq('PUT', 'http://localhost/api/coordinator', {
          model: 'claude-3-opus',
        }),
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.model).toBe('claude-3-opus')
      expect(body.chat_model).toBe('gpt-4o-mini')
    })

    it('GET /api/coordinator returns config after PUT', async () => {
      const { PUT, GET } = await getCoordinatorRoute()

      await PUT(
        mockReq('PUT', 'http://localhost/api/coordinator', {
          model: 'gpt-4o',
          chat_model: 'gpt-4o-mini',
        }),
      )

      const res = await GET(mockReq('GET', 'http://localhost/api/coordinator'))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.model).toBe('gpt-4o')
    })
  })

  // ── Prompts ──────────────────────────────────────────────────────

  describe('prompts', () => {
    it('GET /api/prompts returns empty list initially', async () => {
      const { GET } = await getPromptsRoute()
      const res = await GET(mockReq('GET', 'http://localhost/api/prompts'))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual([])
    })

    it('GET /api/prompts?kind=translator filters by kind', async () => {
      const { POST, GET } = await getPromptsRoute()

      await POST(
        mockReq('POST', 'http://localhost/api/prompts', {
          kind: 'translator',
          name: 'Default Translator',
          content: 'Translate {{source_text}}',
        }),
      )
      await POST(
        mockReq('POST', 'http://localhost/api/prompts', {
          kind: 'review',
          name: 'Default Review',
          content: 'Review this translation',
        }),
      )

      const res = await GET(mockReq('GET', 'http://localhost/api/prompts?kind=translator'))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toHaveLength(1)
      expect(body[0].kind).toBe('translator')
    })

    it('POST /api/prompts creates a prompt', async () => {
      const { POST } = await getPromptsRoute()
      const res = await POST(
        mockReq('POST', 'http://localhost/api/prompts', {
          kind: 'translator',
          name: 'My Prompt',
          content: 'Hello {{source_text}}',
        }),
      )
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.kind).toBe('translator')
      expect(body.is_builtin).toBe(0)
    })

    it('PUT /api/prompts/[id] on builtin creates a copy', async () => {
      // Seed a builtin prompt directly
      const { createRepositories } = await import('@/src/lib/db/repositories')
      const repos = createRepositories(db)
      const r = repos.promptTemplates.insert({
        kind: 'translator',
        name: 'Builtin Prompt',
        content: 'Builtin content',
        is_builtin: 1,
      })
      const builtinId = r.lastInsertRowid as number

      const { PUT } = await getPromptsIdRoute()
      const res = await PUT(
        mockReq('PUT', `http://localhost/api/prompts/${builtinId}`, {
          name: 'My Override',
          content: 'Overridden content',
        }),
        { params: Promise.resolve({ id: String(builtinId) }) },
      )
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.is_builtin).toBe(0)
      expect(body.name).toBe('My Override')
      expect(body.content).toBe('Overridden content')
      // New ID should be different from original
      expect(body.id).not.toBe(builtinId)

      // Original builtin still intact
      const orig = repos.promptTemplates.getById(builtinId)
      expect(orig!.is_builtin).toBe(1)
      expect(orig!.name).toBe('Builtin Prompt')
    })

    it('PUT /api/prompts/[id] on non-builtin updates in-place', async () => {
      const { POST } = await getPromptsRoute()
      const createRes = await POST(
        mockReq('POST', 'http://localhost/api/prompts', {
          kind: 'translator',
          name: 'Custom Prompt',
          content: 'Original content',
        }),
      )
      const created = await createRes.json()

      const { PUT } = await getPromptsIdRoute()
      const res = await PUT(
        mockReq('PUT', `http://localhost/api/prompts/${created.id}`, {
          content: 'Updated content',
        }),
        { params: Promise.resolve({ id: String(created.id) }) },
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.id).toBe(created.id)
      expect(body.content).toBe('Updated content')
    })

    it('POST /api/prompts/reset restores builtin seeds', async () => {
      // Create some custom prompts first
      const { POST } = await getPromptsRoute()
      await POST(
        mockReq('POST', 'http://localhost/api/prompts', {
          kind: 'translator',
          name: 'Custom',
          content: 'Custom content',
        }),
      )

      const { POST: resetPost } = await getPromptsResetRoute()
      const res = await resetPost(mockReq('POST', 'http://localhost/api/prompts/reset'))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.success).toBe(true)
      // Should have 5 builtin seeds
      expect(body.prompts).toHaveLength(5)
      for (const p of body.prompts) {
        expect(p.is_builtin).toBe(1)
      }
    })
  })

  // ── Settings ─────────────────────────────────────────────────────

  describe('settings', () => {
    it('GET /api/settings returns empty list', async () => {
      const { GET } = await getSettingsRoute()
      const res = await GET(mockReq('GET', 'http://localhost/api/settings'))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual([])
    })

    it('PUT /api/settings upserts a key-value pair', async () => {
      const { PUT } = await getSettingsRoute()
      const res = await PUT(
        mockReq('PUT', 'http://localhost/api/settings', {
          key: 'theme',
          value: 'dark',
        }),
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.updated).toEqual([{ key: 'theme', value: 'dark' }])
    })

    it('PUT /api/settings accepts an array', async () => {
      const { PUT } = await getSettingsRoute()
      const res = await PUT(
        mockReq('PUT', 'http://localhost/api/settings', [
          { key: 'theme', value: 'dark' },
          { key: 'lang', value: 'zh' },
        ]),
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.updated).toHaveLength(2)
    })

    it('GET /api/settings returns stored pairs', async () => {
      const { PUT, GET } = await getSettingsRoute()

      await PUT(
        mockReq('PUT', 'http://localhost/api/settings', {
          key: 'theme',
          value: 'dark',
        }),
      )
      await PUT(
        mockReq('PUT', 'http://localhost/api/settings', {
          key: 'lang',
          value: 'zh',
        }),
      )

      const res = await GET(mockReq('GET', 'http://localhost/api/settings'))
      expect(res.status).toBe(200)
      const body = await res.json()
      // sorted by key
      expect(body).toEqual([
        { key: 'lang', value: 'zh' },
        { key: 'theme', value: 'dark' },
      ])
    })
  })
})
