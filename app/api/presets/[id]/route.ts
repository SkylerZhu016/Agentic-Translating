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

const presetUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  agents: z
    .array(
      z.object({
        name: z.string().min(1),
        endpoint_id: z.number().int().positive().nullable(),
        model: z.string().min(1),
        prompt_override: z.string().nullable(),
        sort_order: z.number().int(),
      }),
    )
    .optional(),
  coordinator: z
    .object({
      endpoint_id: z.number().int().positive().nullable(),
      model: z.string().min(1),
      chat_endpoint_id: z.number().int().positive().nullable(),
      chat_model: z.string().min(1),
    })
    .nullable()
    .optional(),
  prompts: z
    .array(
      z.object({
        kind: z.enum(['translator', 'review', 'filter', 'orchestrate', 'assemble']),
        name: z.string().min(1),
        content: z.string(),
      }),
    )
    .optional(),
})

// GET /api/presets/[id] — get full preset with children
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: idStr } = await params
    const id = Number(idStr)
    if (!Number.isFinite(id) || id < 1) {
      return NextResponse.json({ error: 'Invalid preset id' }, { status: 400 })
    }

    const { repos } = ensureDb()
    const full = repos.presets.getFull(id)
    if (!full) {
      return NextResponse.json({ error: 'Preset not found' }, { status: 404 })
    }
    return NextResponse.json(full)
  } catch (e) {
    return NextResponse.json({ error: 'Failed to get preset' }, { status: 500 })
  }
}

// PUT /api/presets/[id] — update preset meta and/or content
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: idStr } = await params
    const id = Number(idStr)
    if (!Number.isFinite(id) || id < 1) {
      return NextResponse.json({ error: 'Invalid preset id' }, { status: 400 })
    }

    const body = await req.json().catch(() => null)
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

    const parsed = presetUpdateSchema.safeParse(body)
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

    // Update meta if name or description provided
    if (parsed.data.name !== undefined || parsed.data.description !== undefined) {
      const newName = parsed.data.name ?? existing.name
      const newDesc =
        (parsed.data.description !== undefined
          ? parsed.data.description
          : existing.description) ?? undefined
      try {
        repos.presets.updateMeta(id, newName, newDesc)
      } catch (e) {
        // UNIQUE constraint on name
        return NextResponse.json({ error: 'Preset name already exists' }, { status: 409 })
      }
    }

    // Replace content if any content field provided
    const hasContent =
      parsed.data.agents !== undefined ||
      parsed.data.coordinator !== undefined ||
      parsed.data.prompts !== undefined
    if (hasContent) {
      repos.presets.saveContent(
        id,
        parsed.data.agents ?? [],
        parsed.data.coordinator ?? null,
        parsed.data.prompts ?? [],
      )
    }

    const updated = repos.presets.getFull(id)
    return NextResponse.json(updated)
  } catch (e) {
    return NextResponse.json({ error: 'Failed to update preset' }, { status: 500 })
  }
}

// DELETE /api/presets/[id] — delete (400 if builtin)
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: idStr } = await params
    const id = Number(idStr)
    if (!Number.isFinite(id) || id < 1) {
      return NextResponse.json({ error: 'Invalid preset id' }, { status: 400 })
    }

    const { repos } = ensureDb()
    const existing = repos.presets.getById(id)
    if (!existing) {
      return NextResponse.json({ error: 'Preset not found' }, { status: 404 })
    }

    if (existing.is_builtin === 1) {
      return NextResponse.json(
        { error: 'Cannot delete builtin preset' },
        { status: 400 },
      )
    }

    repos.presets.delete(id)
    return NextResponse.json({ success: true })
  } catch (e) {
    return NextResponse.json({ error: 'Failed to delete preset' }, { status: 500 })
  }
}
