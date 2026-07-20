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

const presetCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  fromCurrentConfig: z.boolean().optional(),
  fromPresetId: z.number().int().positive().optional(),
})

// GET /api/presets — list all presets (header rows only, no child data)
export async function GET(_req: NextRequest) {
  try {
    const { repos } = ensureDb()
    const list = repos.presets.list()
    return NextResponse.json(list)
  } catch (e) {
    return NextResponse.json({ error: 'Failed to list presets' }, { status: 500 })
  }
}

// POST /api/presets — create a preset
//   fromPresetId: duplicate that preset
//   fromCurrentConfig=true: snapshot current global config as new preset content
//   otherwise: create empty preset
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null)
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

    const parsed = presetCreateSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 },
      )
    }

    const { repos } = ensureDb()
    const { name, description, fromCurrentConfig, fromPresetId } = parsed.data

    // Duplicate an existing preset
    if (fromPresetId !== undefined) {
      const src = repos.presets.getById(fromPresetId)
      if (!src) {
        return NextResponse.json(
          { error: `Preset ${fromPresetId} not found` },
          { status: 404 },
        )
      }
      const newId = repos.presets.duplicate(fromPresetId, name)
      return NextResponse.json({ id: newId }, { status: 201 })
    }

    // Snapshot current global config as new preset content
    if (fromCurrentConfig) {
      const id = repos.presets.create(name, description)
      const agents = repos.translatorAgents.list()
      const coordinator = repos.coordinatorConfig.get()
      const prompts = repos.promptTemplates.list()

      repos.presets.saveContent(
        id,
        agents.map((a) => ({
          name: a.name,
          endpoint_id: a.endpoint_id,
          model: a.model,
          prompt_override: a.prompt_override,
          sort_order: a.sort_order,
        })),
        coordinator
          ? {
              endpoint_id: coordinator.endpoint_id,
              model: coordinator.model,
              chat_endpoint_id: coordinator.chat_endpoint_id,
              chat_model: coordinator.chat_model,
            }
          : null,
        prompts.map((p) => ({ kind: p.kind, name: p.name, content: p.content })),
      )
      return NextResponse.json({ id }, { status: 201 })
    }

    // Empty preset
    const id = repos.presets.create(name, description)
    return NextResponse.json({ id }, { status: 201 })
  } catch (e) {
    return NextResponse.json({ error: 'Failed to create preset' }, { status: 500 })
  }
}
