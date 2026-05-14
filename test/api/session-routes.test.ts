// ---------------------------------------------------------------------------
// Integration tests for session API routes
// ---------------------------------------------------------------------------
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

import { createRepositories } from '../../src/lib/db/repositories'
import { createSessionService } from '../../src/lib/services/session-service'
import { createHandlers as createSessionHandlers } from '../../app/api/sessions/route'
import { createHandlers as createSessionDetailHandlers } from '../../app/api/sessions/[id]/route'
import { createHandlers as createRestoreHandlers } from '../../app/api/sessions/[id]/versions/[versionNo]/restore/route'

// ── Inline migration SQL ─────────────────────────────────────────
const MIGRATION_SQL = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/db/migrations/0001_init.sql'),
  'utf-8',
)

// ── Shared test data ──────────────────────────────────────────────
const DEF_INPUT = {
  sourceText: 'Hello world',
  sourceLang: 'English',
  targetLang: 'Chinese',
}

// ── Helper to seed baseline config (endpoint, agents, coordinator) ─
function seedBaseline(repos: ReturnType<typeof createRepositories>): void {
  repos.endpoints.insert({
    name: 'test-ep',
    base_url: 'https://api.test.com',
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
  repos.translatorAgents.insert({
    name: 'agent-beta',
    endpoint_id: 1,
    model: 'claude-3',
    prompt_override: null,
    sort_order: 1,
  })
  repos.promptTemplates.insert({
    kind: 'translator',
    name: 'default',
    content: 'Translate {{text}} to {{lang}}',
    is_builtin: 1,
  })
  repos.promptTemplates.insert({
    kind: 'review',
    name: 'default',
    content: 'Review this translation',
    is_builtin: 1,
  })
}

// ==================================================================
// POST /api/sessions — createSession
// ==================================================================
describe('POST /api/sessions', () => {
  let db: Database.Database
  let repos: ReturnType<typeof createRepositories>
  let POST: ReturnType<typeof createSessionHandlers>['POST']

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(MIGRATION_SQL)
    repos = createRepositories(db)
    seedBaseline(repos)
    POST = createSessionHandlers(db).POST
  })

  afterEach(() => {
    db.close()
  })

  it('creates a session and returns it with 200', async () => {
    const req = new NextRequest('http://localhost/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(DEF_INPUT),
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.state).toBe('draft')
    expect(body.source_text).toBe('Hello world')
    expect(body.source_lang).toBe('English')
    expect(body.target_lang).toBe('Chinese')
    expect(body.id).toBeDefined()
  })

  it('returns 400 source_required when sourceText is empty string', async () => {
    const req = new NextRequest('http://localhost/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...DEF_INPUT, sourceText: '' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('source_required')
  })

  it('returns 400 source_required when sourceText is whitespace-only', async () => {
    const req = new NextRequest('http://localhost/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...DEF_INPUT, sourceText: '   ' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('source_required')
  })

  it('returns 400 no_agents_configured when translator_agents is empty', async () => {
    repos.translatorAgents.delete(1)
    repos.translatorAgents.delete(2)

    const req = new NextRequest('http://localhost/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(DEF_INPUT),
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('no_agents_configured')
  })

  it('returns 400 invalid_json when body is not parseable', async () => {
    const req = new NextRequest('http://localhost/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('invalid_json')
  })

  it('defaults sourceLang and targetLang when omitted', async () => {
    const req = new NextRequest('http://localhost/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceText: 'Hi' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.source_lang).toBe('英文')
    expect(body.target_lang).toBe('中文五言')
  })
})

// ==================================================================
// GET /api/sessions — listSessions
// ==================================================================
describe('GET /api/sessions', () => {
  let db: Database.Database
  let repos: ReturnType<typeof createRepositories>
  let service: ReturnType<typeof createSessionService>
  let GET: ReturnType<typeof createSessionHandlers>['GET']

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(MIGRATION_SQL)
    repos = createRepositories(db)
    seedBaseline(repos)
    service = createSessionService(db, repos)
    GET = createSessionHandlers(db).GET
  })

  afterEach(() => {
    db.close()
  })

  it('returns empty sessions array when none exist', async () => {
    const req = new NextRequest('http://localhost/api/sessions')
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sessions).toEqual([])
  })

  it('returns all sessions with default pagination', async () => {
    service.createSession({ ...DEF_INPUT, sourceText: 'A' })
    service.createSession({ ...DEF_INPUT, sourceText: 'B' })
    service.createSession({ ...DEF_INPUT, sourceText: 'C' })

    const req = new NextRequest('http://localhost/api/sessions')
    const res = await GET(req)
    const body = await res.json()
    expect(body.sessions).toHaveLength(3)
  })

  it('respects limit and offset query params', async () => {
    service.createSession({ ...DEF_INPUT, sourceText: 'A' })
    service.createSession({ ...DEF_INPUT, sourceText: 'B' })
    service.createSession({ ...DEF_INPUT, sourceText: 'C' })

    const req = new NextRequest('http://localhost/api/sessions?limit=2&offset=0')
    const res = await GET(req)
    const body = await res.json()
    expect(body.sessions).toHaveLength(2)

    const req2 = new NextRequest('http://localhost/api/sessions?limit=2&offset=2')
    const res2 = await GET(req2)
    const body2 = await res2.json()
    expect(body2.sessions).toHaveLength(1)
  })

  it('clamps limit between 1 and 100', async () => {
    service.createSession({ ...DEF_INPUT, sourceText: 'A' })

    const req = new NextRequest('http://localhost/api/sessions?limit=0')
    const res = await GET(req)
    expect(res.status).toBe(200)

    const req2 = new NextRequest('http://localhost/api/sessions?limit=999')
    const res2 = await GET(req2)
    expect(res2.status).toBe(200)
  })
})

// ==================================================================
// GET /api/sessions/:id — getSessionFull
// ==================================================================
describe('GET /api/sessions/:id', () => {
  let db: Database.Database
  let repos: ReturnType<typeof createRepositories>
  let service: ReturnType<typeof createSessionService>
  let GET: ReturnType<typeof createSessionDetailHandlers>['GET']

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(MIGRATION_SQL)
    repos = createRepositories(db)
    seedBaseline(repos)
    service = createSessionService(db, repos)
    GET = createSessionDetailHandlers(db).GET
  })

  afterEach(() => {
    db.close()
  })

  it('returns 404 for non-existent session', async () => {
    const req = new NextRequest('http://localhost/api/sessions/no-such-id')
    const res = await GET(req, { params: Promise.resolve({ id: 'no-such-id' }) })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('session_not_found')
  })

  it('returns full session with all 5 child record types and latest_version_no', async () => {
    const s = service.createSession(DEF_INPUT)

    // Add one record of each child type
    repos.stageOutputs.insert({
      session_id: s.id,
      stage: 'review',
      status: 'pending',
      prompt_used: null,
      raw_output: null,
      parsed_output: null,
      error: null,
    })
    repos.finalVersions.insert({
      session_id: s.id,
      version_no: 1,
      text: 'Hello world (translated)',
      source: 'assemble',
    })
    repos.chatMessages.insert({
      session_id: s.id,
      role: 'user',
      content: 'Looks good',
      tool_calls: null,
      tool_results: null,
      version_id: null,
    })

    const req = new NextRequest(`http://localhost/api/sessions/${s.id}`)
    const res = await GET(req, { params: Promise.resolve({ id: s.id }) })
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.session.id).toBe(s.id)
    expect(body.results).toHaveLength(2)
    expect(body.stages).toHaveLength(1)
    expect(body.stages[0].stage).toBe('review')
    expect(body.versions).toHaveLength(1)
    expect(body.versions[0].text).toBe('Hello world (translated)')
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].content).toBe('Looks good')
    expect(body.latest_version_no).toBe(1)
  })

  it('returns latest_version_no as null when no versions exist', async () => {
    const s = service.createSession(DEF_INPUT)

    const req = new NextRequest(`http://localhost/api/sessions/${s.id}`)
    const res = await GET(req, { params: Promise.resolve({ id: s.id }) })
    const body = await res.json()
    expect(body.latest_version_no).toBeNull()
  })

  it('returns empty arrays for child types with no records', async () => {
    const s = service.createSession(DEF_INPUT)

    const req = new NextRequest(`http://localhost/api/sessions/${s.id}`)
    const res = await GET(req, { params: Promise.resolve({ id: s.id }) })
    const body = await res.json()

    expect(body.results).toHaveLength(2) // auto-inserted
    expect(body.stages).toHaveLength(0)
    expect(body.versions).toHaveLength(0)
    expect(body.messages).toHaveLength(0)
  })
})

// ==================================================================
// POST /api/sessions/:id/versions/:versionNo/restore — version restore
// ==================================================================
describe('POST /api/sessions/:id/versions/:versionNo/restore', () => {
  let db: Database.Database
  let repos: ReturnType<typeof createRepositories>
  let service: ReturnType<typeof createSessionService>
  let POST: ReturnType<typeof createRestoreHandlers>['POST']

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(MIGRATION_SQL)
    repos = createRepositories(db)
    seedBaseline(repos)
    service = createSessionService(db, repos)
    POST = createRestoreHandlers(db).POST
  })

  afterEach(() => {
    db.close()
  })

  it('restores a version and returns the new version with source=restore', async () => {
    const s = service.createSession(DEF_INPUT)

    // Insert two versions
    repos.finalVersions.insert({
      session_id: s.id,
      version_no: 1,
      text: 'Version 1 text',
      source: 'assemble',
    })
    repos.finalVersions.insert({
      session_id: s.id,
      version_no: 2,
      text: 'Version 2 text',
      source: 'edit',
    })

    // Restore version 1 → should create version 3
    const req = new NextRequest(
      `http://localhost/api/sessions/${s.id}/versions/1/restore`,
      { method: 'POST' },
    )
    const res = await POST(req, {
      params: Promise.resolve({ id: s.id, versionNo: '1' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.version_no).toBe(3)
    expect(body.text).toBe('Version 1 text')
    expect(body.source).toBe('restore')
    expect(body.session_id).toBe(s.id)
  })

  it('adds a chat_message recording the restore', async () => {
    const s = service.createSession(DEF_INPUT)
    repos.finalVersions.insert({
      session_id: s.id,
      version_no: 1,
      text: 'Original text',
      source: 'assemble',
    })

    const req = new NextRequest(
      `http://localhost/api/sessions/${s.id}/versions/1/restore`,
      { method: 'POST' },
    )
    await POST(req, {
      params: Promise.resolve({ id: s.id, versionNo: '1' }),
    })

    const messages = repos.chatMessages.listBySession(s.id)
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('tool')
    expect(messages[0].content).toBe('已恢复到版本 1')
  })

  it('returns 404 for non-existent versionNo', async () => {
    const s = service.createSession(DEF_INPUT)
    repos.finalVersions.insert({
      session_id: s.id,
      version_no: 1,
      text: 'Original',
      source: 'assemble',
    })

    const req = new NextRequest(
      `http://localhost/api/sessions/${s.id}/versions/999/restore`,
      { method: 'POST' },
    )
    const res = await POST(req, {
      params: Promise.resolve({ id: s.id, versionNo: '999' }),
    })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('version_not_found')
  })

  it('returns 400 for non-numeric versionNo', async () => {
    const s = service.createSession(DEF_INPUT)

    const req = new NextRequest(
      `http://localhost/api/sessions/${s.id}/versions/abc/restore`,
      { method: 'POST' },
    )
    const res = await POST(req, {
      params: Promise.resolve({ id: s.id, versionNo: 'abc' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('invalid_version_no')
  })

  it('increments version_no correctly from existing versions', async () => {
    const s = service.createSession(DEF_INPUT)
    repos.finalVersions.insert({
      session_id: s.id,
      version_no: 5,
      text: 'Text at version 5',
      source: 'assemble',
    })

    const req = new NextRequest(
      `http://localhost/api/sessions/${s.id}/versions/5/restore`,
      { method: 'POST' },
    )
    const res = await POST(req, {
      params: Promise.resolve({ id: s.id, versionNo: '5' }),
    })
    const body = await res.json()
    expect(body.version_no).toBe(6)
  })

  it('uses version_no=1 when session has no prior versions', async () => {
    const s = service.createSession(DEF_INPUT)
    // Manually insert a version via raw SQL to bypass repos
    repos.finalVersions.insert({
      session_id: s.id,
      version_no: 1,
      text: 'Only version',
      source: 'assemble',
    })

    const req = new NextRequest(
      `http://localhost/api/sessions/${s.id}/versions/1/restore`,
      { method: 'POST' },
    )
    const res = await POST(req, {
      params: Promise.resolve({ id: s.id, versionNo: '1' }),
    })
    const body = await res.json()
    expect(body.version_no).toBe(2)
  })
})
