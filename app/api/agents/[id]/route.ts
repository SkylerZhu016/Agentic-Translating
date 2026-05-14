export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { createRepositories } from '@/src/lib/db/repositories'
import { agentUpdateSchema } from '@/src/lib/contracts/schemas'

function ensureDb() {
  const db = getDb()
  migrate(db)
  return { db, repos: createRepositories(db) }
}

// PUT /api/agents/[id] — update
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: idStr } = await params
    const id = Number(idStr)
    if (!Number.isFinite(id) || id < 1) {
      return NextResponse.json({ error: 'Invalid agent id' }, { status: 400 })
    }

    const body = await req.json().catch(() => null)
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

    const parsed = agentUpdateSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 },
      )
    }

    const { repos } = ensureDb()
    const existing = repos.translatorAgents.getById(id)
    if (!existing) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    // If endpoint_id is being changed, validate new endpoint exists
    if (parsed.data.endpoint_id !== undefined) {
      const endpoint = repos.endpoints.getById(parsed.data.endpoint_id)
      if (!endpoint) {
        return NextResponse.json(
          { error: `Endpoint ${parsed.data.endpoint_id} not found` },
          { status: 400 },
        )
      }
    }

    // If model is being changed, validate non-empty (enforced by schema min(1))

    repos.translatorAgents.update({
      id,
      name: parsed.data.name ?? existing.name,
      endpoint_id: parsed.data.endpoint_id ?? existing.endpoint_id,
      model: parsed.data.model ?? existing.model,
      prompt_override: parsed.data.prompt_override !== undefined ? parsed.data.prompt_override : existing.prompt_override,
      sort_order: parsed.data.sort_order ?? existing.sort_order,
    })

    const updated = repos.translatorAgents.getById(id)
    return NextResponse.json(updated)
  } catch (e) {
    return NextResponse.json({ error: 'Failed to update agent' }, { status: 500 })
  }
}

// DELETE /api/agents/[id] — delete
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: idStr } = await params
    const id = Number(idStr)
    if (!Number.isFinite(id) || id < 1) {
      return NextResponse.json({ error: 'Invalid agent id' }, { status: 400 })
    }

    const { repos } = ensureDb()
    const existing = repos.translatorAgents.getById(id)
    if (!existing) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    repos.translatorAgents.delete(id)
    return NextResponse.json({ success: true })
  } catch (e) {
    return NextResponse.json({ error: 'Failed to delete agent' }, { status: 500 })
  }
}
