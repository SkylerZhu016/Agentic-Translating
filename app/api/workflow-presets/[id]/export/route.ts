export const runtime = 'nodejs'

import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { createVNextRepositories } from '@/src/lib/db/vnext-repositories'
import { redactSecrets } from '@/src/lib/security/public-dto'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const db = getDb()
  migrate(db)
  const repo = createVNextRepositories(db).workflowPresets
  const preset = repo.get(id)
  if (!preset) return Response.json({ error: 'not_found' }, { status: 404 })
  const payload = redactSecrets({
    format: 'agentic-translating-workflow-preset',
    version: 1,
    preset,
    revisions: repo.listRevisions(id),
  })
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="workflow-preset-${id}.json"`,
    },
  })
}
