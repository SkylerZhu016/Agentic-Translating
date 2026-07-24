import { bestSubSequence } from 'fast-array-diff'
import type { DiffSpan } from '../contracts/vnext'

function graphemes(text: string): string[] {
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    return Array.from(segmenter.segment(text), (item) => item.segment)
  }
  return Array.from(text)
}

/**
 * Independent Unicode-aware diff. A failure never blocks saving: callers get
 * a conservative before/after block representation instead.
 */
export function buildDiffSpans(before: string, after: string): DiffSpan[] {
  try {
    const beforeParts = graphemes(before)
    const afterParts = graphemes(after)
    const spans: DiffSpan[] = []
    bestSubSequence(
      beforeParts,
      afterParts,
      (left, right) => left === right,
      (type, oldItems, oldStart, oldEnd, newItems, newStart, newEnd) => {
        const text =
          type === 'add'
            ? newItems.slice(newStart, newEnd).join('')
            : oldItems.slice(oldStart, oldEnd).join('')
        if (!text) return
        const mappedType =
          type === 'add' ? 'insert' : type === 'remove' ? 'delete' : 'equal'
        const previous = spans.at(-1)
        if (previous?.type === mappedType) {
          previous.text += text
        } else {
          spans.push({ type: mappedType, text })
        }
      },
    )
    return spans
  } catch {
    return [
      ...(before ? [{ type: 'delete' as const, text: before }] : []),
      ...(after ? [{ type: 'insert' as const, text: after }] : []),
    ]
  }
}
