export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { createSessionEventStream } from './stream'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const db = getDb()
  migrate(db)
  const afterFromHeader = Number(request.headers.get('last-event-id') ?? 0)
  const afterFromQuery = Number(new URL(request.url).searchParams.get('after') ?? 0)
  const cursor = Math.max(
    Number.isSafeInteger(afterFromHeader) ? afterFromHeader : 0,
    Number.isSafeInteger(afterFromQuery) ? afterFromQuery : 0,
    0,
  )
  const stream = createSessionEventStream(db, id, cursor, request.signal)
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}
