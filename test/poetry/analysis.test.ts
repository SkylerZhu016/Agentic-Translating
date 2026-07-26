import { describe, expect, it } from 'vitest'
import {
  analyzePoetrySource,
  containsLyricSpecificRequest,
} from '../../src/lib/poetry/analysis'

const LI_SHANGYIN =
  '相见时难别亦难，东风无力百花残。春蚕到死丝方尽，蜡炬成灰泪始干。晓镜但愁云鬓改，夜吟应觉月光寒。蓬山此去无多路，青鸟殷勤为探看。'

describe('poetry source analysis', () => {
  it('splits continuously typeset classical Chinese and preserves boundary topology', () => {
    const analysis = analyzePoetrySource({
      sourceText: LI_SHANGYIN,
      constraints: {
        poetryMode: 'auto',
        rhymePositions: 'auto',
        firstLineRhyme: 'auto',
      },
    })

    expect(analysis.isPoetry).toBe(true)
    expect(analysis.lines).toHaveLength(8)
    expect(analysis.lines.map((line) => line.boundary)).toEqual([
      'continuation',
      'closure',
      'continuation',
      'closure',
      'continuation',
      'closure',
      'continuation',
      'closure',
    ])
    expect(analysis.suggestedRhymeLines).toEqual([1, 2, 4, 6, 8])
    expect(analysis.suggestedScheme).toBe('AAxAxAxA')
  })

  it('honours an explicit poetry-off choice even for verse-shaped input', () => {
    const analysis = analyzePoetrySource({
      sourceText: LI_SHANGYIN,
      constraints: { poetryMode: 'off' },
    })
    expect(analysis.isPoetry).toBe(false)
  })

  it('keeps lyric-specific scope detection separate from poetry detection', () => {
    expect(containsLyricSpecificRequest('普通文本', '请适配旋律并确保可唱')).toBe(
      true,
    )
    expect(containsLyricSpecificRequest(LI_SHANGYIN, '翻译为英文诗')).toBe(false)
  })
})
