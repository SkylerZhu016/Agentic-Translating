// ---------------------------------------------------------------------------
// Sessions API — POST (create) + GET (list with pagination)
// ---------------------------------------------------------------------------
import { NextRequest } from 'next/server'
import { getDb } from '@/src/lib/db'
import { createHandlers } from './handlers'

export const runtime = 'nodejs'

// ── Production export (lazy singleton — avoids eager DB init at import) ─
let _handlers: ReturnType<typeof createHandlers> | null = null
function prod(): ReturnType<typeof createHandlers> {
  if (!_handlers) _handlers = createHandlers(getDb())
  return _handlers
}

export const POST = (req: NextRequest) => prod().POST(req)
export const GET = (req: NextRequest) => prod().GET(req)
