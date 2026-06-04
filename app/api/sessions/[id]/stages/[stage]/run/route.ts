// ---------------------------------------------------------------------------
// POST /api/sessions/[id]/stages/[stage]/run — 单阶段 SSE 路由 (Wave 3 Task 18)
// ---------------------------------------------------------------------------
// Lazy singleton — defers DB init to first request via createHandlers factory.
// Tests import createHandlers directly from ./handlers to avoid vi.mock.
// ---------------------------------------------------------------------------

export const runtime = 'nodejs'

import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { createHandlers } from './handlers'

// ── Lazy singleton — no DB access at build time ──────────────────────
let _handlers: ReturnType<typeof createHandlers> | null = null
function prod(): ReturnType<typeof createHandlers> {
  if (!_handlers) {
    const db = getDb()
    migrate(db)
    _handlers = createHandlers(db)
  }
  return _handlers
}

export const POST = (
  req: Request,
  ctx: { params: Promise<{ id: string; stage: string }> },
) => prod().POST(req, ctx)
