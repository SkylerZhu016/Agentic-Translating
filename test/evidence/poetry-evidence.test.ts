import { describe, expect, it } from 'vitest'
import { checkTranslationEvidence } from '../../src/lib/evidence/checker'
import {
  findPingshuiGroups,
  PINGSHUI_GROUPS,
} from '../../src/lib/evidence/pingshui-data'

const SOURCE =
  '相见时难别亦难，东风无力百花残。春蚕到死丝方尽，蜡炬成灰泪始干。晓镜但愁云鬓改，夜吟应觉月光寒。蓬山此去无多路，青鸟殷勤为探看。'

describe('poetry evidence', () => {
  it('flags a full stop where the source poetic line continues', () => {
    const report = checkTranslationEvidence({
      direction: 'zh_to_en',
      sourceText: SOURCE,
      translatedText: [
        'To meet is hard, to part is hard.',
        'The east wind fades as flowers fall.',
        'The silkworm spins until it dies,',
        'The candle weeps until it dries.',
        'At dawn she fears her hair has changed,',
        'At night the moonlight chills the hall.',
        'The road from here to Penglai is not far.',
        'Let the blue bird seek him for me.',
      ].join('\n'),
      constraints: { poetryMode: 'on' },
      reportLanguage: 'en',
    })

    expect(report.boundaryWarnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Line 1 continues'),
        expect.stringContaining('Line 7 continues'),
      ]),
    )
  })

  it('accepts comma plus line break for source continuation boundaries', () => {
    const report = checkTranslationEvidence({
      direction: 'zh_to_en',
      sourceText: SOURCE,
      translatedText: [
        'To meet is hard, to part is hard,',
        'The east wind fades as flowers fall.',
        'The silkworm spins until it dies,',
        'The candle weeps until it dries.',
        'At dawn she fears her hair has changed,',
        'At night the moonlight chills the hall.',
        'The road from here to Penglai is not far,',
        'Let the blue bird seek him for me.',
      ].join('\n'),
      constraints: { poetryMode: 'on' },
      reportLanguage: 'en',
    })

    expect(report.boundaryWarnings).toEqual([])
  })

  it('flags dashes and semicolons that do not exist in the source', () => {
    const report = checkTranslationEvidence({
      direction: 'zh_to_en',
      sourceText: SOURCE,
      translatedText: [
        'Hard to meet, and hard to part — beyond all doubt,',
        'The east wind fades; the flowers fall.',
      ].join('\n'),
      constraints: { poetryMode: 'on' },
      reportLanguage: 'en',
    })

    expect(report.punctuationWarnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('introduces a dash'),
        expect.stringContaining('introduces a semicolon'),
      ]),
    )
    expect(report.summary).toBe('3 auxiliary warnings.')
  })

  it('ships all 106 Ping Shui groups with simplified and traditional lookup', () => {
    expect(PINGSHUI_GROUPS).toHaveLength(106)
    expect(findPingshuiGroups('難')).toContain('上平声十四寒')
    expect(findPingshuiGroups('难')).toContain('上平声十四寒')
    expect(findPingshuiGroups('殘')).toContain('上平声十四寒')
    expect(findPingshuiGroups('残')).toContain('上平声十四寒')
  })
})
