export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { createHandlers } from './handlers'

let handlers: ReturnType<typeof createHandlers> | null = null

function productionHandlers() {
  if (handlers) return handlers
  const db = getDb()
  migrate(db)
  handlers = createHandlers(db)
  return handlers
}

export const GET = () => productionHandlers().GET()
