export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { seed } from '@/src/lib/db/seed'
import { createVNextRepositories } from '@/src/lib/db/vnext-repositories'
import type { BuiltinDirection } from '@/src/lib/contracts/vnext'
import { translationConstraintsSchema } from '@/src/lib/contracts/vnext-schemas'

const directionSchema = z.enum(['en_to_zh', 'zh_to_en'])
const draftSchema = z.object({
  sourceText: z.string(),
  taskBrief: z.string(),
  selectedProjectId: z.string().uuid().nullable().optional().default(null),
  selectedPresetRevisionId: z.string().min(1).nullable(),
  allowedAgentVariantIds: z.array(z.string().min(1)),
  reviewMode: z.enum(['main_editor', 'four_stage']),
  mainEditorRunMode: z
    .enum(['fixed_pipeline', 'tool_enabled'])
    .optional()
    .default('fixed_pipeline'),
  promptBundleRevisionId: z.string().min(1).nullable().optional(),
  constraints: translationConstraintsSchema.default({}),
})

function getRepos() {
  const db = getDb()
  migrate(db)
  seed(db)
  return createVNextRepositories(db)
}

function parseDirection(raw: string): BuiltinDirection | null {
  const parsed = directionSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ direction: string }> },
) {
  const direction = parseDirection((await params).direction)
  if (!direction) {
    return NextResponse.json({ error: 'invalid_direction' }, { status: 400 })
  }
  return NextResponse.json(getRepos().workspaceDrafts.get(direction))
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ direction: string }> },
) {
  const direction = parseDirection((await params).direction)
  if (!direction) {
    return NextResponse.json({ error: 'invalid_direction' }, { status: 400 })
  }
  const body = await request.json().catch(() => null)
  const parsed = draftSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_failed', details: parsed.error.flatten() },
      { status: 400 },
    )
  }
  const repos = getRepos()
  repos.workspaceDrafts.upsert({ direction, ...parsed.data })
  return NextResponse.json(repos.workspaceDrafts.get(direction))
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ direction: string }> },
) {
  const direction = parseDirection((await params).direction)
  if (!direction) {
    return NextResponse.json({ error: 'invalid_direction' }, { status: 400 })
  }
  const repos = getRepos()
  repos.workspaceDrafts.clear(direction)
  return new NextResponse(null, { status: 204 })
}
