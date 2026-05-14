// ---------------------------------------------------------------------------
// Version Restore API — POST /api/sessions/:id/versions/:versionNo/restore
// Creates a new version (source='restore') by cloning an existing one,
// then records a system chat message.
// ---------------------------------------------------------------------------
import { NextRequest, NextResponse } from 'next/server'
import Database from 'better-sqlite3'
import { getDb } from '@/src/lib/db'
import { createRepositories } from '@/src/lib/db/repositories'

export const runtime = 'nodejs'

// ── Factory (injectable for tests) ────────────────────────────────

export function createHandlers(db: Database.Database) {
  const repos = createRepositories(db)

  return {
    // ────────────────────────────────────────────────────────────
    // POST /api/sessions/:id/versions/:versionNo/restore
    // ────────────────────────────────────────────────────────────
    async POST(
      _request: NextRequest,
      { params }: { params: Promise<{ id: string; versionNo: string }> },
    ) {
      const { id, versionNo: versionNoStr } = await params
      const versionNo = parseInt(versionNoStr, 10)

      if (isNaN(versionNo)) {
        return NextResponse.json(
          { error: 'invalid_version_no', message: 'versionNo must be a number' },
          { status: 400 },
        )
      }

      // 1. Look up the version to restore
      const sourceVersion = repos.finalVersions.getBySessionAndVersion(id, versionNo)
      if (!sourceVersion) {
        return NextResponse.json(
          { error: 'version_not_found', message: `Version ${versionNo} not found for session ${id}` },
          { status: 404 },
        )
      }

      // 2. Determine next version_no
      const latest = repos.finalVersions.getLatestBySession(id)
      const nextVersionNo = latest ? latest.version_no + 1 : 1

      // 3. Transaction: insert restored version + system chat message
      const txn = db.transaction(() => {
        repos.finalVersions.insert({
          session_id: id,
          version_no: nextVersionNo,
          text: sourceVersion.text,
          source: 'restore',
        })

        repos.chatMessages.insert({
          session_id: id,
          role: 'tool',
          content: `已恢复到版本 ${versionNo}`,
          tool_calls: null,
          tool_results: null,
          version_id: null,
        })
      })
      txn()

      // 4. Return the newly created version
      const newVersion = repos.finalVersions.getBySessionAndVersion(id, nextVersionNo)!
      return NextResponse.json(newVersion, { status: 200 })
    },
  }
}

// ── Production export (lazy singleton) ────────────────────────────
let _handlers: ReturnType<typeof createHandlers> | null = null
function prod(): ReturnType<typeof createHandlers> {
  if (!_handlers) _handlers = createHandlers(getDb())
  return _handlers
}

export const POST = (
  req: NextRequest,
  ctx: { params: Promise<{ id: string; versionNo: string }> },
) => prod().POST(req, ctx)
