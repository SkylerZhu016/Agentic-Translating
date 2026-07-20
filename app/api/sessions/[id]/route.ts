// ---------------------------------------------------------------------------
// Session Detail API — GET /api/sessions/:id  (full state with child records)
// ---------------------------------------------------------------------------
import { NextRequest } from 'next/server'
import { getDb } from '@/src/lib/db'
import { createHandlers } from './handlers'

export const runtime = 'nodejs'

// ── Production export (lazy singleton) ────────────────────────────
let _handlers: ReturnType<typeof createHandlers> | null = null
function prod(): ReturnType<typeof createHandlers> {
  if (!_handlers) _handlers = createHandlers(getDb())
  return _handlers
}

export const GET = (
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) => prod().GET(req, ctx)

export const DELETE = (
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) => prod().DELETE(req, ctx)
