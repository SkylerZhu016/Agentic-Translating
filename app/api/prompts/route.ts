export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { createRepositories } from '@/src/lib/db/repositories'
import { promptCreateSchema } from '@/src/lib/contracts/schemas'
import type { PromptTemplateRow } from '@/src/lib/db/repositories'

function ensureDb() {
  const db = getDb()
  migrate(db)
  return { db, repos: createRepositories(db) }
}

// GET /api/prompts[?kind=translator] — list by optional kind filter
export async function GET(req: NextRequest) {
  try {
    const { repos } = ensureDb()
    const kind = req.nextUrl.searchParams.get('kind') as PromptTemplateRow['kind'] | null

    const list = kind
      ? repos.promptTemplates.listByKind(kind as PromptTemplateRow['kind'])
      : repos.promptTemplates.list()

    return NextResponse.json(list)
  } catch (e) {
    return NextResponse.json({ error: 'Failed to list prompts' }, { status: 500 })
  }
}

// POST /api/prompts — create new prompt template
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null)
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

    const parsed = promptCreateSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 },
      )
    }

    const { repos } = ensureDb()
    const result = repos.promptTemplates.insert({
      kind: parsed.data.kind,
      name: parsed.data.name,
      content: parsed.data.content,
      is_builtin: 0,
    })
    const created = repos.promptTemplates.getById(result.lastInsertRowid as number)
    return NextResponse.json(created, { status: 201 })
  } catch (e) {
    return NextResponse.json({ error: 'Failed to create prompt' }, { status: 500 })
  }
}
