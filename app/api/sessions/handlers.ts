// ---------------------------------------------------------------------------
// Sessions handlers — factory extracted from route.ts (Next 15.5 route modules
// may only export HTTP verbs + route config; tests import this factory)
// ---------------------------------------------------------------------------
import { NextRequest, NextResponse } from 'next/server'
import Database from 'better-sqlite3'
import { createRepositories } from '@/src/lib/db/repositories'
import {
  createSessionService,
  InvalidCustomDirectionError,
  NoAgentsConfiguredError,
} from '@/src/lib/services/session-service'
import {
  SourceRequiredError,
} from '@/src/lib/guards'
import { sessionCreateSchema } from '@/src/lib/contracts/schemas'
import { toPublicSessionDto } from '@/src/lib/security/public-dto'
import { createVNextRepositories } from '@/src/lib/db/vnext-repositories'

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

      const parsed = sessionCreateSchema.safeParse(body)
      if (!parsed.success) {
        return NextResponse.json(
          { error: 'validation_failed', details: parsed.error.flatten() },
          { status: 400 },
        )
      }
      const direction = parsed.data.direction

      const input = {
        ...parsed.data,
        sourceLang:
          direction === 'custom'
            ? parsed.data.sourceLang!
            : parsed.data.sourceLang ??
              (direction === 'en_to_zh' ? '英文' : '中文'),
        targetLang:
          direction === 'custom'
            ? parsed.data.targetLang!
            : parsed.data.targetLang ??
              (direction === 'en_to_zh' ? '中文' : '英文'),
      }

      try {
        const session = service.createSession(input)
        try {
          if (direction !== 'custom') {
            createVNextRepositories(db).workspaceDrafts.clear(direction)
          }
        } catch {
          // Legacy test databases do not contain vNext draft tables.
        }
        return NextResponse.json(toPublicSessionDto(session), { status: 200 })
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
        if (err instanceof InvalidCustomDirectionError) {
          return NextResponse.json(
            { error: err.code, message: err.message },
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

      const direction = searchParams.get('direction')
      const all = service.listSessions({ limit: Number.MAX_SAFE_INTEGER, offset: 0 })
      const filtered =
        direction === 'en_to_zh' ||
        direction === 'zh_to_en' ||
        direction === 'custom'
          ? all.filter((session) => (session.direction ?? 'en_to_zh') === direction)
          : all
      const sessions = filtered.slice(offset, offset + limit)
      const hasInvocations = Boolean(
        db.prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_invocations'",
        ).get(),
      )
      return NextResponse.json(
        {
          sessions: sessions.map((session) => {
            const actual = hasInvocations
              ? db.prepare(`
                  SELECT COUNT(*) AS count,
                    GROUP_CONCAT(DISTINCT model) AS models
                  FROM agent_invocations
                  WHERE session_id=?
                `).get(session.id) as { count: number; models: string | null }
              : { count: 0, models: null }
            const latest = db.prepare(`
              SELECT id, version_no, text, source, created_at
              FROM final_versions
              WHERE session_id=?
              ORDER BY version_no DESC
              LIMIT 1
            `).get(session.id) ?? null
            return {
              ...toPublicSessionDto(session),
              agent_invocation_count: actual.count,
              models: actual.models ? actual.models.split(',') : [],
              latest_version: latest,
            }
          }),
          total: filtered.length,
        },
        { status: 200 },
      )
    },
  }
}
