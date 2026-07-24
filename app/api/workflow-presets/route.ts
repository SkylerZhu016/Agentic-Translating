export const runtime = 'nodejs'

import { randomUUID } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { seed } from '@/src/lib/db/seed'
import { createVNextRepositories } from '@/src/lib/db/vnext-repositories'
import { workflowPresetCreateSchema } from '@/src/lib/contracts/vnext-schemas'

const querySchema = z.object({
  direction: z.enum(['en_to_zh', 'zh_to_en', 'custom']).optional(),
  includeDeleted: z.enum(['0', '1']).default('0'),
})

function repos() {
  const db = getDb()
  migrate(db)
  seed(db)
  return createVNextRepositories(db)
}

export async function GET(request: NextRequest) {
  const parsed = querySchema.safeParse({
    direction: request.nextUrl.searchParams.get('direction') ?? undefined,
    includeDeleted:
      request.nextUrl.searchParams.get('includeDeleted') ?? undefined,
  })
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_query' }, { status: 400 })
  }
  return NextResponse.json(
    repos().workflowPresets.list(
      parsed.data.direction,
      parsed.data.includeDeleted === '1',
    ),
  )
}

export async function POST(request: NextRequest) {
  const parsed = workflowPresetCreateSchema.safeParse(
    await request.json().catch(() => null),
  )
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_failed', details: parsed.error.flatten() },
      { status: 400 },
    )
  }
  const presetId = randomUUID()
  const revisionId = randomUUID()
  const store = repos().workflowPresets
  try {
    store.create(
      {
        id: presetId,
        name: parsed.data.name,
        description: parsed.data.description,
        direction: parsed.data.direction,
      },
      {
        id: revisionId,
        presetId,
        revisionNo: 1,
        contract: parsed.data.contract,
        createdAt: '',
      },
    )
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'preset_create_failed' },
      { status: 409 },
    )
  }
  return NextResponse.json(
    {
      preset: store.get(presetId),
      revision: store.getRevision(revisionId),
    },
    { status: 201 },
  )
}
