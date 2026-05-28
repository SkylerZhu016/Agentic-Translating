// ---------------------------------------------------------------------------
// Version Restore API — POST /api/sessions/:id/versions/:versionNo/restore
// Creates a new version (source='restore') by cloning an existing one,
// then records a system chat message.
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

export const POST = (
  req: NextRequest,
  ctx: { params: Promise<{ id: string; versionNo: string }> },
) => prod().POST(req, ctx)
