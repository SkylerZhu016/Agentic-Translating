export const runtime = 'nodejs'

import { randomUUID } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { createVNextRepositories } from '@/src/lib/db/vnext-repositories'
import {
  validatePresetContractDirection,
  workflowPresetContractSchema,
} from '@/src/lib/contracts/vnext-schemas'

function store() {
  const db = getDb()
  migrate(db)
  return createVNextRepositories(db).workflowPresets
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return NextResponse.json(store().listRevisions((await params).id))
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const parsed = workflowPresetContractSchema.safeParse(
    await request.json().catch(() => null),
  )
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_failed', details: parsed.error.flatten() },
      { status: 400 },
    )
  }
  const repo = store()
  const preset = repo.get(id)
  if (!preset) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const directionError = validatePresetContractDirection(
    preset.direction,
    parsed.data,
  )
  if (directionError) {
    return NextResponse.json(
      { error: 'direction_mismatch', message: directionError },
      { status: 400 },
    )
  }
  const revision = {
    id: randomUUID(),
    presetId: id,
    revisionNo: preset.currentRevisionNo + 1,
    contract: parsed.data,
    createdAt: '',
  }
  repo.addRevision(revision)
  return NextResponse.json(repo.getRevision(revision.id), { status: 201 })
}
