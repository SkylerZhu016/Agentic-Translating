import { describe, expect, it } from 'vitest'
import { inferRequiredDynamicArchetypes } from '../../src/lib/orchestration/vnext-runner'

describe('dynamic team policy', () => {
  it('keeps only the safety pair for continuously typeset classical Chinese verse', () => {
    expect(
      inferRequiredDynamicArchetypes(
        '相见时难别亦难，东风无力百花残。春蚕到死丝方尽，蜡炬成灰泪始干。晓镜但愁云鬓改，夜吟应觉月光寒。蓬山此去无多路，青鸟殷勤为探看。',
      ),
    ).toEqual(['semantic-fidelity', 'poetry-form'])
  })

  it('keeps only the safety pair for a lineated English poem', () => {
    expect(
      inferRequiredDynamicArchetypes(
        'One line\nA second line\nA third line\nA fourth line',
      ),
    ).toEqual(['semantic-fidelity', 'poetry-form'])
  })

  it('keeps the general fallback pair for ordinary prose', () => {
    expect(
      inferRequiredDynamicArchetypes('A short ordinary paragraph.'),
    ).toEqual(['semantic-fidelity', 'target-naturalness'])
  })

  it('honours explicit poetry enable and disable settings', () => {
    expect(
      inferRequiredDynamicArchetypes(
        'A deliberately ambiguous one-line text.',
        '',
        { poetryMode: 'on' },
      ),
    ).toEqual(['semantic-fidelity', 'poetry-form'])
    expect(
      inferRequiredDynamicArchetypes(
        'Line one\nLine two\nLine three\nLine four',
        '',
        { poetryMode: 'off' },
      ),
    ).toEqual(['semantic-fidelity', 'target-naturalness'])
  })
})
