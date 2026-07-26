export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { createRepositories } from '@/src/lib/db/repositories'
import { endpointCreateSchema } from '@/src/lib/contracts/schemas'
import { toPublicEndpointDto } from '@/src/lib/security/public-dto'

function ensureDb() {
  const db = getDb()
  migrate(db)
  return { db, repos: createRepositories(db) }
}

// GET /api/endpoints — list all
export async function GET(_req: NextRequest) {
  try {
    const { repos } = ensureDb()
    const list = repos.endpoints.list()
    return NextResponse.json(list.map(toPublicEndpointDto))
  } catch (e) {
    return NextResponse.json({ error: 'Failed to list endpoints' }, { status: 500 })
  }
}

// POST /api/endpoints — create
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null)
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

    const parsed = endpointCreateSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 },
      )
    }

    const { repos } = ensureDb()
    const result = repos.endpoints.insert({
      name: parsed.data.name,
      base_url: parsed.data.base_url,
      chat_completions_path: parsed.data.chat_completions_path,
      api_key: parsed.data.api_key,
      context_window: parsed.data.context_window ?? null,
    })
    const created = repos.endpoints.getById(result.lastInsertRowid as number)
    return NextResponse.json(created ? toPublicEndpointDto(created) : null, { status: 201 })
  } catch (e) {
    return NextResponse.json({ error: 'Failed to create endpoint' }, { status: 500 })
  }
}
