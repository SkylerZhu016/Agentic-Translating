export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { createRepositories, type SessionRow } from '@/src/lib/db/repositories'
import { endpointUpdateSchema } from '@/src/lib/contracts/schemas'

function ensureDb() {
  const db = getDb()
  migrate(db)
  return { db, repos: createRepositories(db) }
}

function findEndpointReferences(
  endpointId: number,
  sessions: SessionRow[],
): string[] {
  const refs: string[] = []
  for (const s of sessions) {
    try {
      const snap = JSON.parse(s.config_snapshot)
      if (snap.endpoint && snap.endpoint.id === endpointId) {
        refs.push(s.id)
      }
    } catch {
      // skip malformed snapshots
    }
  }
  return refs
}

// PUT /api/endpoints/[id] — update
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: idStr } = await params
    const id = Number(idStr)
    if (!Number.isFinite(id) || id < 1) {
      return NextResponse.json({ error: 'Invalid endpoint id' }, { status: 400 })
    }

    const body = await req.json().catch(() => null)
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

    const parsed = endpointUpdateSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 },
      )
    }

    const { repos } = ensureDb()
    const existing = repos.endpoints.getById(id)
    if (!existing) {
      return NextResponse.json({ error: 'Endpoint not found' }, { status: 404 })
    }

    repos.endpoints.update({
      id,
      name: parsed.data.name ?? existing.name,
      base_url: parsed.data.base_url ?? existing.base_url,
      api_key: parsed.data.api_key ?? existing.api_key,
    })

    const updated = repos.endpoints.getById(id)
    return NextResponse.json(updated)
  } catch (e) {
    return NextResponse.json({ error: 'Failed to update endpoint' }, { status: 500 })
  }
}

// DELETE /api/endpoints/[id] — delete with usedBySessions
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: idStr } = await params
    const id = Number(idStr)
    if (!Number.isFinite(id) || id < 1) {
      return NextResponse.json({ error: 'Invalid endpoint id' }, { status: 400 })
    }

    const { repos } = ensureDb()
    const existing = repos.endpoints.getById(id)
    if (!existing) {
      return NextResponse.json({ error: 'Endpoint not found' }, { status: 404 })
    }

    // Check session snapshot references
    const allSessions = repos.sessions.list()
    const usedBySessions = findEndpointReferences(id, allSessions)

    if (usedBySessions.length > 0) {
      // Return conflict with references so UI can warn user
      return NextResponse.json(
        {
          error: 'Endpoint is referenced by sessions',
          usedBySessions,
        },
        { status: 409 },
      )
    }

    repos.endpoints.delete(id)
    return NextResponse.json({ success: true })
  } catch (e) {
    return NextResponse.json({ error: 'Failed to delete endpoint' }, { status: 500 })
  }
}
