export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { encodeSSE } from '@/src/lib/contracts/sse'
import { redactCredentialValueForDb } from '@/src/lib/security/credential-redaction'

interface EventRow {
  id: number
  seq: number
  event_type: string
  payload_json: string
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const db = getDb()
  migrate(db)
  const afterFromHeader = Number(request.headers.get('last-event-id') ?? 0)
  const afterFromQuery = Number(new URL(request.url).searchParams.get('after') ?? 0)
  let cursor = Math.max(
    Number.isFinite(afterFromHeader) ? afterFromHeader : 0,
    Number.isFinite(afterFromQuery) ? afterFromQuery : 0,
  )
  let cancelled = false
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      while (!cancelled) {
        const rows = db.prepare(`
          SELECT id, seq, event_type, payload_json
          FROM run_events
          WHERE session_id=? AND id>?
          ORDER BY id
        `).all(id, cursor) as EventRow[]
        for (const row of rows) {
          cursor = row.id
          controller.enqueue(
            encoder.encode(
              `id: ${row.id}\n${encodeSSE(row.event_type, {
                seq: row.seq,
                ...redactCredentialValueForDb(
                  db,
                  JSON.parse(row.payload_json),
                ),
              })}`,
            ),
          )
        }
        const active = db.prepare(`
          SELECT 1 FROM orchestration_runs
          WHERE session_id=? AND status IN ('queued','running')
          LIMIT 1
        `).get(id)
        if (!active && rows.length === 0) break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      if (!cancelled) controller.close()
    },
    cancel() {
      cancelled = true
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}
