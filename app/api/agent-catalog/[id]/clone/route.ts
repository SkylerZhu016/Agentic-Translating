export const runtime = 'nodejs'

import { randomUUID } from 'crypto'
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
  const repos = createVNextRepositories(db)
  const source = repos.agents.getVariant(id)
  if (!source) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const archetypeId = randomUUID()
  const archetype = {
    id: archetypeId,
    slug: `custom-${archetypeId}`,
    displayNameZh: `${source.catalogName}副本`,
    category: 'expression' as const,
    tags: ['复制'],
    isBuiltin: false,
  }
  const variant = {
    ...source,
    id: `${archetypeId}.${source.direction}.1`,
    archetypeId,
    catalogName: `${source.catalogName}副本`,
    promptVersion: 1,
    sortOrder: 1000,
  }
  repos.agents.createCustom(archetype, [variant])
  return NextResponse.json({ archetype, variants: [variant] }, { status: 201 })
}
