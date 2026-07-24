export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { createVNextRepositories } from '@/src/lib/db/vnext-repositories'
import { createBatch } from '@/src/lib/batch/runner'

const createSchema = z.object({
  name: z.string().min(1),
  presetRevisionId: z.string().min(1),
  concurrency: z.number().int().min(1).max(4).default(2),
  files: z.array(z.object({
    relativePath: z.string().min(1),
    sourceText: z.string(),
    originalLineEnding: z.enum(['lf', 'crlf']),
    hadBom: z.boolean(),
  })).min(1).max(500),
})

export async function GET() {
  const db = getDb()
  migrate(db)
  return NextResponse.json(
    db.prepare('SELECT * FROM batch_jobs ORDER BY updated_at DESC').all(),
  )
}

export async function POST(request: Request) {
  const parsed = createSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_failed', details: parsed.error.flatten() },
      { status: 400 },
    )
  }
  const db = getDb()
  migrate(db)
  const revision = createVNextRepositories(db).workflowPresets.getRevision(
    parsed.data.presetRevisionId,
  )
  if (!revision) {
    return NextResponse.json({ error: 'preset_revision_not_found' }, { status: 404 })
  }
  const preset = createVNextRepositories(db).workflowPresets.get(revision.presetId)
  if (!preset || (preset.direction !== 'en_to_zh' && preset.direction !== 'zh_to_en')) {
    return NextResponse.json({ error: 'invalid_preset_direction' }, { status: 400 })
  }
  try {
    const id = createBatch(db, {
      ...parsed.data,
      direction: preset.direction,
      presetSnapshot: revision.contract,
    })
    return NextResponse.json({ id }, { status: 201 })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'batch_create_failed' },
      { status: 400 },
    )
  }
}
