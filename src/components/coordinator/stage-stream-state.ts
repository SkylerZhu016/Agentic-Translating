import type { Stage } from '@/src/lib/contracts/types'
import type { StageStreamEventDetail } from '@/src/lib/client/stage-stream-bus'

export const STAGE_TEXT_FLUSH_MS = 75
export const STAGE_REASONING_FLUSH_MS = 200
export const STAGE_REASONING_PREVIEW_LIMIT = 4_000

export interface StageStreamState {
  body: string
  annotation: string
  reasoningPreview: string
  reasoningCharacters: number
  reasoningTruncated: boolean
  running: boolean
}

export type StageStreamMap = Record<Stage, StageStreamState>

export function emptyStageStream(): StageStreamState {
  return {
    body: '',
    annotation: '',
    reasoningPreview: '',
    reasoningCharacters: 0,
    reasoningTruncated: false,
    running: false,
  }
}

export function emptyStageStreams(): StageStreamMap {
  return {
    review: emptyStageStream(),
    filter: emptyStageStream(),
    orchestrate: emptyStageStream(),
    assemble: emptyStageStream(),
  }
}

/** Apply one already-decoded event without reparsing any earlier output. */
export function applyStageStreamEvent(
  current: StageStreamState,
  event: Pick<StageStreamEventDetail, 'event' | 'data'>,
): StageStreamState {
  const { data } = event
  switch (event.event) {
    case 'stage.started':
    case 'stage.reset':
      return { ...emptyStageStream(), running: true }
    case 'stage.delta':
      return typeof data.delta === 'string' && data.delta
        ? { ...current, body: current.body + data.delta, running: true }
        : current
    case 'stage.annotation':
      return typeof data.delta === 'string' && data.delta
        ? { ...current, annotation: current.annotation + data.delta, running: true }
        : current
    case 'stage.reasoning':
    case 'stage.reasoning.completed': {
      const preview = typeof data.reasoningPreview === 'string'
        ? data.reasoningPreview.slice(-STAGE_REASONING_PREVIEW_LIMIT)
        : current.reasoningPreview
      const characters = typeof data.reasoningCharacters === 'number' &&
          Number.isFinite(data.reasoningCharacters)
        ? Math.max(0, data.reasoningCharacters)
        : current.reasoningCharacters
      return {
        ...current,
        reasoningPreview: preview,
        reasoningCharacters: characters,
        reasoningTruncated: data.reasoningTruncated === true ||
          characters > preview.length,
      }
    }
    case 'stage.completed':
      return {
        ...current,
        body: typeof data.body === 'string' ? data.body : current.body,
        annotation: typeof data.annotation === 'string'
          ? data.annotation : current.annotation,
        running: false,
      }
    case 'stage.failed':
      return { ...current, running: false }
    default:
      return current
  }
}

/**
 * Coalesce transport chunks outside React. Reasoning gets its own slower clock,
 * so fast body updates do not accidentally force reasoning repaint per token.
 */
export function createStageStreamBatcher(
  publish: (streams: StageStreamMap) => void,
) {
  let current = emptyStageStreams()
  let published = emptyStageStreams()
  let textTimer: ReturnType<typeof setTimeout> | undefined
  let reasoningTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  function flushText() {
    if (textTimer) clearTimeout(textTimer)
    textTimer = undefined
    if (disposed) return
    published = Object.fromEntries(
      Object.entries(current).map(([stage, value]) => {
        const previous = published[stage as Stage]
        return [stage, {
          ...value,
          reasoningPreview: previous.reasoningPreview,
          reasoningCharacters: previous.reasoningCharacters,
          reasoningTruncated: previous.reasoningTruncated,
        }]
      }),
    ) as StageStreamMap
    publish(published)
  }

  function flushReasoning() {
    if (reasoningTimer) clearTimeout(reasoningTimer)
    reasoningTimer = undefined
    if (disposed) return
    published = Object.fromEntries(
      Object.entries(published).map(([stage, value]) => {
        const latest = current[stage as Stage]
        return [stage, {
          ...value,
          reasoningPreview: latest.reasoningPreview,
          reasoningCharacters: latest.reasoningCharacters,
          reasoningTruncated: latest.reasoningTruncated,
        }]
      }),
    ) as StageStreamMap
    publish(published)
  }

  return {
    push(detail: StageStreamEventDetail) {
      if (disposed) return
      const next = applyStageStreamEvent(current[detail.stage], detail)
      if (next === current[detail.stage]) return
      current = { ...current, [detail.stage]: next }
      const reasoningOnly = detail.event === 'stage.reasoning' ||
        detail.event === 'stage.reasoning.completed'
      if (reasoningOnly) {
        reasoningTimer ??= setTimeout(flushReasoning, STAGE_REASONING_FLUSH_MS)
      } else if (
        detail.event === 'stage.delta' || detail.event === 'stage.annotation'
      ) {
        textTimer ??= setTimeout(flushText, STAGE_TEXT_FLUSH_MS)
      } else {
        // Start/reset/terminal events are barriers. Publish the final batch
        // immediately, including the reset or last bounded reasoning preview.
        if (textTimer) clearTimeout(textTimer)
        if (reasoningTimer) clearTimeout(reasoningTimer)
        textTimer = undefined
        reasoningTimer = undefined
        published = current
        publish(published)
      }
    },
    flush() {
      if (disposed) return
      if (textTimer) clearTimeout(textTimer)
      if (reasoningTimer) clearTimeout(reasoningTimer)
      textTimer = undefined
      reasoningTimer = undefined
      published = current
      publish(published)
    },
    dispose() {
      disposed = true
      if (textTimer) clearTimeout(textTimer)
      if (reasoningTimer) clearTimeout(reasoningTimer)
    },
  }
}
