/**
 * presets.test.ts — API route tests for /api/presets (Wave 3 Task 16)
 *
 * Covers:
 *   - POST /api/presets three creation modes
 *       1. Empty preset (no fromCurrentConfig, no fromPresetId)
 *       2. fromCurrentConfig=true → snapshot current global config
 *       3. fromPresetId=<id> → duplicate an existing preset
 *   - DELETE /api/presets/[id] builtin rejected with 400
 *   - POST /api/presets/[id]/load orphan warning + force
 *
 * Uses real SQLite in-memory DB per test. The route handlers use getDb() from
 * `@/src/lib/db` — we set `globalThis.__db` so the singleton returns our
 * in-memory instance.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { NextRequest } from 'next/server'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

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
  const reqWithNextUrl = req as Request & { nextUrl: URL }
  reqWithNextUrl.nextUrl = urlObj
  return reqWithNextUrl as unknown as NextRequest
}

// ── DB setup ───────────────────────────────────────────────────────
const MIGRATION_SQL_0001 = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/db/migrations/0001_init.sql'),
  'utf-8',
)
const MIGRATION_SQL_0002 = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/db/migrations/0002_presets_and_drop_parsed_output.sql'),
  'utf-8',
)

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(MIGRATION_SQL_0001)
  db.exec(MIGRATION_SQL_0002)
  // Insert migration records so migrate() is a no-op when handlers call it
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    applied_at TEXT DEFAULT (datetime('now'))
  )`)
  db.prepare('INSERT INTO migrations (version, name) VALUES (?, ?)').run(1, '0001_init.sql')
  db.prepare('INSERT INTO migrations (version, name) VALUES (?, ?)').run(2, '0002_presets_and_drop_parsed_output.sql')
  ;(globalThis as Record<string, unknown>).__db = db
  return db
}

// ── Dynamic import helpers (re-import each test to avoid stale state) ──
let presetsRouteModule: typeof import('@/app/api/presets/route') | null = null
let presetsIdRouteModule: typeof import('@/app/api/presets/[id]/route') | null = null
let presetsLoadRouteModule: typeof import('@/app/api/presets/[id]/load/route') | null = null

async function loadModules() {
  presetsRouteModule = await import('@/app/api/presets/route')
  presetsIdRouteModule = await import('@/app/api/presets/[id]/route')
  presetsLoadRouteModule = await import('@/app/api/presets/[id]/load/route')
}

async function getPresetsRoute() {
  if (!presetsRouteModule) await loadModules()
  return presetsRouteModule!
}
async function getPresetsIdRoute() {
  if (!presetsIdRouteModule) await loadModules()
  return presetsIdRouteModule!
}
async function getPresetsLoadRoute() {
  if (!presetsLoadRouteModule) await loadModules()
  return presetsLoadRouteModule!
}

// =============================================================================
// Suite
// =============================================================================

describe('Presets API Routes', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb()
  })

  afterEach(() => {
    db.close()
    delete (globalThis as Record<string, unknown>).__db
  })

  // ===========================================================================
  // GET /api/presets
  // ===========================================================================

  describe('GET /api/presets', () => {
    it('returns empty list when no presets exist', async () => {
      const { GET } = await getPresetsRoute()
      const res = await GET(mockReq('GET', 'http://localhost/api/presets'))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual([])
    })

    it('returns all presets as header rows', async () => {
      // Seed two presets directly via the route
      const { POST } = await getPresetsRoute()
      await POST(mockReq('POST', 'http://localhost/api/presets', { name: 'Preset A' }))
      await POST(mockReq('POST', 'http://localhost/api/presets', { name: 'Preset B' }))

      const { GET } = await getPresetsRoute()
      const res = await GET(mockReq('GET', 'http://localhost/api/presets'))
      const body = await res.json()
      expect(body).toHaveLength(2)
      const names = body.map((p: { name: string }) => p.name)
      expect(names).toContain('Preset A')
      expect(names).toContain('Preset B')
    })
  })

  // ===========================================================================
  // POST /api/presets — three creation modes
  // ===========================================================================

  describe('POST /api/presets — creation modes', () => {
    it('mode 1: empty preset when no fromCurrentConfig and no fromPresetId', async () => {
      const { POST } = await getPresetsRoute()
      const res = await POST(
        mockReq('POST', 'http://localhost/api/presets', {
          name: 'Empty Preset',
          description: 'An empty preset',
        }),
      )
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.id).toBeDefined()
      expect(typeof body.id).toBe('number')

      // Verify the preset exists with no children
      const { GET: GET_ID } = await getPresetsIdRoute()
      const getRes = await GET_ID(
        mockReq('GET', `http://localhost/api/presets/${body.id}`),
        { params: Promise.resolve({ id: String(body.id) }) },
      )
      const full = await getRes.json()
      expect(full.preset.name).toBe('Empty Preset')
      expect(full.preset.description).toBe('An empty preset')
      expect(full.agents).toEqual([])
      expect(full.coordinator).toBeNull()
      expect(full.prompts).toEqual([])
    })

    it('mode 2: fromCurrentConfig=true snapshots current global config', async () => {
      // Seed global config: endpoint, agents, coordinator, prompts
      const { createRepositories } = await import('@/src/lib/db/repositories')
      const repos = createRepositories(db)
      repos.endpoints.insert({
        name: 'test-ep', base_url: 'https://api.test.com', api_key: 'sk-test',
      })
      repos.translatorAgents.insert({
        name: 'global-agent-1', endpoint_id: 1, model: 'gpt-4',
        prompt_override: null, sort_order: 0,
      })
      repos.translatorAgents.insert({
        name: 'global-agent-2', endpoint_id: 1, model: 'claude-3',
        prompt_override: 'custom', sort_order: 1,
      })
      repos.coordinatorConfig.upsert({
        endpoint_id: 1, model: 'gpt-4o',
        chat_endpoint_id: 1, chat_model: 'gpt-4o-mini',
      })
      repos.promptTemplates.insert({
        kind: 'translator', name: 'global-translator',
        content: 'Translate: {{source_text}}', is_builtin: 0,
      })
      repos.promptTemplates.insert({
        kind: 'review', name: 'global-review',
        content: 'Review: {{context}}', is_builtin: 0,
      })

      const { POST } = await getPresetsRoute()
      const res = await POST(
        mockReq('POST', 'http://localhost/api/presets', {
          name: 'Snapshot Preset',
          fromCurrentConfig: true,
        }),
      )
      expect(res.status).toBe(201)
      const body = await res.json()
      const presetId = body.id

      // Verify the preset captured the global config
      const { GET: GET_ID } = await getPresetsIdRoute()
      const getRes = await GET_ID(
        mockReq('GET', `http://localhost/api/presets/${presetId}`),
        { params: Promise.resolve({ id: String(presetId) }) },
      )
      const full = await getRes.json()
      expect(full.agents).toHaveLength(2)
      expect(full.agents[0].name).toBe('global-agent-1')
      expect(full.agents[1].prompt_override).toBe('custom')
      expect(full.coordinator).not.toBeNull()
      expect(full.coordinator.model).toBe('gpt-4o')
      expect(full.coordinator.chat_model).toBe('gpt-4o-mini')
      // All 2 prompt templates should be captured
      expect(full.prompts).toHaveLength(2)
      const kinds = full.prompts.map((p: { kind: string }) => p.kind)
      expect(kinds).toContain('translator')
      expect(kinds).toContain('review')
    })

    it('mode 3: fromPresetId duplicates an existing preset', async () => {
      // Create a source preset with content
      const { POST } = await getPresetsRoute()
      const createRes = await POST(
        mockReq('POST', 'http://localhost/api/presets', { name: 'Source' }),
      )
      const sourceId = (await createRes.json()).id

      // Add content to source via PUT
      const { PUT } = await getPresetsIdRoute()
      await PUT(
        mockReq('PUT', `http://localhost/api/presets/${sourceId}`, {
          agents: [
            { name: 'Source Agent', endpoint_id: null, model: 'm', prompt_override: null, sort_order: 0 },
          ],
          coordinator: null,
          prompts: [
            { kind: 'translator', name: 'p', content: 'translate' },
          ],
        }),
        { params: Promise.resolve({ id: String(sourceId) }) },
      )

      // Duplicate via fromPresetId
      const dupRes = await POST(
        mockReq('POST', 'http://localhost/api/presets', {
          name: 'Duplicate',
          fromPresetId: sourceId,
        }),
      )
      expect(dupRes.status).toBe(201)
      const dupId = (await dupRes.json()).id
      expect(dupId).not.toBe(sourceId)

      // Verify duplicate has the same content
      const { GET: GET_ID } = await getPresetsIdRoute()
      const getRes = await GET_ID(
        mockReq('GET', `http://localhost/api/presets/${dupId}`),
        { params: Promise.resolve({ id: String(dupId) }) },
      )
      const full = await getRes.json()
      expect(full.preset.name).toBe('Duplicate')
      expect(full.agents).toHaveLength(1)
      expect(full.agents[0].name).toBe('Source Agent')
      expect(full.prompts).toHaveLength(1)
      expect(full.prompts[0].kind).toBe('translator')
    })

    it('returns 404 when fromPresetId does not exist', async () => {
      const { POST } = await getPresetsRoute()
      const res = await POST(
        mockReq('POST', 'http://localhost/api/presets', {
          name: 'Copy',
          fromPresetId: 9999,
        }),
      )
      expect(res.status).toBe(404)
    })

    it('returns 400 when name is missing', async () => {
      const { POST } = await getPresetsRoute()
      const res = await POST(
        mockReq('POST', 'http://localhost/api/presets', { description: 'no name' }),
      )
      expect(res.status).toBe(400)
    })

    it('returns 400 when body is not valid JSON', async () => {
      const { POST } = await getPresetsRoute()
      const req = new Request('http://localhost/api/presets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'this is not json',
      })
      const res = await POST(req as unknown as NextRequest)
      expect(res.status).toBe(400)
    })
  })

  // ===========================================================================
  // GET /api/presets/[id]
  // ===========================================================================

  describe('GET /api/presets/[id]', () => {
    it('returns the full preset with children', async () => {
      const { POST } = await getPresetsRoute()
      const createRes = await POST(
        mockReq('POST', 'http://localhost/api/presets', { name: 'Get Full' }),
      )
      const id = (await createRes.json()).id

      const { GET } = await getPresetsIdRoute()
      const res = await GET(
        mockReq('GET', `http://localhost/api/presets/${id}`),
        { params: Promise.resolve({ id: String(id) }) },
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.preset.id).toBe(id)
      expect(body.agents).toEqual([])
      expect(body.coordinator).toBeNull()
      expect(body.prompts).toEqual([])
    })

    it('returns 404 when preset does not exist', async () => {
      const { GET } = await getPresetsIdRoute()
      const res = await GET(
        mockReq('GET', 'http://localhost/api/presets/9999'),
        { params: Promise.resolve({ id: '9999' }) },
      )
      expect(res.status).toBe(404)
    })

    it('returns 400 for non-numeric id', async () => {
      const { GET } = await getPresetsIdRoute()
      const res = await GET(
        mockReq('GET', 'http://localhost/api/presets/abc'),
        { params: Promise.resolve({ id: 'abc' }) },
      )
      expect(res.status).toBe(400)
    })
  })

  // ===========================================================================
  // DELETE /api/presets/[id] — builtin rejected
  // ===========================================================================

  describe('DELETE /api/presets/[id]', () => {
    it('rejects deletion of a builtin preset with 400', async () => {
      // Seed a builtin preset directly
      const { createRepositories } = await import('@/src/lib/db/repositories')
      const repos = createRepositories(db)
      // Mark a preset as builtin
      const info = db.prepare(
        'INSERT INTO config_presets (name, description, is_builtin) VALUES (?, ?, 1)',
      ).run('Builtin', 'System preset')
      const builtinId = Number(info.lastInsertRowid)

      const { DELETE } = await getPresetsIdRoute()
      const res = await DELETE(
        mockReq('DELETE', `http://localhost/api/presets/${builtinId}`),
        { params: Promise.resolve({ id: String(builtinId) }) },
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/builtin/i)

      // The preset must still exist
      const stillThere = db.prepare('SELECT * FROM config_presets WHERE id = ?').get(builtinId)
      expect(stillThere).toBeDefined()
    })

    it('deletes a non-builtin preset successfully', async () => {
      const { POST } = await getPresetsRoute()
      const createRes = await POST(
        mockReq('POST', 'http://localhost/api/presets', { name: 'To Delete' }),
      )
      const id = (await createRes.json()).id

      const { DELETE } = await getPresetsIdRoute()
      const res = await DELETE(
        mockReq('DELETE', `http://localhost/api/presets/${id}`),
        { params: Promise.resolve({ id: String(id) }) },
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.success).toBe(true)

      // Verify it's gone
      const { GET } = await getPresetsIdRoute()
      const getRes = await GET(
        mockReq('GET', `http://localhost/api/presets/${id}`),
        { params: Promise.resolve({ id: String(id) }) },
      )
      expect(getRes.status).toBe(404)
    })

    it('returns 404 when deleting a non-existent preset', async () => {
      const { DELETE } = await getPresetsIdRoute()
      const res = await DELETE(
        mockReq('DELETE', 'http://localhost/api/presets/9999'),
        { params: Promise.resolve({ id: '9999' }) },
      )
      expect(res.status).toBe(404)
    })

    it('returns 400 for non-numeric id', async () => {
      const { DELETE } = await getPresetsIdRoute()
      const res = await DELETE(
        mockReq('DELETE', 'http://localhost/api/presets/abc'),
        { params: Promise.resolve({ id: 'abc' }) },
      )
      expect(res.status).toBe(400)
    })
  })

  // ===========================================================================
  // PUT /api/presets/[id] — update preset content
  // ===========================================================================

  describe('PUT /api/presets/[id]', () => {
    it('updates preset name and description', async () => {
      const { POST } = await getPresetsRoute()
      const createRes = await POST(
        mockReq('POST', 'http://localhost/api/presets', { name: 'Old Name', description: 'old' }),
      )
      const id = (await createRes.json()).id

      const { PUT } = await getPresetsIdRoute()
      const res = await PUT(
        mockReq('PUT', `http://localhost/api/presets/${id}`, {
          name: 'New Name',
          description: 'new desc',
        }),
        { params: Promise.resolve({ id: String(id) }) },
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.preset.name).toBe('New Name')
      expect(body.preset.description).toBe('new desc')
    })

    it('replaces preset content (agents, coordinator, prompts)', async () => {
      const { POST } = await getPresetsRoute()
      const createRes = await POST(
        mockReq('POST', 'http://localhost/api/presets', { name: 'Content Update' }),
      )
      const id = (await createRes.json()).id

      // Seed endpoint for agent reference
      const { createRepositories } = await import('@/src/lib/db/repositories')
      const repos = createRepositories(db)
      repos.endpoints.insert({
        name: 'ep', base_url: 'https://x', api_key: 'k',
      })

      const { PUT } = await getPresetsIdRoute()
      const res = await PUT(
        mockReq('PUT', `http://localhost/api/presets/${id}`, {
          agents: [
            { name: 'A', endpoint_id: 1, model: 'm', prompt_override: null, sort_order: 0 },
          ],
          coordinator: { endpoint_id: 1, model: 'c', chat_endpoint_id: null, chat_model: 'cm' },
          prompts: [{ kind: 'translator', name: 'p', content: 'c' }],
        }),
        { params: Promise.resolve({ id: String(id) }) },
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.agents).toHaveLength(1)
      expect(body.agents[0].name).toBe('A')
      expect(body.coordinator).not.toBeNull()
      expect(body.coordinator.model).toBe('c')
      expect(body.prompts).toHaveLength(1)
    })

    it('returns 404 for non-existent preset', async () => {
      const { PUT } = await getPresetsIdRoute()
      const res = await PUT(
        mockReq('PUT', 'http://localhost/api/presets/9999', { name: 'X' }),
        { params: Promise.resolve({ id: '9999' }) },
      )
      expect(res.status).toBe(404)
    })

    it('returns 400 for invalid body', async () => {
      const { POST } = await getPresetsRoute()
      const createRes = await POST(
        mockReq('POST', 'http://localhost/api/presets', { name: 'Bad Body' }),
      )
      const id = (await createRes.json()).id

      const { PUT } = await getPresetsIdRoute()
      const req = new Request(`http://localhost/api/presets/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      })
      const res = await PUT(req as unknown as NextRequest, {
        params: Promise.resolve({ id: String(id) }),
      })
      expect(res.status).toBe(400)
    })
  })

  // ===========================================================================
  // POST /api/presets/[id]/load — orphan warning + force
  // ===========================================================================

  describe('POST /api/presets/[id]/load', () => {
    /** Build a preset that references existing endpoint id=1 only */
    async function seedValidPreset(): Promise<number> {
      const { createRepositories } = await import('@/src/lib/db/repositories')
      const repos = createRepositories(db)
      repos.endpoints.insert({
        name: 'ep', base_url: 'https://x', api_key: 'k',
      })

      const { POST } = await getPresetsRoute()
      const createRes = await POST(
        mockReq('POST', 'http://localhost/api/presets', { name: 'Loadable' }),
      )
      const id = (await createRes.json()).id

      const { PUT } = await getPresetsIdRoute()
      await PUT(
        mockReq('PUT', `http://localhost/api/presets/${id}`, {
          agents: [
            { name: 'A', endpoint_id: 1, model: 'm', prompt_override: null, sort_order: 0 },
          ],
          coordinator: { endpoint_id: 1, model: 'c', chat_endpoint_id: 1, chat_model: 'cm' },
          prompts: [{ kind: 'translator', name: 'p', content: 'c' }],
        }),
        { params: Promise.resolve({ id: String(id) }) },
      )
      return id
    }

    /** Build a preset that references orphan endpoint id=99 (FK disabled for insert) */
    async function seedOrphanPreset(): Promise<number> {
      const { createRepositories } = await import('@/src/lib/db/repositories')
      const repos = createRepositories(db)
      // Create endpoint 1 (will exist) so saveContent can use it
      repos.endpoints.insert({
        name: 'ep', base_url: 'https://x', api_key: 'k',
      })

      const { POST } = await getPresetsRoute()
      const createRes = await POST(
        mockReq('POST', 'http://localhost/api/presets', { name: 'Orphan Ref' }),
      )
      const id = (await createRes.json()).id

      // Insert a preset coordinator that references orphan endpoint 99
      // (FK must be off)
      const wasFkOn = db.pragma('foreign_keys', { simple: true }) === 1
      if (wasFkOn) db.pragma('foreign_keys = OFF')
      try {
        db.prepare(
          'INSERT INTO config_preset_coordinator (preset_id, endpoint_id, model, chat_endpoint_id, chat_model) VALUES (?, ?, ?, ?, ?)',
        ).run(id, 99, 'orphan-coord', null, '')
        db.prepare(
          'INSERT INTO config_preset_agents (preset_id, name, endpoint_id, model, prompt_override, sort_order) VALUES (?, ?, ?, ?, NULL, ?)',
        ).run(id, 'orphan-agent', 99, 'm', 0)
      } finally {
        if (wasFkOn) db.pragma('foreign_keys = ON')
      }
      return id
    }

    it('applies the preset to global config when no orphans (applied=true, warnings=[])', async () => {
      const id = await seedValidPreset()

      const { POST: LOAD } = await getPresetsLoadRoute()
      const res = await LOAD(
        mockReq('POST', `http://localhost/api/presets/${id}/load`, {}),
        { params: Promise.resolve({ id: String(id) }) },
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.applied).toBe(true)
      expect(body.warnings).toEqual([])

      // Verify global config was updated
      const { createRepositories } = await import('@/src/lib/db/repositories')
      const repos = createRepositories(db)
      const agents = repos.translatorAgents.list()
      expect(agents).toHaveLength(1)
      expect(agents[0].name).toBe('A')
      const coord = repos.coordinatorConfig.get()
      expect(coord).toBeDefined()
      expect(coord!.model).toBe('c')
    })

    it('returns applied=false with orphan warnings when orphans detected and force not set', async () => {
      const id = await seedOrphanPreset()

      const { POST: LOAD } = await getPresetsLoadRoute()
      const res = await LOAD(
        mockReq('POST', `http://localhost/api/presets/${id}/load`, {}),
        { params: Promise.resolve({ id: String(id) }) },
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.applied).toBe(false)
      expect(Array.isArray(body.warnings)).toBe(true)
      expect(body.warnings.length).toBeGreaterThan(0)

      // Verify warnings mention endpoint 99
      const orphanIds = body.warnings.map((w: { endpointId: number }) => w.endpointId)
      expect(orphanIds).toContain(99)

      // Global config must NOT have been modified (still empty)
      const { createRepositories } = await import('@/src/lib/db/repositories')
      const repos = createRepositories(db)
      expect(repos.translatorAgents.list()).toHaveLength(0)
    })

    it('applies with force=true, skipping orphaned endpoint references', async () => {
      const id = await seedOrphanPreset()

      const { POST: LOAD } = await getPresetsLoadRoute()
      const res = await LOAD(
        mockReq('POST', `http://localhost/api/presets/${id}/load`, { force: true }),
        { params: Promise.resolve({ id: String(id) }) },
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.applied).toBe(true)
      // Warnings are still returned so the caller knows what was skipped
      expect(body.warnings.length).toBeGreaterThan(0)

      // Global config: orphan-agent should have been skipped (no endpoint 99)
      const { createRepositories } = await import('@/src/lib/db/repositories')
      const repos = createRepositories(db)
      const agents = repos.translatorAgents.list()
      // Orphan agent references endpoint 99 → must be skipped
      expect(agents.find((a) => a.name === 'orphan-agent')).toBeUndefined()

      // Coordinator: endpoint_id=99 → nullified (no FK violation because null)
      const coord = repos.coordinatorConfig.get()
      expect(coord).toBeDefined()
      expect(coord!.endpoint_id).toBeNull()
      expect(coord!.model).toBe('orphan-coord')
    })

    it('returns 404 when preset does not exist', async () => {
      const { POST: LOAD } = await getPresetsLoadRoute()
      const res = await LOAD(
        mockReq('POST', 'http://localhost/api/presets/9999/load', {}),
        { params: Promise.resolve({ id: '9999' }) },
      )
      expect(res.status).toBe(404)
    })

    it('returns 400 for non-numeric id', async () => {
      const { POST: LOAD } = await getPresetsLoadRoute()
      const res = await LOAD(
        mockReq('POST', 'http://localhost/api/presets/abc/load', {}),
        { params: Promise.resolve({ id: 'abc' }) },
      )
      expect(res.status).toBe(400)
    })

    it('defaults force to false when body is empty', async () => {
      const id = await seedOrphanPreset()

      // Send with completely empty body (no JSON at all)
      const { POST: LOAD } = await getPresetsLoadRoute()
      const req = new Request(`http://localhost/api/presets/${id}/load`, {
        method: 'POST',
      })
      const res = await LOAD(req as unknown as NextRequest, {
        params: Promise.resolve({ id: String(id) }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      // Without force, orphan warnings should prevent apply
      expect(body.applied).toBe(false)
      expect(body.warnings.length).toBeGreaterThan(0)
    })
  })
})
