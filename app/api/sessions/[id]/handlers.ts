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
      const invocationRows = invocations as Array<{
        id: string
        replaces_invocation_id?: string | null
        created_at: string
      }>
      const byId = new Map(invocationRows.map((row) => [row.id, row]))
      const rootOf = (row: typeof invocationRows[number]) => {
        let current = row
        const visited = new Set<string>()
        while (current.replaces_invocation_id && !visited.has(current.id)) {
          visited.add(current.id)
          const parent = byId.get(current.replaces_invocation_id)
          if (!parent) break
          current = parent
        }
        return current.id
      }
      const chainMap = new Map<string, typeof invocationRows>()
      for (const row of invocationRows) {
        const root = rootOf(row)
        chainMap.set(root, [...(chainMap.get(root) ?? []), row])
      }
      const invocationChains = [...chainMap.entries()].map(
        ([rootInvocationId, attempts]) => ({
          rootInvocationId,
          currentInvocation: attempts[attempts.length - 1],
          attempts,
          attemptCount: attempts.length,
        }),
      )
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
      const hasRunControls = Boolean(
        db.prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_run_controls'",
        ).get(),
      )
      const runControl = hasRunControls
        ? db.prepare(`
            SELECT pause_requested, candidates_stale, updated_at
            FROM session_run_controls WHERE session_id=?
          `).get(id) ?? {
            pause_requested: 0,
            candidates_stale: 0,
            updated_at: null,
          }
        : {
            pause_requested: 0,
            candidates_stale: 0,
            updated_at: null,
          }
      const events = hasVNext
        ? db.prepare(
            'SELECT * FROM run_events WHERE session_id=? ORDER BY id',
          ).all(id)
        : []
      const finalVersion =
        full.session.final_version_id == null
          ? null
          : full.versions.find(
              (version) => version.id === full.session.final_version_id,
            ) ?? null
      let finalEvidence = null
      if (finalVersion && full.session.direction) {
        try {
          const snapshot = JSON.parse(
            full.session.config_snapshot,
          ) as ConfigSnapshot
          finalEvidence = checkTranslationEvidence({
            direction:
              full.session.direction === 'zh_to_en' ? 'zh_to_en' : 'en_to_zh',
            sourceText: full.session.source_text,
            translatedText: finalVersion.text,
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
          finalVersion,
          messages: full.messages,
          invocations: redactSecrets(invocations),
          invocationChains: redactSecrets(invocationChains),
          patches,
          runs,
          runControl,
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
