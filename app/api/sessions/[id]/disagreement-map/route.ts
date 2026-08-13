import { type NextRequest } from 'next/server'
import { getDb } from '@/src/lib/db'
import { createHandlers } from './handlers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

let handlers: ReturnType<typeof createHandlers> | null = null

function productionHandlers() {
  if (!handlers) handlers = createHandlers(getDb())
  return handlers
}

export const GET = (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) => productionHandlers().GET(request, context)
