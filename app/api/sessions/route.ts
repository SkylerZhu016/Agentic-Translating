// ---------------------------------------------------------------------------
// Sessions API — POST (create) + GET (list with pagination)
// ---------------------------------------------------------------------------
import { NextRequest, NextResponse } from 'next/server'
import Database from 'better-sqlite3'
import { getDb } from '@/src/lib/db'
import { createRepositories } from '@/src/lib/db/repositories'
import {
  createSessionService,
  NoAgentsConfiguredError,
} from '@/src/lib/services/session-service'
import {
  SourceRequiredError,
  SourceTooLongError,
} from '@/src/lib/guards'

export const runtime = 'nodejs'

// ── Factory (injectable for tests) ────────────────────────────────

export function createHandlers(db: Database.Database) {
  const repos = createRepositories(db)
  const service = createSessionService(db, repos)

  return {
    // ────────────────────────────────────────────────────────────
    // POST /api/sessions — create a new translation session
    // ────────────────────────────────────────────────────────────
    async POST(request: NextRequest) {
      let body: any
      try {
        body = await request.json()
      } catch {
        return NextResponse.json(
          { error: 'invalid_json', message: 'Invalid JSON body' },
          { status: 400 },
        )
      }

      // Normalise undefined to default values before passing to service
      const input = {
        sourceText: body.sourceText,
        sourceLang: body.sourceLang ?? '英文',
        targetLang: body.targetLang ?? '中文五言',
      }

      try {
        const session = service.createSession(input)
        return NextResponse.json(session, { status: 200 })
      } catch (err) {
        if (err instanceof NoAgentsConfiguredError) {
          return NextResponse.json(
            { error: 'no_agents_configured', message: err.message },
            { status: 400 },
          )
        }
        if (err instanceof SourceRequiredError) {
          return NextResponse.json(
            { error: 'source_required', message: err.message },
            { status: 400 },
          )
        }
        if (err instanceof SourceTooLongError) {
          return NextResponse.json(
            { error: 'source_too_long', message: err.message },
            { status: 400 },
          )
        }
        // Re-throw unexpected errors
        throw err
      }
    },

    // ────────────────────────────────────────────────────────────
    // GET /api/sessions — paginated list (most recent first)
    // ────────────────────────────────────────────────────────────
    async GET(request: NextRequest) {
      const { searchParams } = new URL(request.url)
      const limit = Math.max(1, Math.min(100, parseInt(searchParams.get('limit') || '20', 10) || 20))
      const offset = Math.max(0, parseInt(searchParams.get('offset') || '0', 10) || 0)

      const sessions = service.listSessions({ limit, offset })
      return NextResponse.json({ sessions }, { status: 200 })
    },
  }
}

// ── Production export (lazy singleton — avoids eager DB init at import) ─
let _handlers: ReturnType<typeof createHandlers> | null = null
function prod(): ReturnType<typeof createHandlers> {
  if (!_handlers) _handlers = createHandlers(getDb())
  return _handlers
}

export const POST = (req: NextRequest) => prod().POST(req)
export const GET = (req: NextRequest) => prod().GET(req)
