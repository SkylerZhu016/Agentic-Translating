export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { createRepositories } from '@/src/lib/db/repositories'
import { seed } from '@/src/lib/db/seed'

// POST /api/prompts/reset — restore seed builtin prompts
export async function POST(_req: NextRequest) {
  try {
    const db = getDb()
    migrate(db)
    const repos = createRepositories(db)

    // Delete all non-builtin prompts
    const all = repos.promptTemplates.list()
    for (const p of all) {
      if (p.is_builtin === 0) {
        repos.promptTemplates.delete(p.id)
      }
    }

    // Re-seed builtin prompts (seed() is idempotent for builtins)
    seed(db)

    const updated = repos.promptTemplates.list()
    return NextResponse.json({ success: true, prompts: updated })
  } catch (e) {
    return NextResponse.json({ error: 'Failed to reset prompts' }, { status: 500 })
  }
}
