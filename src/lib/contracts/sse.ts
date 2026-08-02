// ---------------------------------------------------------------------------
// SSE (Server-Sent Events) encoder / parser
// ---------------------------------------------------------------------------

// ---- Types ----

/**
 * A single parsed SSE event.
 * Fields follow the SSE spec: event, data, id, retry.
 */
export interface SSEEvent {
  event: string
  data: string
  id?: string
  retry?: number
}

/**
 * Split a transport buffer after its last complete SSE event boundary.
 *
 * The returned remainder contains only the unfinished tail. Callers should
 * replace their previous buffer with that remainder instead of reparsing the
 * full response on every network chunk.
 */
export function takeCompleteSSEText(buffer: string): {
  completeText: string
  remainder: string
} {
  const boundaryPattern = /\r?\n\r?\n/g
  let lastBoundaryEnd = 0
  let match: RegExpExecArray | null

  while ((match = boundaryPattern.exec(buffer)) !== null) {
    lastBoundaryEnd = match.index + match[0].length
  }

  if (lastBoundaryEnd === 0) {
    return { completeText: '', remainder: buffer }
  }

  return {
    completeText: buffer.slice(0, lastBoundaryEnd),
    remainder: buffer.slice(lastBoundaryEnd),
  }
}

// ---- Encode ----

/**
 * Encode an event name and data into an SSE text frame.
 * `data` is JSON-stringified only for non-string values.
 */
export function encodeSSE(event: string, data: unknown): string {
  const dataStr = typeof data === 'string' ? data : JSON.stringify(data)
  return `event: ${event}\ndata: ${dataStr}\n\n`
}

// ---- Parse (stateful, handles chunked transport) ----

/**
 * Parse buffered text into SSE events, handling partial chunks.
 *
 * Implements the SSE parsing spec:
 * - Lines starting with `:` are comments (ignored)
 * - Lines are `field: value` or `field:value` (space after colon optional)
 * - Empty line (`\n\n` or `\r\n\r\n`) terminates an event
 * - Multiple `data:` lines are joined with newlines
 * - Supports CRLF (`\r\n`) and LF (`\n`) line endings
 * - Unknown fields are ignored
 *
 * For cross-chunk truncation, pass `previousPartial` to join with the
 * previous incomplete buffer. The function is stateless — each call is
 * independent; pass previousPartial to stitch chunks together.
 */
export function parseSSEChunk(
  buffer: string,
  options?: { previousPartial?: string }
): SSEEvent[] {
  const fullText = options?.previousPartial
    ? options.previousPartial + buffer
    : buffer

  // Normalize CRLF → LF
  const normalized = fullText.replace(/\r\n/g, '\n')

  const events: SSEEvent[] = []

  let currentEvent: { event?: string; data?: string; id?: string; retry?: number } = {}
  const dataLines: string[] = []
  let hasEventContent = false

  // We need to detect blank lines (empty line) that terminate events.
  // A blank line = `\n\n` in the normalized text.
  // We walk through the normalized text character by character,
  // collecting line contents until we hit a line terminator.
  //
  // Approach: split by `\n` and process each line, BUT we must distinguish
  // between "end of line before more content" vs "blank line terminator".
  // A blank line appears as two consecutive `\n` characters, which after
  // splitting gives us an empty string between them.
  //
  // However, a trailing `\n` at the end of the buffer also produces an
  // empty string in the split. To distinguish: a blank line terminator
  // happens between two non-empty (or at least populated) lines,
  // while a trailing `\n` is the very last character before end-of-buffer.
  //
  // Strategy: split by `\n`. For each segment:
  // - If it's a regular line, accumulate fields.
  // - If it's empty AND we have seen content before AND there are more
  //   segments after OR the original text contains `\n\n` at this position:
  //   it's a blank line terminator → emit event.

  const segments = normalized.split('\n')

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]

    if (seg === '') {
      // Empty segment — could be a blank line terminator or a trailing newline.
      // It's a blank line IF:
      // - We have accumulated event content (hasEventContent is true), AND
      // - There is more content after this (i < segments.length - 1), OR
      //   the original text ends with `\n\n` (i.e. this blank line is
      //   explicitly terminated).
      const isLastSegment = i === segments.length - 1

      if (hasEventContent && !isLastSegment) {
        // Blank line at position i (between line i-1 and line i+1)
        currentEvent.data = dataLines.join('\n')
        events.push({
          event: currentEvent.event ?? '',
          data: currentEvent.data ?? '',
          ...(currentEvent.id !== undefined ? { id: currentEvent.id } : {}),
          ...(currentEvent.retry !== undefined ? { retry: currentEvent.retry } : {}),
        })
        // Reset
        currentEvent = {}
        dataLines.length = 0
        hasEventContent = false
      }
      // If it's the last segment with hasEventContent, the event is incomplete.
      // We discard it — it'll be completed with the next chunk via previousPartial.
      continue
    }

    // Non-empty segment

    // Comment line
    if (seg.startsWith(':')) {
      continue
    }

    // Parse field: value
    const colonIdx = seg.indexOf(':')
    if (colonIdx === -1) {
      // Line without colon is invalid per SSE spec, skip
      continue
    }

    const field = seg.slice(0, colonIdx)
    let value = seg.slice(colonIdx + 1)
    if (value.startsWith(' ')) {
      value = value.slice(1)
    }

    hasEventContent = true

    switch (field) {
      case 'event':
        currentEvent.event = value
        break
      case 'data':
        dataLines.push(value)
        break
      case 'id':
        currentEvent.id = value
        break
      case 'retry': {
        const parsed = parseInt(value, 10)
        if (!isNaN(parsed)) {
          currentEvent.retry = parsed
        }
        break
      }
      // Unknown fields are ignored (SSE spec)
    }
  }

  return events
}
