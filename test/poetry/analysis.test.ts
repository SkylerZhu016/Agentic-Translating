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
    expect(analysis.sourceRhymeStable).toBe(true)
    expect(analysis.rhymeRequirement).toBe('source-stable')
  })

  it('does not invent rhyme positions for weak-rhyme free verse', () => {
    const analysis = analyzePoetrySource({
      sourceText: [
        'A hand rests on the stone',
        'Rain opens the window',
        'Someone waits in the hall',
        'The answer remains elsewhere',
      ].join('\n'),
      constraints: { poetryMode: 'on', rhymePositions: 'auto' },
    })

    expect(analysis.rhymeRequirement).toBe('conditional')
    expect(analysis.sourceRhymeStable).toBe(false)
    expect(analysis.suggestedRhymeLines).toEqual([])
    expect(analysis.suggestedScheme).toBe('xxxx')
  })

  it('keeps an explicit rhyme request binding even when source rhyme is weak', () => {
    const analysis = analyzePoetrySource({
      sourceText: 'Stone\nWindow\nHall\nElsewhere',
      taskBrief: 'Use an AABB rhyme scheme.',
      constraints: { poetryMode: 'on', rhymePositions: 'all_lines' },
    })

    expect(analysis.rhymeRequirement).toBe('explicit')
    expect(analysis.suggestedRhymeLines).toEqual([1, 2, 3, 4])
  })

  it('derives non-empty rhyme positions from an explicit scheme in auto mode', () => {
    const analysis = analyzePoetrySource({
      direction: 'en_to_zh',
      sourceText: 'Stone\nWindow\nHall\nElsewhere',
      constraints: {
        poetryMode: 'on',
        rhymePositions: 'auto',
        rhymeScheme: 'AABB',
      },
    })

    expect(analysis.rhymeRequirement).toBe('explicit')
    expect(analysis.suggestedRhymeLines).toEqual([1, 2, 3, 4])
    expect(analysis.suggestedScheme).toBe('AABB')
  })

  it('extracts and repeats a rhyme scheme supplied only in the task brief', () => {
    const analysis = analyzePoetrySource({
      direction: 'en_to_zh',
      sourceText:
        'One\nTwo\nThree\nFour\n\nFive\nSix\nSeven\nEight',
      taskBrief: 'Use an AABB rhyme scheme in each stanza.',
      constraints: { poetryMode: 'on', rhymePositions: 'auto' },
    })

    expect(analysis.rhymeRequirement).toBe('explicit')
    expect(analysis.suggestedRhymeLines).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(analysis.suggestedScheme).toBe('AABBAABB')
  })

  it.each([
    'Use AABB if meaning permits.',
    'AABB optional.',
  ])('keeps a task-brief scheme conditional when its semantics are conditional: %s', (taskBrief) => {
    const analysis = analyzePoetrySource({
      direction: 'en_to_zh',
      sourceText: 'Stone\nWindow\nHall\nElsewhere',
      taskBrief,
      constraints: { poetryMode: 'on', rhymePositions: 'auto' },
    })

    expect(analysis.rhymeRequirement).toBe('conditional')
    expect(analysis.suggestedScheme).toBe('AABB')
  })

  it('rejects only the named task-brief scheme while preserving a different stable source scheme', () => {
    const analysis = analyzePoetrySource({
      direction: 'en_to_zh',
      sourceText: 'Day\nNight\nSay\nLight',
      taskBrief: 'Do not use AABB.',
      constraints: { poetryMode: 'on', rhymePositions: 'auto' },
    })

    expect(analysis.sourceRhymeStable).toBe(true)
    expect(analysis.rhymeRequirement).toBe('source-stable')
    expect(analysis.suggestedRhymeLines).toEqual([1, 2, 3, 4])
    expect(analysis.suggestedScheme).toBe('ABAB')
  })

  it('does not restore a rejected scheme from an identical stable source scheme', () => {
    const analysis = analyzePoetrySource({
      direction: 'en_to_zh',
      sourceText: 'Day\nSay\nNight\nLight',
      taskBrief: 'Do not use AABB.',
      constraints: { poetryMode: 'on', rhymePositions: 'auto' },
    })

    expect(analysis.sourceRhymeStable).toBe(true)
    expect(analysis.rhymeRequirement).toBe('conditional')
    expect(analysis.suggestedRhymeLines).toEqual([])
    expect(analysis.suggestedScheme).toBe('xxxx')
  })

  it('recognizes the same rejected scheme when rhyme labels reset by stanza', () => {
    const analysis = analyzePoetrySource({
      direction: 'en_to_zh',
      sourceText:
        'Day\nSay\nNight\nLight\n\nMore\nShore\nBlue\nTrue',
      taskBrief: 'Do not use AABB.',
      constraints: { poetryMode: 'on', rhymePositions: 'auto' },
    })

    expect(analysis.sourceRhymeStable).toBe(true)
    expect(analysis.rhymeRequirement).toBe('conditional')
    expect(analysis.suggestedRhymeLines).toEqual([])
    expect(analysis.suggestedScheme).toBe('xxxxxxxx')
  })

  it('keeps a structured rhymeScheme explicit without task-brief wording', () => {
    const analysis = analyzePoetrySource({
      direction: 'en_to_zh',
      sourceText: 'Stone\nWindow\nHall\nElsewhere',
      constraints: {
        poetryMode: 'on',
        rhymePositions: 'auto',
        rhymeScheme: 'ABAB',
      },
    })

    expect(analysis.rhymeRequirement).toBe('explicit')
    expect(analysis.suggestedScheme).toBe('ABAB')
  })

  it('normalizes grouped A-Z rhyme labels and rejects overlong schemes', () => {
    const grouped = analyzePoetrySource({
      direction: 'en_to_zh',
      sourceText: Array.from({ length: 14 }, (_, index) => `Line ${index + 1}`).join('\n'),
      taskBrief: 'Use an abab cdcd efef gg rhyme scheme.',
      constraints: { poetryMode: 'on', rhymePositions: 'auto' },
    })
    const overlong = analyzePoetrySource({
      direction: 'en_to_zh',
      sourceText: 'Stone\nWindow\nHall\nElsewhere',
      taskBrief: `Use ${'A'.repeat(65)} rhyme scheme.`,
      constraints: { poetryMode: 'on', rhymePositions: 'auto' },
    })

    expect(grouped.rhymeRequirement).toBe('explicit')
    expect(grouped.suggestedScheme).toBe('ABABCDCDEFEFGG')
    expect(grouped.suggestedRhymeLines).toHaveLength(14)
    expect(overlong.suggestedScheme).not.toContain('A'.repeat(65))
  })

  it('recognizes stable even-line rhyme without requiring sixty-percent whole-poem coverage', () => {
    const fourLines = analyzePoetrySource({
      direction: 'zh_to_en',
      sourceText: '远山\n长风\n明月\n新声',
      constraints: { poetryMode: 'on', rhymePositions: 'auto' },
    })
    const eightLines = analyzePoetrySource({
      direction: 'zh_to_en',
      sourceText: '远山\n长风\n明月\n新声\n孤舟\n孤灯\n归客\n云峰',
      constraints: { poetryMode: 'on', rhymePositions: 'auto' },
    })

    expect(fourLines.rhymeRequirement).toBe('source-stable')
    expect(fourLines.suggestedRhymeLines).toEqual([2, 4])
    expect(fourLines.suggestedScheme).toBe('xAxA')
    expect(eightLines.rhymeRequirement).toBe('source-stable')
    expect(eightLines.suggestedRhymeLines).toEqual([2, 4, 6, 8])
    expect(eightLines.suggestedScheme).toBe('xAxAxAxA')
  })

  it('parses Chinese rhyme requirements clause by clause without promoting conditional language', () => {
    const analyze = (taskBrief: string) => analyzePoetrySource({
      direction: 'en_to_zh',
      sourceText: 'Stone\nWindow\nHall\nElsewhere',
      taskBrief,
      constraints: { poetryMode: 'on' },
    }).rhymeRequirement

    expect(analyze('不要求逐行对应，但要押韵。')).toBe('explicit')
    expect(analyze('如不损原意，可押韵。')).toBe('conditional')
    expect(analyze('不要强行押韵，以自然为先。')).toBe('conditional')
    expect(analyze('不要押韵。')).toBe('none')
  })

  it('parses English conditional and adversative rhyme clauses conservatively', () => {
    const analyze = (taskBrief: string) => analyzePoetrySource({
      direction: 'en_to_zh',
      sourceText: 'Stone\nWindow\nHall\nElsewhere',
      taskBrief,
      constraints: { poetryMode: 'on' },
    }).rhymeRequirement

    expect(analyze('Do not force rhyme; keep the English ambiguity open.')).toBe(
      'conditional',
    )
    expect(analyze('Use rhyme if meaning permits.')).toBe('conditional')
    expect(analyze('Do not mirror every line, but use an AABB rhyme scheme.')).toBe(
      'explicit',
    )
  })

  it.each([
    '无韵',
    '不要使用押韵',
    'No rhyme',
    'No rhyme, please.',
    'Please do not use rhyme.',
    'Never add rhyme',
  ])('keeps a pure task-brief rhyme ban above stable source form: %s', (taskBrief) => {
    const analysis = analyzePoetrySource({
      direction: 'en_to_zh',
      sourceText: 'Day\nSay\nNight\nLight',
      taskBrief,
      constraints: { poetryMode: 'on', rhymePositions: 'auto' },
    })

    expect(analysis.sourceRhymeStable).toBe(true)
    expect(analysis.rhymeRequirement).toBe('none')
    expect(analysis.suggestedRhymeLines).toEqual([])
    expect(analysis.suggestedScheme).toBe('xxxx')
  })

  it('separates one-rhyme, form-priority, and metered settings', () => {
    const sourceText = 'Stone\nWindow\nHall\nElsewhere'
    const singleRhyme = analyzePoetrySource({
      direction: 'en_to_zh',
      sourceText,
      constraints: { poetryMode: 'on', rhymeChange: 'single' },
    })
    const formPriority = analyzePoetrySource({
      direction: 'en_to_zh',
      sourceText,
      constraints: { poetryMode: 'on', poetryPriority: 'form' },
    })
    const meteredOnly = analyzePoetrySource({
      direction: 'en_to_zh',
      sourceText,
      taskBrief: 'Produce measured, metered verse.',
      constraints: { poetryMode: 'on' },
    })

    expect(singleRhyme.rhymeRequirement).toBe('explicit')
    expect(singleRhyme.suggestedRhymeLines).toEqual([2, 4])
    expect(formPriority.rhymeRequirement).toBe('conditional')
    expect(meteredOnly.rhymeRequirement).toBe('conditional')
  })

  it('applies englishRhymeMode only to Chinese-to-English translation', () => {
    const sourceText = 'Stone\nWindow\nHall\nElsewhere'
    const ignoredExact = analyzePoetrySource({
      direction: 'en_to_zh',
      sourceText,
      constraints: { poetryMode: 'on', englishRhymeMode: 'exact' },
    })
    const ignoredNone = analyzePoetrySource({
      direction: 'en_to_zh',
      sourceText,
      constraints: { poetryMode: 'on', englishRhymeMode: 'none' },
    })
    const appliedExact = analyzePoetrySource({
      direction: 'zh_to_en',
      sourceText: '远山\n长路\n明月\n孤舟',
      constraints: { poetryMode: 'on', englishRhymeMode: 'exact' },
    })

    expect(ignoredExact.rhymeRequirement).toBe('conditional')
    expect(ignoredNone.rhymeRequirement).toBe('conditional')
    expect(appliedExact.rhymeRequirement).toBe('explicit')
  })

  it('honours an explicit free-verse target even when the source rhymes', () => {
    const analysis = analyzePoetrySource({
      sourceText: 'Day\nSay\nNight\nLight',
      taskBrief: 'Translate as free verse without rhyme.',
      constraints: { poetryMode: 'on', poetryTargetForm: 'free_verse' },
    })

    expect(analysis.sourceRhymeStable).toBe(true)
    expect(analysis.rhymeRequirement).toBe('none')
    expect(analysis.suggestedRhymeLines).toEqual([])
    expect(analysis.suggestedScheme).toBe('xxxx')
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
