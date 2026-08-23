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

  it('does not report missing rhyme for weak-rhyme free verse', () => {
    const report = checkTranslationEvidence({
      direction: 'en_to_zh',
      sourceText: 'Stone\nWindow\nHall\nElsewhere',
      translatedText: '石头\n窗户\n大厅\n别处',
      constraints: { poetryMode: 'on', rhymePositions: 'auto' },
    })

    expect(report.rhymeWarnings).toEqual([])
  })

  it('keeps deterministic rhyme evidence active for an explicit scheme', () => {
    const report = checkTranslationEvidence({
      direction: 'en_to_zh',
      sourceText: 'Stone\nWindow\nHall\nElsewhere',
      taskBrief: '请把四行全部押同一韵。',
      translatedText: '石头\n窗户\n大厅\n别处',
      constraints: {
        poetryMode: 'on',
        rhymePositions: 'all_lines',
        rhymeScheme: 'AAAA',
      },
    })

    expect(report.rhymeWarnings).not.toEqual([])
  })

  it('checks a scheme supplied only through the task brief on the default auto path', () => {
    const report = checkTranslationEvidence({
      direction: 'en_to_zh',
      sourceText: 'One\nTwo\nThree\nFour',
      taskBrief: 'Use an AABB rhyme scheme.',
      translatedText: '远山\n明月\n长风\n流水',
      constraints: { poetryMode: 'on', rhymePositions: 'auto' },
    })

    expect(report.rhymeWarnings).not.toEqual([])
  })

  it.each([
    'Use AABB if meaning permits.',
    'AABB optional.',
  ])('does not enforce a conditional task-brief scheme: %s', (taskBrief) => {
    const report = checkTranslationEvidence({
      direction: 'en_to_zh',
      sourceText: 'Day\nSay\nNight\nLight',
      taskBrief,
      translatedText: '远山\n明月\n长风\n流水',
      constraints: { poetryMode: 'on', rhymePositions: 'auto' },
    })

    expect(report.rhymeWarnings).toEqual([])
  })

  it('rejects a named scheme without disabling a different stable source scheme', () => {
    const report = checkTranslationEvidence({
      direction: 'en_to_zh',
      sourceText: 'Day\nNight\nSay\nLight',
      taskBrief: 'Do not use AABB.',
      translatedText: '远山\n明月\n长风\n流水',
      constraints: { poetryMode: 'on', rhymePositions: 'auto' },
    })

    expect(report.rhymeWarnings).not.toEqual([])
  })

  it('does not enforce a rejected scheme even when the source stably uses it', () => {
    const report = checkTranslationEvidence({
      direction: 'en_to_zh',
      sourceText: 'Day\nSay\nNight\nLight',
      taskBrief: 'Do not use AABB.',
      translatedText: '远山\n明月\n长风\n流水',
      constraints: { poetryMode: 'on', rhymePositions: 'auto' },
    })

    expect(report.rhymeWarnings).toEqual([])
  })

  it('does not enforce a rejected per-stanza scheme with fresh rhyme sounds', () => {
    const report = checkTranslationEvidence({
      direction: 'en_to_zh',
      sourceText:
        'Day\nSay\nNight\nLight\n\nMore\nShore\nBlue\nTrue',
      taskBrief: 'Do not use AABB.',
      translatedText:
        '远山\n明月\n长风\n流水\n\n云层\n青天\n归客\n孤舟',
      constraints: { poetryMode: 'on', rhymePositions: 'auto' },
    })

    expect(report.rhymeWarnings).toEqual([])
  })

  it('checks explicit rhyme independently inside each stanza', () => {
    const input = {
      direction: 'en_to_zh' as const,
      sourceText: 'One\nTwo\nThree\nFour\n\nFive\nSix\nSeven\nEight',
      taskBrief: 'Use an AABB rhyme scheme in each stanza.',
      constraints: {
        poetryMode: 'on' as const,
        rhymePositions: 'auto' as const,
        rhymeScheme: 'AABB',
        rhymeChange: 'by_stanza' as const,
      },
    }
    const matching = checkTranslationEvidence({
      ...input,
      translatedText: '远山\n回看\n长风\n新生\n\n青天\n天边\n流水\n同归',
    })
    const broken = checkTranslationEvidence({
      ...input,
      translatedText: '远山\n回看\n长风\n新生\n\n青天\n天边\n流水\n明月',
    })

    expect(matching.rhymeWarnings).toEqual([])
    expect(broken.rhymeWarnings).not.toEqual([])
  })

  it.each(['source', 'custom'] as const)(
    'does not skip multi-stanza rhyme checks in %s change mode',
    (rhymeChange) => {
      const report = checkTranslationEvidence({
        direction: 'en_to_zh',
        sourceText: 'One\nTwo\nThree\nFour\n\nFive\nSix\nSeven\nEight',
        taskBrief: 'Use an AABB rhyme scheme.',
        translatedText:
          '远山\n明月\n长风\n流水\n\n青天\n天边\n归客\n孤舟',
        constraints: {
          poetryMode: 'on',
          rhymePositions: 'auto',
          rhymeScheme: 'AABB',
          rhymeChange,
        },
      })

      expect(report.rhymeWarnings).not.toEqual([])
    },
  )

  it('checks a source-stable even-line rhyme pattern across multiple stanzas', () => {
    const base = {
      direction: 'en_to_zh' as const,
      sourceText:
        'Stone\nDay\nWindow\nSay\n\nCloud\nNight\nRoad\nLight',
      constraints: {
        poetryMode: 'on' as const,
        rhymePositions: 'auto' as const,
        rhymeChange: 'by_stanza' as const,
      },
    }
    const matching = checkTranslationEvidence({
      ...base,
      translatedText:
        '岩石\n远山\n窗户\n回看\n\n云层\n青天\n长路\n天边',
    })
    const broken = checkTranslationEvidence({
      ...base,
      translatedText:
        '岩石\n远山\n窗户\n回看\n\n云层\n青天\n长路\n明月',
    })

    expect(matching.rhymeWarnings).toEqual([])
    expect(broken.rhymeWarnings).not.toEqual([])
  })
})
