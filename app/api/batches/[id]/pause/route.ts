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
  db.prepare(`
    UPDATE batch_jobs SET status='paused', updated_at=datetime('now')
    WHERE id=? AND status='running'
  `).run(id)
  return Response.json({ ok: true })
}
