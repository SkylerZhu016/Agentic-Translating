export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { createVNextRepositories } from '@/src/lib/db/vnext-repositories'

const metadataSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
})

function store() {
  const db = getDb()
  migrate(db)
  return createVNextRepositories(db).workflowPresets
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const repo = store()
  const preset = repo.get(id)
  if (!preset) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({
    preset,
    revisions: repo.listRevisions(id),
  })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const parsed = metadataSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'validation_failed' }, { status: 400 })
  }
  const repo = store()
  if (!repo.get(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  repo.updateMeta(id, parsed.data.name, parsed.data.description)
  return NextResponse.json(repo.get(id))
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const repo = store()
  if (!repo.get(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  repo.softDelete(id)
  return new NextResponse(null, { status: 204 })
}
