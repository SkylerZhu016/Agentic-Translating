import { describe, expect, it } from 'vitest'
import { checkTranslationEvidence } from '../../src/lib/evidence/checker'

describe('translation evidence checker', () => {
  it('reports Chinese line length, terms, stanza and rhyme evidence', () => {
    const report = checkTranslationEvidence({
      direction: 'en_to_zh',
      sourceText: 'Line one\n\nLine two 42',
      translatedText: '床前明月光\n疑是地上霜',
      constraints: {
        preserveStanzas: true,
        expectedStanzas: 2,
        targetCharsOrWordsPerLine: 5,
        requiredTerms: ['故乡'],
        forbiddenTerms: ['霜'],
        rhymeEvidence: true,
      },
    })
    expect(report.lines.map((line) => line.measure)).toEqual([5, 5])
    expect(report.lines[1].ending).toBe('霜')
    expect(report.lines[1].rhyme).toBeTruthy()
    expect(report.requiredTermsMissing).toEqual(['故乡'])
    expect(report.forbiddenTermsFound).toEqual(['霜'])
    expect(report.structureWarnings).toContain('预期 2 节，检测到 1 节')
    expect(report.caveat).toContain('不等同于平水韵裁决')
  })

  it('reports English word counts and unknown pronunciation explicitly', () => {
    const report = checkTranslationEvidence({
      direction: 'zh_to_en',
      sourceText: '明月\n故乡',
      translatedText: 'I see the moon\nI remember Qxyzname',
      constraints: { targetCharsOrWordsPerLine: 4 },
    })
    expect(report.lines.map((line) => line.measure)).toEqual([4, 3])
    expect(report.lines[0].rhyme).toBeTruthy()
    expect(report.lines[1].rhyme).toBeNull()
    expect(report.naturalLanguage).toContain('unknown')
    expect(report.caveat).toContain('modern-English pronunciation aids')
  })
})
