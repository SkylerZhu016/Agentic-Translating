export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { createRepositories } from '@/src/lib/db/repositories'
import { agentCreateSchema } from '@/src/lib/contracts/schemas'

function ensureDb() {
  const db = getDb()
  migrate(db)
  return { db, repos: createRepositories(db) }
}

// GET /api/agents — list all
export async function GET(_req: NextRequest) {
  try {
    const { repos } = ensureDb()
    const list = repos.translatorAgents.list()
    return NextResponse.json(list)
  } catch (e) {
    return NextResponse.json({ error: 'Failed to list agents' }, { status: 500 })
  }
}

// POST /api/agents — create
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null)
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

    const parsed = agentCreateSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 },
      )
    }

    const { repos } = ensureDb()

    // Validate endpoint_id exists
    const endpoint = repos.endpoints.getById(parsed.data.endpoint_id)
    if (!endpoint) {
      return NextResponse.json(
        { error: `Endpoint ${parsed.data.endpoint_id} not found` },
        { status: 400 },
      )
    }

    // Model non-empty already enforced by schema (min(1))

    const result = repos.translatorAgents.insert({
      name: parsed.data.name,
      endpoint_id: parsed.data.endpoint_id,
      model: parsed.data.model,
      prompt_override: parsed.data.prompt_override ?? null,
      sort_order: parsed.data.sort_order ?? 0,
    })
    const created = repos.translatorAgents.getById(result.lastInsertRowid as number)
    return NextResponse.json(created, { status: 201 })
  } catch (e) {
    return NextResponse.json({ error: 'Failed to create agent' }, { status: 500 })
  }
}
