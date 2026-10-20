import type Database from 'better-sqlite3'
import { encodeSSE } from '@/src/lib/contracts/sse'
import { redactCredentialValueForDb } from '@/src/lib/security/credential-redaction'
import { readReasoningPreviews } from '@/src/lib/orchestration/live-preview'

interface EventRow {
  id: number
  seq: number
  event_type: string
  payload_json: string
}

const EVENT_PAGE_SIZE = 64

export function createSessionEventStream(
  db: Database.Database,
  sessionId: string,
  after: number,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const events = db.prepare(`
    SELECT id, seq, event_type, payload_json
    FROM run_events WHERE session_id=? AND id>?
    ORDER BY id LIMIT ?
  `)
  const activeRun = db.prepare(`
    SELECT 1 FROM orchestration_runs
    WHERE session_id=? AND status IN ('queued','running') LIMIT 1
  `)
  let cursor = after
  let previewVersion = 0
  let stopped = signal.aborted
  let closed = false
  let wake: (() => void) | undefined
  const encoder = new TextEncoder()
  const onAbort = () => {
    stopped = true
    wake?.()
  }
  signal.addEventListener('abort', onAbort, { once: true })

  function cleanup() {
    signal.removeEventListener('abort', onAbort)
    wake?.()
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!stopped) {
          const rows = events.all(sessionId, cursor, EVENT_PAGE_SIZE) as EventRow[]
          if (rows.length > 0) {
            // Resolve the current credential set once per page. Key changes
            // still take effect on the next page without retaining secrets.
            const payloads = redactCredentialValueForDb(
              db,
              rows.map((row) => JSON.parse(row.payload_json)),
            )
            const chunk = rows.map((row, index) =>
              `id: ${row.id}\n${encodeSSE(row.event_type, {
                seq: row.seq,
                ...payloads[index],
              })}`,
            ).join('')
            cursor = rows[rows.length - 1].id
            controller.enqueue(encoder.encode(chunk))
            return
          }
          const previews = readReasoningPreviews(sessionId, previewVersion)
          if (previews.length > 0) {
            previewVersion = previews[previews.length - 1].version
            const payloads = redactCredentialValueForDb(
              db,
              previews.map((item) => item.payload),
            )
            // Ephemeral previews have no SSE id and never advance the
            // persisted cursor. Reconnection replays at most one bounded tail.
            controller.enqueue(encoder.encode(previews.map((item, index) =>
              encodeSSE(item.eventType, payloads[index]),
            ).join('')))
            return
          }
          if (!activeRun.get(sessionId)) break
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(finish, 250)
            function finish() {
              clearTimeout(timeout)
              wake = undefined
              resolve()
            }
            wake = finish
          })
        }
        if (!closed) {
          closed = true
          cleanup()
          controller.close()
        }
      } catch (error) {
        if (!closed) {
          closed = true
          cleanup()
          controller.error(error)
        }
      }
    },
    cancel() {
      stopped = true
      closed = true
      cleanup()
    },
  }, {
    // Read only when the network consumer requests data. A slow or abandoned
    // reader must not accumulate the whole persisted history in memory.
    highWaterMark: 0,
  })
}
