export const runtime = 'nodejs'

import { createHash, randomUUID } from 'crypto'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { buildDiffSpans } from '@/src/lib/editing/diff-spans'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; patchId: string }> },
) {
  const { id, patchId } = await params
  const db = getDb()
  migrate(db)
  const patch = db.prepare(`
    SELECT * FROM text_patches WHERE id=? AND session_id=?
  `).get(patchId, id) as {
    result_version_id: number
    base_version_id: number
  } | undefined
  if (!patch) return Response.json({ error: 'patch_not_found' }, { status: 404 })
  const latest = db.prepare(`
    SELECT * FROM final_versions
    WHERE session_id=? ORDER BY version_no DESC LIMIT 1
  `).get(id) as { id: number; version_no: number; text: string } | undefined
  if (!latest || latest.id !== patch.result_version_id) {
    return Response.json(
      { error: 'version_conflict', message: '只能直接撤销当前版本的最后一项修改' },
      { status: 409 },
    )
  }
  const base = db.prepare(
    'SELECT * FROM final_versions WHERE id=? AND session_id=?',
  ).get(patch.base_version_id, id) as { text: string } | undefined
  if (!base) return Response.json({ error: 'base_version_not_found' }, { status: 404 })

  const reversePatchId = randomUUID()
  const nextVersionNo = latest.version_no + 1
  const hash = createHash('sha256').update(base.text).digest('hex')
  const created = db.transaction(() => {
    const version = db.prepare(`
      INSERT INTO final_versions
        (session_id, version_no, text, source, parent_version_id,
         content_hash, created_by_patch_id)
      VALUES (?, ?, ?, 'restore', ?, ?, ?)
    `).run(
      id,
      nextVersionNo,
      base.text,
      latest.id,
      hash,
      reversePatchId,
    )
    const versionId = Number(version.lastInsertRowid)
    db.prepare(`
      INSERT INTO text_patches
        (id, session_id, base_version_id, result_version_id, old_text,
         new_text, reason, evidence_refs_json, diff_spans_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?)
    `).run(
      reversePatchId,
      id,
      latest.id,
      versionId,
      latest.text,
      base.text,
      `撤销修改 ${patchId}`,
      JSON.stringify(buildDiffSpans(latest.text, base.text)),
    )
    db.prepare(
      "UPDATE sessions SET final_version_id=?, updated_at=datetime('now') WHERE id=?",
    ).run(versionId, id)
    return { id: versionId, version_no: nextVersionNo, text: base.text }
  })()
  return Response.json({ version: created, patchId: reversePatchId })
}
