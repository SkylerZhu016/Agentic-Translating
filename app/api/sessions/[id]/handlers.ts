// ---------------------------------------------------------------------------
// Session Detail handlers — factory extracted from route.ts (Next 15.5 route
// modules may only export HTTP verbs + route config; tests import this)
// ---------------------------------------------------------------------------
import { NextRequest, NextResponse } from 'next/server'
import Database from 'better-sqlite3'
import { createRepositories } from '@/src/lib/db/repositories'
import { createSessionService } from '@/src/lib/services/session-service'
import { deleteRunArtifacts } from '@/src/lib/storage/run-artifacts'

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

    // ────────────────────────────────────────────────────────────
    // DELETE /api/sessions/:id — delete session + cascade txt artifacts
    // ────────────────────────────────────────────────────────────
    async DELETE(
      _request: NextRequest,
      { params }: { params: Promise<{ id: string }> },
    ) {
      const { id } = await params

      // Clean up txt artifacts (best-effort, never throws)
      deleteRunArtifacts(id)

      // Delete session from DB (cascades to child records)
      repos.sessions.delete(id)

      return new NextResponse(null, { status: 204 })
    },
  }
}
