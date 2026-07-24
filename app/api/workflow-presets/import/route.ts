export const runtime = 'nodejs'

import { randomUUID } from 'crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { createVNextRepositories } from '@/src/lib/db/vnext-repositories'
import { workflowPresetContractSchema } from '@/src/lib/contracts/vnext-schemas'

const importSchema = z.object({
  preset: z.object({
    name: z.string().min(1),
    description: z.string(),
    direction: z.enum(['en_to_zh', 'zh_to_en', 'custom']),
  }),
  revisions: z.array(z.object({
    revisionNo: z.number().int().positive(),
    contract: workflowPresetContractSchema,
  })).min(1),
})

export async function POST(request: Request) {
  const parsed = importSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_failed', details: parsed.error.flatten() },
      { status: 400 },
    )
  }
  const latest = [...parsed.data.revisions].sort(
    (a, b) => b.revisionNo - a.revisionNo,
  )[0]
  const db = getDb()
  migrate(db)
  const repo = createVNextRepositories(db).workflowPresets
  const presetId = randomUUID()
  const revisionId = randomUUID()
  try {
    repo.create(
      {
        id: presetId,
        name: `${parsed.data.preset.name}（导入）`,
        description: parsed.data.preset.description,
        direction: parsed.data.preset.direction,
      },
      {
        id: revisionId,
        presetId,
        revisionNo: 1,
        contract: latest.contract,
        createdAt: '',
      },
    )
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'import_failed' },
      { status: 409 },
    )
  }
  return NextResponse.json({ preset: repo.get(presetId) }, { status: 201 })
}
