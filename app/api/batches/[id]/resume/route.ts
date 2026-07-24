export const runtime = 'nodejs'

import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { startBatch } from '@/src/lib/batch/runner'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const db = getDb()
  migrate(db)
  db.prepare(`
    UPDATE batch_jobs SET status='queued', error=NULL, updated_at=datetime('now')
    WHERE id=? AND status IN ('paused','failed')
  `).run(id)
  startBatch(db, id)
  return Response.json({ ok: true })
}
