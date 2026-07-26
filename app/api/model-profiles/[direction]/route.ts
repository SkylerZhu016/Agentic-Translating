export const runtime = 'nodejs'

import { z } from 'zod'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { modelBindingSchema } from '@/src/lib/contracts/vnext-schemas'
import { createWorkspaceModelProfilesRepo } from '@/src/lib/db/release-config-repositories'

const directionSchema = z.enum(['en_to_zh', 'zh_to_en', 'custom'])
const putSchema = z.object({
  defaultWorker: modelBindingSchema,
  mainAgent: modelBindingSchema,
  editingAgent: modelBindingSchema,
})

function repo() {
  const db = getDb()
  migrate(db)
  return createWorkspaceModelProfilesRepo(db)
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ direction: string }> },
) {
  const direction = directionSchema.safeParse((await params).direction)
  if (!direction.success) return Response.json({ error: 'invalid_direction' }, { status: 400 })
  return Response.json(repo().get(direction.data))
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ direction: string }> },
) {
  const direction = directionSchema.safeParse((await params).direction)
  const body = putSchema.safeParse(await request.json().catch(() => null))
  if (!direction.success || !body.success) {
    return Response.json({ error: 'invalid_body' }, { status: 400 })
  }
  return Response.json(repo().upsert({ direction: direction.data, ...body.data }))
}
