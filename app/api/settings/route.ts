export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { createRepositories } from '@/src/lib/db/repositories'
import { z } from 'zod'

const settingsPutSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
})

function ensureDb() {
  const db = getDb()
  migrate(db)
  return { db, repos: createRepositories(db) }
}

// GET /api/settings — list all key-value pairs
export async function GET(_req: NextRequest) {
  try {
    const { repos } = ensureDb()
    const list = repos.settings.list()
    return NextResponse.json(list)
  } catch (e) {
    return NextResponse.json({ error: 'Failed to list settings' }, { status: 500 })
  }
}

// PUT /api/settings — upsert key-value pair(s)
// Accepts either a single {key, value} or an array of them
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null)
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

    const { repos } = ensureDb()

    // Accept single or array
    const entries = Array.isArray(body) ? body : [body]

    const results: { key: string; value: string }[] = []
    for (const entry of entries) {
      const parsed = settingsPutSchema.safeParse(entry)
      if (!parsed.success) {
        return NextResponse.json(
          { error: 'Validation failed', details: parsed.error.flatten() },
          { status: 400 },
        )
      }
      repos.settings.set({ key: parsed.data.key, value: parsed.data.value })
      results.push({ key: parsed.data.key, value: parsed.data.value })
    }

    return NextResponse.json({ success: true, updated: results })
  } catch (e) {
    return NextResponse.json({ error: 'Failed to update settings' }, { status: 500 })
  }
}
