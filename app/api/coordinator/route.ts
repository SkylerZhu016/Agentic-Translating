export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { createRepositories } from '@/src/lib/db/repositories'
import { detectFlashModel } from '@/src/lib/guards/flash'
import { z } from 'zod'

const coordinatorPutSchema = z.object({
  endpoint_id: z.number().int().positive().nullable().optional(),
  model: z.string().min(1).optional(),
  chat_endpoint_id: z.number().int().positive().nullable().optional(),
  chat_model: z.string().min(1).optional(),
  suppress_warnings: z.array(z.string()).optional(),
})

function ensureDb() {
  const db = getDb()
  migrate(db)
  return { db, repos: createRepositories(db) }
}

// GET /api/coordinator — get singleton config
export async function GET(_req: NextRequest) {
  try {
    const { repos } = ensureDb()
    const config = repos.coordinatorConfig.get()
    if (!config) {
      return NextResponse.json({ error: 'Coordinator not configured' }, { status: 404 })
    }
    return NextResponse.json(config)
  } catch (e) {
    return NextResponse.json({ error: 'Failed to get coordinator config' }, { status: 500 })
  }
}

// PUT /api/coordinator — update with flash detection, suppress, fallback
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null)
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

    const parsed = coordinatorPutSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 },
      )
    }

    const { repos } = ensureDb()
    const existing = repos.coordinatorConfig.get()

    // Merge with existing values as fallback for missing fields
    const model = parsed.data.model ?? existing?.model ?? 'gpt-4o'
    const chatModel = parsed.data.chat_model ?? existing?.chat_model ?? 'gpt-4o-mini'
    const endpointId = parsed.data.endpoint_id !== undefined
      ? parsed.data.endpoint_id
      : (existing?.endpoint_id ?? null)
    const chatEndpointId = parsed.data.chat_endpoint_id !== undefined
      ? parsed.data.chat_endpoint_id
      : (existing?.chat_endpoint_id ?? null)

    // Handle suppress_warnings
    let suppressed = false
    if (parsed.data.suppress_warnings?.includes('flash_coordinator')) {
      repos.settings.set({ key: 'suppress_flash_warning', value: '1' })
      suppressed = true
    }

    // Check if flash warning was previously suppressed
    const flashSuppressSetting = repos.settings.get('suppress_flash_warning')
    const flashPermanentlySuppressed = flashSuppressSetting?.value === '1'

    // Upsert config
    repos.coordinatorConfig.upsert({
      endpoint_id: endpointId,
      model,
      chat_endpoint_id: chatEndpointId,
      chat_model: chatModel,
    })

    const updated = repos.coordinatorConfig.get()

    // Build response with optional flash warning
    const response: Record<string, unknown> = { ...updated }

    if (!suppressed && !flashPermanentlySuppressed && detectFlashModel(model)) {
      response.warning = '不推荐使用flash模型进行统筹'
      response.warning_id = 'flash_coordinator'
    }

    return NextResponse.json(response)
  } catch (e) {
    return NextResponse.json({ error: 'Failed to update coordinator config' }, { status: 500 })
  }
}
