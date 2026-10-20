import type { SSEEvent } from '../contracts/sse'
import type { Stage } from '../contracts/types'

const STAGE_STREAM_EVENT = 'agentic-translating:stage-stream'
const STAGES = new Set<Stage>(['review', 'filter', 'orchestrate', 'assemble'])

export interface StageStreamEventDetail {
  sessionId: string
  stage: Stage
  event: string
  /** Only persisted event IDs are forwarded. Reasoning previews are transient. */
  id?: number
  data: Record<string, unknown>
}

/**
 * Share the translation hook's existing connection with coordination panels.
 * This bus never opens a connection, starts a run, or persists model reasoning.
 */
export function emitStageStreamEvent(
  sessionId: string,
  event: SSEEvent,
  data: Record<string, unknown>,
) {
  if (typeof window === 'undefined' || !event.event.startsWith('stage.')) return
  if (typeof data.stage !== 'string' || !STAGES.has(data.stage as Stage)) return
  const id = event.event === 'stage.reasoning' ? undefined : Number(event.id)
  window.dispatchEvent(new CustomEvent<StageStreamEventDetail>(STAGE_STREAM_EVENT, {
    detail: {
      sessionId,
      stage: data.stage as Stage,
      event: event.event,
      ...(Number.isSafeInteger(id) && (id ?? 0) > 0 ? { id } : {}),
      data,
    },
  }))
}

export function onStageStreamEvent(
  handler: (detail: StageStreamEventDetail) => void,
): () => void {
  if (typeof window === 'undefined') return () => {}
  const listener = (event: Event) => {
    handler((event as CustomEvent<StageStreamEventDetail>).detail)
  }
  window.addEventListener(STAGE_STREAM_EVENT, listener)
  return () => window.removeEventListener(STAGE_STREAM_EVENT, listener)
}
