export const runtime = 'nodejs'

import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { redactSecrets } from '@/src/lib/security/public-dto'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const db = getDb()
  migrate(db)
  const batch = db.prepare('SELECT * FROM batch_jobs WHERE id=?').get(id)
  if (!batch) return Response.json({ error: 'not_found' }, { status: 404 })
  const items = db.prepare(
    'SELECT * FROM batch_items WHERE batch_id=? ORDER BY relative_path',
  ).all(id)
  return Response.json(redactSecrets({ batch, items }))
}
