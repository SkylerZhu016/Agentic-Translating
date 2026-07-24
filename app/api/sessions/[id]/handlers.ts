// ---------------------------------------------------------------------------
// Session Detail handlers — factory extracted from route.ts (Next 15.5 route
// modules may only export HTTP verbs + route config; tests import this)
// ---------------------------------------------------------------------------
import { NextRequest, NextResponse } from 'next/server'
import Database from 'better-sqlite3'
import { createRepositories } from '@/src/lib/db/repositories'
import { createSessionService } from '@/src/lib/services/session-service'
import { deleteRunArtifacts } from '@/src/lib/storage/run-artifacts'
import {
  redactSecrets,
  toPublicSessionDto,
} from '@/src/lib/security/public-dto'
import { checkTranslationEvidence } from '@/src/lib/evidence/checker'
import type { ConfigSnapshot } from '@/src/lib/contracts/types'

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
      const hasVNext = Boolean(
        db.prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_invocations'",
        ).get(),
      )
      const invocations = hasVNext
        ? db.prepare(
            'SELECT * FROM agent_invocations WHERE session_id=? ORDER BY created_at, id',
          ).all(id)
        : []
      const patches = hasVNext
        ? db.prepare(
            'SELECT * FROM text_patches WHERE session_id=? ORDER BY created_at, id',
          ).all(id)
        : []
      const runs = hasVNext
        ? db.prepare(
            'SELECT * FROM orchestration_runs WHERE session_id=? ORDER BY created_at, id',
          ).all(id)
        : []
      const events = hasVNext
        ? db.prepare(
            'SELECT * FROM run_events WHERE session_id=? ORDER BY id',
          ).all(id)
        : []
      let finalEvidence = null
      if (full.versions.length > 0 && full.session.direction) {
        try {
          const snapshot = JSON.parse(
            full.session.config_snapshot,
          ) as ConfigSnapshot
          const latest = full.versions[full.versions.length - 1]
          finalEvidence = checkTranslationEvidence({
            direction:
              full.session.direction === 'zh_to_en' ? 'zh_to_en' : 'en_to_zh',
            sourceText: full.session.source_text,
            translatedText: latest.text,
            constraints: snapshot.constraints,
          })
        } catch {
          finalEvidence = null
        }
      }

      return NextResponse.json(
        {
          session: toPublicSessionDto(full.session),
          results: full.results,
          stages: full.stages,
          versions: full.versions,
          messages: full.messages,
          invocations: redactSecrets(invocations),
          patches,
          runs,
          events,
          final_evidence: finalEvidence,
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
