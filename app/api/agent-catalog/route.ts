export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { seed } from '@/src/lib/db/seed'
import { createVNextRepositories } from '@/src/lib/db/vnext-repositories'

const querySchema = z.object({
  direction: z.enum(['en_to_zh', 'zh_to_en']).default('en_to_zh'),
  includeDisabled: z.enum(['0', '1']).default('0'),
})

const variantInputSchema = z.object({
  direction: z.enum(['en_to_zh', 'zh_to_en', 'custom']),
  catalogName: z.string().min(1),
  catalogDescription: z.string().min(1),
  rolePrompt: z.string().min(1),
  promptLanguage: z.enum(['zh', 'en']),
  enabled: z.boolean().default(true),
  endpointOverrideId: z.number().int().positive().nullable().default(null),
  modelOverride: z.string().min(1).nullable().default(null),
})

const createSchema = z.object({
  displayNameZh: z.string().min(1),
  category: z.enum([
    'foundation',
    'expression',
    'domain',
    'creative',
    'adversarial',
  ]),
  tags: z.array(z.string()).default([]),
  variants: z.array(variantInputSchema).min(1),
})

export async function GET(request: NextRequest) {
  const parsed = querySchema.safeParse({
    direction: request.nextUrl.searchParams.get('direction') ?? undefined,
    includeDisabled:
      request.nextUrl.searchParams.get('includeDisabled') ?? undefined,
  })
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_query' }, { status: 400 })
  }
  const db = getDb()
  migrate(db)
  seed(db)
  const repos = createVNextRepositories(db)
  const variants = repos.agents.listVariants(
    parsed.data.direction,
    parsed.data.includeDisabled === '1',
  )
  const archetypes = repos.agents.listArchetypes()
  return NextResponse.json({ direction: parsed.data.direction, archetypes, variants })
}

export async function POST(request: NextRequest) {
  const parsed = createSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_failed', details: parsed.error.flatten() },
      { status: 400 },
    )
  }
  const db = getDb()
  migrate(db)
  seed(db)
  const repos = createVNextRepositories(db)
  const archetypeId = randomUUID()
  const archetype = {
    id: archetypeId,
    slug: `custom-${archetypeId}`,
    displayNameZh: parsed.data.displayNameZh,
    category: parsed.data.category,
    tags: parsed.data.tags,
    isBuiltin: false,
  } as const
  const variants = parsed.data.variants.map((variant, index) => ({
    id: `${archetypeId}.${variant.direction}.${index + 1}`,
    archetypeId,
    ...variant,
    promptVersion: 1,
    sortOrder: 1000 + index,
  }))
  repos.agents.createCustom(archetype, variants)
  return NextResponse.json({ archetype, variants }, { status: 201 })
}
