import { describe, it, expect } from 'vitest'
import {
  encodeSSE,
  parseSSEChunk,
  takeCompleteSSEText,
} from '../../src/lib/contracts/sse'

describe('encodeSSE', () => {
  it('encodes event + data as SSE format', () => {
    const result = encodeSSE('token', { a: 1 })
    expect(result).toBe('event: token\ndata: {"a":1}\n\n')
  })

  it('handles string data', () => {
    const result = encodeSSE('done', 'completed')
    // encodeSSE does not JSON-stringify string values (already a string)
    expect(result).toBe('event: done\ndata: completed\n\n')
  })

  it('handles numeric data', () => {
    const result = encodeSSE('ping', 42)
    expect(result).toBe('event: ping\ndata: 42\n\n')
  })
})

describe('parseSSEChunk', () => {
  it('parses a single complete event', () => {
    const events = parseSSEChunk('event: token\ndata: {"a":1}\n\n')
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ event: 'token', data: '{"a":1}' })
  })

  it('parses multiple events in one chunk', () => {
    const chunk = 'event: a\ndata: 1\n\nevent: b\ndata: 2\n\n'
    const events = parseSSEChunk(chunk)
    expect(events).toHaveLength(2)
    expect(events[0].event).toBe('a')
    expect(events[1].event).toBe('b')
  })

  it('ignores comment lines (starting with :)', () => {
    const chunk = ': ping\n\nevent: token\ndata: works\n\n'
    const events = parseSSEChunk(chunk)
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('token')
  })

  it('handles CRLF line endings', () => {
    const chunk = 'event: token\r\ndata: {"x":1}\r\n\r\n'
    const events = parseSSEChunk(chunk)
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('{"x":1}')
  })

  it('handles cross-chunk truncation — first chunk ends mid-line', () => {
    // Simulate: first chunk has incomplete data line
    const chunk1 = 'event: token\nda'
    const events1 = parseSSEChunk(chunk1)
    expect(events1).toHaveLength(0) // incomplete, no events yet

    // Second chunk completes it
    const chunk2 = 'ta: {"a":1}\n\n'
    const events2 = parseSSEChunk(chunk2, { previousPartial: chunk1 })
    expect(events2).toHaveLength(1)
    expect(events2[0].event).toBe('token')
    expect(events2[0].data).toBe('{"a":1}')
  })

  it('handles cross-chunk truncation where previousPartial is a full event split across chunks', () => {
    // event line complete in first chunk, data line split
    const chunk1 = 'event: complete\nda'
    const events1 = parseSSEChunk(chunk1)
    // No complete events yet
    expect(events1).toHaveLength(0)

    const chunk2 = 'ta: "done"\n\n'
    const events2 = parseSSEChunk(chunk2, { previousPartial: chunk1 })
    expect(events2).toHaveLength(1)
    expect(events2[0].event).toBe('complete')
    expect(events2[0].data).toBe('"done"')
  })

  it('handles truncation across three chunks', () => {
    const c1 = 'event: tok'
    const c2 = 'en\nda'
    // No complete events from c1 or c2 alone
    expect(parseSSEChunk(c1)).toHaveLength(0)
    expect(parseSSEChunk(c2, { previousPartial: c1 })).toHaveLength(0)

    const c3 = 'ta: 1\n\n'
    const events = parseSSEChunk(c3, { previousPartial: c1 + c2 })
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('token')
    expect(events[0].data).toBe('1')
  })

  it('handles empty data (event only)', () => {
    const chunk = 'event: done\n\n'
    const events = parseSSEChunk(chunk)
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('done')
    expect(events[0].data).toBe('')
  })

  it('handles multiple data lines per event (concatenated with newline)', () => {
    const chunk = 'event: msg\ndata: line1\ndata: line2\n\n'
    const events = parseSSEChunk(chunk)
    expect(events).toHaveLength(1)
    // SSE spec: multiple data lines should be joined with newline
    expect(events[0].data).toBe('line1\nline2')
  })

  it('ignores unknown fields (non-event, non-data)', () => {
    const chunk = 'event: msg\ndata: ok\nid: 42\nretry: 3000\n\n'
    const events = parseSSEChunk(chunk)
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('msg')
    expect(events[0].data).toBe('ok')
  })

  it('handles [DONE] marker (OpenAI termination)', () => {
    const chunk = 'data: [DONE]\n\n'
    const events = parseSSEChunk(chunk)
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('') // no event field → empty string
    expect(events[0].data).toBe('[DONE]')
  })

  it('preserves extra fields beyond event and data', () => {
    const chunk = 'event: custom\ndata: payload\nid: abc123\n\n'
    const events = parseSSEChunk(chunk)
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('custom')
    expect(events[0].data).toBe('payload')
    // extra fields are not explicitly tracked but should not cause errors
  })

  it('returns empty array for empty input', () => {
    expect(parseSSEChunk('')).toHaveLength(0)
  })

  it('returns empty array for whitespace-only input', () => {
    expect(parseSSEChunk('   \n  \n')).toHaveLength(0)
  })

  it('isolates partial state correctly between calls', () => {
    // First call — partial event
    const r1 = parseSSEChunk('event: x\n')
    expect(r1).toHaveLength(0)

    // Second call — no partial, verify state not polluted
    const r2 = parseSSEChunk('event: y\ndata: 1\n\n')
    expect(r2).toHaveLength(1)
    expect(r2[0].event).toBe('y')
  })
})

describe('takeCompleteSSEText', () => {
  it('returns complete LF events and keeps only the partial tail', () => {
    const input =
      'data: {"one":1}\n\n' +
      'data: {"two":2}\n\n' +
      'data: {"partial"'
    const result = takeCompleteSSEText(input)

    expect(parseSSEChunk(result.completeText)).toHaveLength(2)
    expect(result.remainder).toBe('data: {"partial"')
  })

  it('handles a CRLF boundary split across transport chunks', () => {
    let pending = 'data: {"one":1}\r\n\r'
    let result = takeCompleteSSEText(pending)
    expect(result.completeText).toBe('')

    pending = result.remainder + '\ndata: {"two":2}\r\n\r\n'
    result = takeCompleteSSEText(pending)

    expect(parseSSEChunk(result.completeText).map((event) => event.data)).toEqual([
      '{"one":1}',
      '{"two":2}',
    ])
    expect(result.remainder).toBe('')
  })

  it('keeps the parser buffer bounded across many reasoning events', () => {
    let pending = ''
    let parsedCount = 0

    for (let index = 0; index < 20_000; index += 1) {
      pending +=
        `data: {"choices":[{"delta":{"reasoning_content":"${index}"}}]}\n\n`
      const result = takeCompleteSSEText(pending)
      pending = result.remainder
      parsedCount += parseSSEChunk(result.completeText).length
      expect(pending.length).toBe(0)
    }

    expect(parsedCount).toBe(20_000)
  })
})
