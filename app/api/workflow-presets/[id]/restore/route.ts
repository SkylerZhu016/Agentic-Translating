export const runtime = 'nodejs'

import { randomUUID } from 'crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { createVNextRepositories } from '@/src/lib/db/vnext-repositories'

const schema = z.object({ revisionNo: z.number().int().positive() })

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  const db = getDb()
  migrate(db)
  const repo = createVNextRepositories(db).workflowPresets
  const preset = repo.get(id)
  const old = repo.getRevisionByNo(id, parsed.data.revisionNo)
  if (!preset || !old) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const revision = {
    ...old,
    id: randomUUID(),
    revisionNo: preset.currentRevisionNo + 1,
    createdAt: '',
  }
  repo.addRevision(revision)
  return NextResponse.json(repo.getRevision(revision.id), { status: 201 })
}
