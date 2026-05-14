// ---------------------------------------------------------------------------
// Session Detail API — GET /api/sessions/:id  (full state with child records)
// ---------------------------------------------------------------------------
import { NextRequest, NextResponse } from 'next/server'
import Database from 'better-sqlite3'
import { getDb } from '@/src/lib/db'
import { createRepositories } from '@/src/lib/db/repositories'
import { createSessionService } from '@/src/lib/services/session-service'

export const runtime = 'nodejs'

// ── Factory (injectable for tests) ────────────────────────────────

export function createHandlers(db: Database.Database) {
  const repos = createRepositories(db)
  const service = createSessionService(db, repos)

  return {
    // ────────────────────────────────────────────────────────────
    // GET /api/sessions/:id — full session with child records
    // ────────────────────────────────────────────────────────────
    async GET(
      _request: NextRequest,
      { params }: { params: Promise<{ id: string }> },
    ) {
      const { id } = await params
      const full = service.getSessionFull(id)

      if (!full) {
        return NextResponse.json(
          { error: 'session_not_found', message: `Session not found: ${id}` },
          { status: 404 },
        )
      }

      // Attach latest version_no as a top-level convenience field
      const latestVersionNo =
        full.versions.length > 0
          ? full.versions[full.versions.length - 1].version_no
          : null

      return NextResponse.json(
        {
          session: full.session,
          results: full.results,
          stages: full.stages,
          versions: full.versions,
          messages: full.messages,
          latest_version_no: latestVersionNo,
        },
        { status: 200 },
      )
    },
  }
}

// ── Production export (lazy singleton) ────────────────────────────
let _handlers: ReturnType<typeof createHandlers> | null = null
function prod(): ReturnType<typeof createHandlers> {
  if (!_handlers) _handlers = createHandlers(getDb())
  return _handlers
}

export const GET = (
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) => prod().GET(req, ctx)
