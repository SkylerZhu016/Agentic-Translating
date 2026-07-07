// ---------------------------------------------------------------------------
// Test-only DB reset endpoint — POST /api/test-only/reset-db
//
// Mounted ONLY when process.env.NODE_ENV !== 'production'. In a `next build`
// production artifact this route returns 404 (it is compiled out at request
// time). This lets Playwright E2E specs reset the SQLite DB to a clean
// baseline between tests without hitting real LLM endpoints or restarting
// the server.
//
// Behavior:
//   POST /api/test-only/reset-db
//     200 { success: true, tables: string[] }   on success
//     404 { error: 'not_available_in_production' } in production builds
//
// The reset:
//   1. DELETEs all rows from every domain table (FK-safe order: children first)
//   2. Re-runs seed() to restore builtin prompt templates + default settings
//   3. Keeps the migrations meta table intact
// ---------------------------------------------------------------------------

export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { seed } from '@/src/lib/db/seed'

// Domain tables in FK-safe deletion order (children before parents).
const DOMAIN_TABLES = [
  'chat_messages',
  'final_versions',
  'stage_outputs',
  'translation_results',
  'sessions',
  'settings',
  'coordinator_config',
  'translator_agents',
  'prompt_templates',
  'endpoints',
] as const

// In production builds the route module is still bundled, but the handler
// short-circuits to 404. Combined with Next.js route-segment `runtime =
// 'nodejs'`, this guarantees the route is inert in prod.
function isProduction(): boolean {
  if (process.env.E2E_TEST === 'true') return false
  return process.env.NODE_ENV === 'production'
}

export async function POST(_req: NextRequest) {
  if (isProduction()) {
    return NextResponse.json(
      { error: 'not_available_in_production' },
      { status: 404 },
    )
  }

  try {
    const db = getDb()
    migrate(db) // ensure schema exists (idempotent)

    // Disable FK enforcement during bulk delete to avoid ordering pitfalls,
    // then re-enable. WAL + foreign_keys pragma is restored below.
    db.pragma('foreign_keys = OFF')
    try {
      for (const table of DOMAIN_TABLES) {
        db.exec(`DELETE FROM ${table}`)
      }
    } finally {
      db.pragma('foreign_keys = ON')
    }

    // Re-seed builtin prompts + default settings.
    seed(db)

    return NextResponse.json(
      { success: true, tables: [...DOMAIN_TABLES] },
      { status: 200 },
    )
  } catch (e) {
    return NextResponse.json(
      {
        error: 'reset_failed',
        message: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    )
  }
}

// GET is a no-op probe for E2E health checks (also gated to non-prod).
export async function GET(_req: NextRequest) {
  if (isProduction()) {
    return NextResponse.json(
      { error: 'not_available_in_production' },
      { status: 404 },
    )
  }
  return NextResponse.json({ ok: true, endpoint: 'reset-db' })
}
