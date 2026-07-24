import { dictionary } from 'cmu-pronouncing-dictionary'
import { getInitialAndFinal, pinyin } from 'pinyin-pro'
import type {
  TranslationConstraints,
  TranslationDirection,
} from '../contracts/vnext'

export interface EvidenceLine {
  lineNo: number
  text: string
  measure: number
  ending: string
  rhyme: string | null
}

export interface TranslationEvidenceReport {
  direction: TranslationDirection
  stanzaCount: number
  nonEmptyLineCount: number
  lines: EvidenceLine[]
  requiredTermsMissing: string[]
  forbiddenTermsFound: string[]
  numberWarnings: string[]
  structureWarnings: string[]
  caveat: string
  summary: string
  naturalLanguage: string
}

function englishRhyme(word: string): string | null {
  const pronunciation = dictionary[word.toLowerCase()]
  if (!pronunciation) return null
  const phones = pronunciation
    .replace(/\s+#.*$/, '')
    .split(/\s+/)
    .filter(Boolean)
  let vowelIndex = -1
  for (let index = phones.length - 1; index >= 0; index--) {
    if (/[012]$/.test(phones[index])) {
      vowelIndex = index
      if (/[12]$/.test(phones[index])) break
    }
  }
  if (vowelIndex < 0) return null
  return phones.slice(vowelIndex).map((phone) => phone.replace(/[012]/g, '')).join('-')
}

function chineseRhyme(character: string): string | null {
  if (!character) return null
  const value = pinyin(character, { toneType: 'none' })
  if (!value || value === character) return null
  return getInitialAndFinal(value).final || null
}

function stanzaCount(text: string) {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\r?\n\s*\r?\n+/).length : 0
}

function numbers(text: string) {
  return text.match(/\d+(?:[.,]\d+)*/g) ?? []
}

export function checkTranslationEvidence(input: {
  direction: TranslationDirection
  sourceText: string
  translatedText: string
  constraints?: TranslationConstraints
  reportLanguage?: 'zh' | 'en'
}): TranslationEvidenceReport {
  const constraints = input.constraints ?? {}
  const useEnglish =
    input.reportLanguage === 'en' ||
    (!input.reportLanguage && input.direction !== 'en_to_zh')
  const nonEmpty = input.translatedText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const lines = nonEmpty.map((line, index): EvidenceLine => {
    if (input.direction === 'en_to_zh') {
      const characters = Array.from(line.match(/[\p{Script=Han}]/gu) ?? [])
      const ending = characters.at(-1) ?? ''
      return {
        lineNo: index + 1,
        text: line,
        measure: characters.length,
        ending,
        rhyme: chineseRhyme(ending),
      }
    }
    if (input.direction === 'custom') {
      const graphemes = Array.from(
        new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line),
        (item) => item.segment,
      )
      return {
        lineNo: index + 1,
        text: line,
        measure: graphemes.length,
        ending: graphemes.at(-1) ?? '',
        rhyme: null,
      }
    }
    const words = line.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? []
    const ending = words.at(-1)?.replace(/[’]/g, "'") ?? ''
    return {
      lineNo: index + 1,
      text: line,
      measure: words.length,
      ending,
      rhyme: englishRhyme(ending),
    }
  })
  const requiredTermsMissing = (constraints.requiredTerms ?? []).filter(
    (term) => term && !input.translatedText.includes(term),
  )
  const forbiddenTermsFound = (constraints.forbiddenTerms ?? []).filter(
    (term) => term && input.translatedText.includes(term),
  )
  const sourceNumbers = numbers(input.sourceText)
  const targetNumbers = new Set(numbers(input.translatedText))
  const numberWarnings = sourceNumbers
    .filter((number) => !targetNumbers.has(number))
    .map((number) =>
      useEnglish
        ? `Source number ${number} was not found verbatim in the translation.`
        : `原文数字 ${number} 未在译文中直接找到`,
    )
  const translatedStanzas = stanzaCount(input.translatedText)
  const structureWarnings: string[] = []
  if (
    constraints.expectedStanzas &&
    translatedStanzas !== constraints.expectedStanzas
  ) {
    structureWarnings.push(
      useEnglish
        ? `Expected ${constraints.expectedStanzas} stanzas; detected ${translatedStanzas}.`
        : `预期 ${constraints.expectedStanzas} 节，检测到 ${translatedStanzas} 节`,
    )
  }
  if (constraints.preserveStanzas) {
    const sourceStanzas = stanzaCount(input.sourceText)
    if (sourceStanzas !== translatedStanzas) {
      structureWarnings.push(
        useEnglish
          ? `Source has ${sourceStanzas} stanzas; translation has ${translatedStanzas}.`
          : `原文 ${sourceStanzas} 节，译文 ${translatedStanzas} 节`,
      )
    }
  }
  if (constraints.targetCharsOrWordsPerLine) {
    const mismatched = lines
      .filter((line) => line.measure !== constraints.targetCharsOrWordsPerLine)
      .map((line) => line.lineNo)
    if (mismatched.length) {
      structureWarnings.push(
        useEnglish
          ? `Lines ${mismatched.join(', ')} do not contain ${constraints.targetCharsOrWordsPerLine} English words.`
          : `第 ${mismatched.join('、')} 行不符合每行 ${constraints.targetCharsOrWordsPerLine} 个汉字`,
      )
    }
  }
  const warningCount =
    requiredTermsMissing.length +
    forbiddenTermsFound.length +
    numberWarnings.length +
    structureWarnings.length
  const caveat =
    input.direction === 'en_to_zh'
      ? '普通话拼音韵母仅为韵脚辅助证据，不等同于平水韵裁决；多音字可能需要人工复核。'
      : input.direction === 'custom'
        ? 'Custom-direction evidence is limited to generic structural and terminology checks.'
      : 'Rhyme signatures are modern-English pronunciation aids only; unknown names and dialectal readings require human review.'
  const summary =
    useEnglish
      ? warningCount === 0
        ? 'No deterministic constraint warnings were found.'
        : `${warningCount} auxiliary warnings.`
      : warningCount === 0
        ? '未发现确定性约束警告'
        : `${warningCount} 项辅助警告`
  const naturalLanguage =
    useEnglish
      ? [
          summary,
          `${translatedStanzas} stanzas and ${lines.length} non-empty lines detected.`,
          requiredTermsMissing.length
            ? `Required terms missing: ${requiredTermsMissing.join(', ')}.`
            : '',
          forbiddenTermsFound.length
            ? `Forbidden terms found: ${forbiddenTermsFound.join(', ')}.`
            : '',
          ...numberWarnings,
          ...structureWarnings,
          `Line-ending evidence: ${lines
            .map(
              (line) =>
                `${line.lineNo}:${line.ending || 'unknown'}/${line.rhyme ?? 'unknown'}`,
            )
            .join('; ')}`,
          caveat,
        ].filter(Boolean).join('\n')
      : [
          summary,
          `节数 ${translatedStanzas}，非空行 ${lines.length}。`,
          requiredTermsMissing.length
            ? `缺少必须术语：${requiredTermsMissing.join('、')}。`
            : '',
          forbiddenTermsFound.length
            ? `发现禁用词：${forbiddenTermsFound.join('、')}。`
            : '',
          ...numberWarnings,
          ...structureWarnings,
          `行末证据：${lines
            .map(
              (line) =>
                `${line.lineNo}:${line.ending || '未知'}/${line.rhyme ?? '未知'}`,
            )
            .join('；')}`,
          caveat,
        ].filter(Boolean).join('\n')
  return {
    direction: input.direction,
    stanzaCount: translatedStanzas,
    nonEmptyLineCount: lines.length,
    lines,
    requiredTermsMissing,
    forbiddenTermsFound,
    numberWarnings,
    structureWarnings,
    caveat,
    summary,
    naturalLanguage,
  }
}
