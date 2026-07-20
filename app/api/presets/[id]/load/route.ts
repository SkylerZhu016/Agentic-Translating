export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { createRepositories } from '@/src/lib/db/repositories'
import { z } from 'zod'

function ensureDb() {
  const db = getDb()
  migrate(db)
  return { db, repos: createRepositories(db) }
}

const presetLoadSchema = z.object({
  force: z.boolean().optional(),
})

// POST /api/presets/[id]/load — load preset into global config
//   1. Validate endpoint references against current endpoints
//   2. If orphans and !force: return { applied: false, warnings }
//   3. If no orphans: apply with empty orphan list
//   4. If force: apply, skipping agents/coords that reference orphaned endpoints
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: idStr } = await params
    const id = Number(idStr)
    if (!Number.isFinite(id) || id < 1) {
      return NextResponse.json({ error: 'Invalid preset id' }, { status: 400 })
    }

    const body = await req.json().catch(() => ({}))
    const parsed = presetLoadSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 },
      )
    }

    const { repos } = ensureDb()

    const existing = repos.presets.getById(id)
    if (!existing) {
      return NextResponse.json({ error: 'Preset not found' }, { status: 404 })
    }

    const endpoints = repos.endpoints.list()
    const { valid, orphanEndpointRefs } = repos.presets.loadWithValidation(id, endpoints)

    // Orphans without force: do not apply, return warnings
    if (!valid && !parsed.data.force) {
      return NextResponse.json({
        applied: false,
        warnings: orphanEndpointRefs,
      })
    }

    // No orphans: apply cleanly
    if (valid) {
      repos.presets.applyToGlobalConfig(id, [])
      return NextResponse.json({
        applied: true,
        warnings: [],
      })
    }

    // force=true with orphans: apply, skipping orphaned endpoint references
    const orphanIds = Array.from(new Set(orphanEndpointRefs.map((r) => r.endpointId)))
    repos.presets.applyToGlobalConfig(id, orphanIds)
    return NextResponse.json({
      applied: true,
      warnings: orphanEndpointRefs,
    })
  } catch (e) {
    return NextResponse.json({ error: 'Failed to load preset' }, { status: 500 })
  }
}
