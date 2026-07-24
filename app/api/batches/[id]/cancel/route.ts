export const runtime = 'nodejs'

import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const db = getDb()
  migrate(db)
  db.transaction(() => {
    db.prepare(`
      UPDATE batch_jobs SET status='cancelled', updated_at=datetime('now')
      WHERE id=? AND status NOT IN ('completed','cancelled')
    `).run(id)
    db.prepare(`
      UPDATE batch_items SET status='cancelled', updated_at=datetime('now')
      WHERE batch_id=? AND status='queued'
    `).run(id)
  })()
  return Response.json({ ok: true })
}
