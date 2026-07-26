import { describe, expect, it } from 'vitest'
import { expectedStrictReplacement } from '../../app/api/sessions/[id]/chat/handlers'

describe('strict chat edit scope', () => {
  const current =
    'Hard to meet, and harder to part, the east wind falters. Everything else remains.'

  it('derives one exact replacement from a restrictive Chinese instruction', () => {
    expect(
      expectedStrictReplacement(
        '请只把“harder to part”改为“harder still to part”，其他内容保持不变。',
        current,
      ),
    ).toBe(
      'Hard to meet, and harder still to part, the east wind falters. Everything else remains.',
    )
  })

  it('does not constrain an open-ended polishing request', () => {
    expect(
      expectedStrictReplacement('请整体润色，使节奏更自然。', current),
    ).toBeNull()
  })

  it('does not guess when the quoted target is ambiguous', () => {
    expect(
      expectedStrictReplacement(
        '只把“to”改为“toward”，其他不变。',
        current,
      ),
    ).toBeNull()
  })
})
