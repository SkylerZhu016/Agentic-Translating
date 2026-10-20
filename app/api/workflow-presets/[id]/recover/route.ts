export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { createVNextRepositories } from '@/src/lib/db/vnext-repositories'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const db = getDb()
  migrate(db)
  const repo = createVNextRepositories(db).workflowPresets
  const preset = repo.get(id)
  if (!preset) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  // Recovery restores visibility only. Repeating the request must preserve
  // metadata timestamps and every frozen revision.
  if (preset.deletedAt === null) return NextResponse.json(preset)
  repo.restore(id)
  return NextResponse.json(repo.get(id))
}
