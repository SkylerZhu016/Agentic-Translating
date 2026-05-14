export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { createRepositories } from '@/src/lib/db/repositories'
import { promptUpdateSchema } from '@/src/lib/contracts/schemas'

function ensureDb() {
  const db = getDb()
  migrate(db)
  return { db, repos: createRepositories(db) }
}

// PUT /api/prompts/[id] — update; if is_builtin, create copy with is_builtin=0
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: idStr } = await params
    const id = Number(idStr)
    if (!Number.isFinite(id) || id < 1) {
      return NextResponse.json({ error: 'Invalid prompt id' }, { status: 400 })
    }

    const body = await req.json().catch(() => null)
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

    const parsed = promptUpdateSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 },
      )
    }

    const { repos } = ensureDb()
    const existing = repos.promptTemplates.getById(id)
    if (!existing) {
      return NextResponse.json({ error: 'Prompt not found' }, { status: 404 })
    }

    // If builtin, create a copy row with is_builtin=0 instead of modifying the original
    if (existing.is_builtin === 1) {
      const newName = parsed.data.name ?? existing.name
      const newContent = parsed.data.content ?? existing.content

      const result = repos.promptTemplates.insert({
        kind: existing.kind,
        name: newName,
        content: newContent,
        is_builtin: 0,
      })
      const created = repos.promptTemplates.getById(result.lastInsertRowid as number)
      return NextResponse.json(created, { status: 201 })
    }

    // Non-builtin: update in place
    repos.promptTemplates.update({
      id,
      kind: existing.kind,
      name: parsed.data.name ?? existing.name,
      content: parsed.data.content ?? existing.content,
      is_builtin: existing.is_builtin,
    })

    const updated = repos.promptTemplates.getById(id)
    return NextResponse.json(updated)
  } catch (e) {
    return NextResponse.json({ error: 'Failed to update prompt' }, { status: 500 })
  }
}
