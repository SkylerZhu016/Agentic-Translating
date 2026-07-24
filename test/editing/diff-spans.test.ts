import { describe, expect, it } from 'vitest'
import { buildDiffSpans } from '../../src/lib/editing/diff-spans'

describe('Unicode-aware diff spans', () => {
  it('reconstructs both versions and keeps an emoji family grapheme intact', () => {
    const before = '你好👨‍👩‍👧‍👦'
    const after = '您好👨‍👩‍👧‍👦'
    const spans = buildDiffSpans(before, after)
    expect(
      spans
        .filter((span) => span.type !== 'insert')
        .map((span) => span.text)
        .join(''),
    ).toBe(before)
    expect(
      spans
        .filter((span) => span.type !== 'delete')
        .map((span) => span.text)
        .join(''),
    ).toBe(after)
    const emojiSpans = spans.filter((span) =>
      span.text.includes('👨‍👩‍👧‍👦'),
    )
    expect(emojiSpans).toHaveLength(1)
    expect(emojiSpans[0].type).toBe('equal')
    expect(emojiSpans[0].text.endsWith('👨‍👩‍👧‍👦')).toBe(true)
  })
})
