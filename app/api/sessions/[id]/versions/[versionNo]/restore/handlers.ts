// ---------------------------------------------------------------------------
// Version Restore handlers — factory extracted from route.ts (Next 15.5 route
// modules may only export HTTP verbs + route config; tests import this)
// ---------------------------------------------------------------------------
import { NextRequest, NextResponse } from 'next/server'
import Database from 'better-sqlite3'
import { createRepositories } from '@/src/lib/db/repositories'

export function createHandlers(db: Database.Database) {
  const repos = createRepositories(db)
  const hasFinalVersionPointer = (
    db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
  ).some((column) => column.name === 'final_version_id')
  const selectRestoredVersion = hasFinalVersionPointer
    ? db.prepare(
        "UPDATE sessions SET final_version_id=?, updated_at=datetime('now') WHERE id=?",
      )
    : null

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

      // 2. Publish the restored version and its audit message atomically.
      // Modern workspaces read final_version_id, while legacy schemas read
      // the newest version directly.
      const txn = db.transaction(() => {
        const latest = repos.finalVersions.getLatestBySession(id)
        const nextVersionNo = latest ? latest.version_no + 1 : 1
        const inserted = repos.finalVersions.insert({
          session_id: id,
          version_no: nextVersionNo,
          text: sourceVersion.text,
          source: 'restore',
        })
        const restoredVersionId = Number(inserted.lastInsertRowid)
        selectRestoredVersion?.run(restoredVersionId, id)

        repos.chatMessages.insert({
          session_id: id,
          role: 'tool',
          content: `已恢复到版本 ${versionNo}`,
          tool_calls: null,
          tool_results: null,
          version_id: restoredVersionId,
        })
        return repos.finalVersions.getById(restoredVersionId)!
      })

      // 3. Return the same version now selected by detail and export consumers.
      const newVersion = txn()
      return NextResponse.json(newVersion, { status: 200 })
    },
  }
}
