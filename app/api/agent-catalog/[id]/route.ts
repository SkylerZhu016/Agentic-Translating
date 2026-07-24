export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { createVNextRepositories } from '@/src/lib/db/vnext-repositories'

const updateSchema = z.object({
  catalogName: z.string().min(1).optional(),
  catalogDescription: z.string().min(1).optional(),
  rolePrompt: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  endpointOverrideId: z.number().int().positive().nullable().optional(),
  modelOverride: z.string().min(1).nullable().optional(),
})

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const parsed = updateSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_failed', details: parsed.error.flatten() },
      { status: 400 },
    )
  }
  const db = getDb()
  migrate(db)
  const repos = createVNextRepositories(db)
  const variant = repos.agents.getVariant(id)
  if (!variant) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const archetype = repos.agents.getArchetype(variant.archetypeId)
  if (!archetype) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (
    archetype.isBuiltin &&
    (
      parsed.data.catalogName !== undefined ||
      parsed.data.catalogDescription !== undefined ||
      parsed.data.rolePrompt !== undefined
    )
  ) {
    return NextResponse.json({ error: 'builtin_prompt_readonly' }, { status: 409 })
  }
  repos.agents.updateVariant({ ...variant, ...parsed.data })
  return NextResponse.json(repos.agents.getVariant(id))
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const db = getDb()
  migrate(db)
  const repos = createVNextRepositories(db)
  const archetype = repos.agents.getArchetype(id)
  if (!archetype) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (archetype.isBuiltin) {
    return NextResponse.json({ error: 'builtin_readonly' }, { status: 409 })
  }
  repos.agents.deleteCustom(id)
  return new NextResponse(null, { status: 204 })
}
