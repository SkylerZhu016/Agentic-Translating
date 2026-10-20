import type { ReasoningUpdate } from './client'

export interface ReasoningPreview {
  reasoningPreview: string
  reasoningCharacters: number
  reasoningTruncated: boolean
}

export const REASONING_PREVIEW_LIMIT = 4_000

/** Retains one small display tail. It never builds a full reasoning transcript. */
export function createReasoningPreview(
  onPreview: (snapshot: ReasoningPreview) => void,
  intervalMs = 200,
) {
  let snapshot: ReasoningPreview = {
    reasoningPreview: '',
    reasoningCharacters: 0,
    reasoningTruncated: false,
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  let dirty = false
  let disposed = false

  const flush = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (!dirty) return
    dirty = false
    try {
      onPreview({ ...snapshot })
    } catch {
      // Observing a preview must never fail a paid call or escape a timer.
    }
  }

  return {
    push(update: ReasoningUpdate) {
      if (disposed) return
      // A provider fragment can be larger than the transport's display slice.
      // A gap invalidates the older tail; joining it would invent continuity.
      const skippedCharacters = update.characters - snapshot.reasoningCharacters > update.delta.length
      const preview = ((skippedCharacters ? '' : snapshot.reasoningPreview) + update.delta)
        .slice(-REASONING_PREVIEW_LIMIT)
      snapshot = {
        reasoningPreview: preview,
        reasoningCharacters: update.characters,
        reasoningTruncated:
          snapshot.reasoningTruncated ||
          update.truncated ||
          update.characters > preview.length,
      }
      dirty = true
      if (timer === null) timer = setTimeout(flush, intervalMs)
    },
    flush,
    dispose() {
      if (disposed) return
      flush()
      disposed = true
    },
    getSnapshot: () => ({ ...snapshot }),
  }
}
