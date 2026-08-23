import { dictionary } from 'cmu-pronouncing-dictionary'
import { getInitialAndFinal, pinyin } from 'pinyin-pro'
import type {
  TranslationConstraints,
  TranslationDirection,
} from '../contracts/vnext'
import {
  analyzePoetrySource,
  type PoetryBoundaryKind,
} from '../poetry/analysis'
import { findPingshuiGroups } from './pingshui-data'

export interface EvidenceLine {
  lineNo: number
  stanzaNo: number
  text: string
  measure: number
  ending: string
  rhyme: string | null
  pingshuiGroups: string[]
  boundary: PoetryBoundaryKind
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
  punctuationWarnings: string[]
  rhymeWarnings: string[]
  boundaryWarnings: string[]
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

function punctuationBoundary(line: string): PoetryBoundaryKind {
  if (/[,，;；:：]\s*$/.test(line)) return 'continuation'
  if (/[.!?。！？]\s*$/.test(line)) return 'closure'
  return 'open'
}

function intersection(values: string[][]) {
  if (values.length === 0) return []
  return values.slice(1).reduce(
    (common, current) => common.filter((value) => current.includes(value)),
    [...values[0]],
  )
}

function numbers(text: string) {
  return text.match(/\d+(?:[.,]\d+)*/g) ?? []
}

function nonEmptyLinesWithStanzas(text: string) {
  const rows: Array<{ text: string; stanzaNo: number }> = []
  let stanzaNo = 1
  let pendingStanzaBreak = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) {
      if (rows.length > 0) pendingStanzaBreak = true
      continue
    }
    if (pendingStanzaBreak) {
      stanzaNo += 1
      pendingStanzaBreak = false
    }
    rows.push({ text: line, stanzaNo })
  }
  return rows
}

export function checkTranslationEvidence(input: {
  direction: TranslationDirection
  sourceText: string
  taskBrief?: string
  translatedText: string
  constraints?: TranslationConstraints
  reportLanguage?: 'zh' | 'en'
}): TranslationEvidenceReport {
  const constraints = input.constraints ?? {}
  const useEnglish =
    input.reportLanguage === 'en' ||
    (!input.reportLanguage && input.direction !== 'en_to_zh')
  const nonEmpty = nonEmptyLinesWithStanzas(input.translatedText)
  const lines = nonEmpty.map((row, index): EvidenceLine => {
    const line = row.text
    if (input.direction === 'en_to_zh') {
      const characters = Array.from(line.match(/[\p{Script=Han}]/gu) ?? [])
      const ending = characters.at(-1) ?? ''
      return {
        lineNo: index + 1,
        stanzaNo: row.stanzaNo,
        text: line,
        measure: characters.length,
        ending,
        rhyme: chineseRhyme(ending),
        pingshuiGroups: findPingshuiGroups(ending),
        boundary: punctuationBoundary(line),
      }
    }
    if (input.direction === 'custom') {
      const graphemes = Array.from(
        new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line),
        (item) => item.segment,
      )
      return {
        lineNo: index + 1,
        stanzaNo: row.stanzaNo,
        text: line,
        measure: graphemes.length,
        ending: graphemes.at(-1) ?? '',
        rhyme: null,
        pingshuiGroups: [],
        boundary: punctuationBoundary(line),
      }
    }
    const words = line.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? []
    const ending = words.at(-1)?.replace(/[’]/g, "'") ?? ''
    return {
      lineNo: index + 1,
      stanzaNo: row.stanzaNo,
      text: line,
      measure: words.length,
      ending,
      rhyme: englishRhyme(ending),
      pingshuiGroups: [],
      boundary: punctuationBoundary(line),
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
  const punctuationWarnings: string[] = []
  const rhymeWarnings: string[] = []
  const boundaryWarnings: string[] = []
  const sourceHasDash = /[—–]|——/.test(input.sourceText)
  const translationHasDash = /[—–]|——/.test(input.translatedText)
  const sourceHasSemicolon = /[;；]/.test(input.sourceText)
  const translationHasSemicolon = /[;；]/.test(input.translatedText)
  if (!sourceHasDash && translationHasDash) {
    punctuationWarnings.push(
      useEnglish
        ? 'The translation introduces a dash although the source contains no dash.'
        : '原文没有破折号，但译文新增了破折号。',
    )
  }
  if (!sourceHasSemicolon && translationHasSemicolon) {
    punctuationWarnings.push(
      useEnglish
        ? 'The translation introduces a semicolon although the source contains no semicolon.'
        : '原文没有分号，但译文新增了分号。',
    )
  }
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
  const poetry = analyzePoetrySource({
    direction: input.direction,
    sourceText: input.sourceText,
    taskBrief: input.taskBrief,
    constraints,
  })
  if (poetry.isPoetry) {
    if (poetry.lines.length !== lines.length) {
      structureWarnings.push(
        useEnglish
          ? `Source analysis found ${poetry.lines.length} poetic lines; the translation has ${lines.length} non-empty lines.`
          : `原文识别为 ${poetry.lines.length} 个诗句，译文有 ${lines.length} 个非空行。`,
      )
    }
    const comparable = Math.min(poetry.lines.length, lines.length)
    for (let index = 0; index < comparable; index++) {
      const sourceBoundary = poetry.lines[index].boundary
      const targetBoundary = lines[index].boundary
      if (sourceBoundary === 'continuation' && targetBoundary === 'closure') {
        boundaryWarnings.push(
          useEnglish
            ? `Line ${index + 1} continues in the source but ends with sentence-closing punctuation in the translation.`
            : `第 ${index + 1} 行在原文中仍然延续，但译文使用了句末终止标点。`,
        )
      } else if (
        sourceBoundary === 'closure' &&
        targetBoundary === 'continuation'
      ) {
        boundaryWarnings.push(
          useEnglish
            ? `Line ${index + 1} closes in the source but remains syntactically open in the translation.`
            : `第 ${index + 1} 行在原文中已经收束，但译文仍使用延续标点。`,
        )
      }
    }

    const enforceRhyme =
      poetry.rhymeRequirement === 'explicit' ||
      poetry.rhymeRequirement === 'source-stable'
    const schemeLabels = poetry.suggestedScheme
      .replace(/[^A-Za-z]/g, '')
      .slice(0, lines.length)
    const labelledGroups = new Map<string, number[]>()
    for (const lineNo of poetry.suggestedRhymeLines) {
      const label = schemeLabels[lineNo - 1]?.toUpperCase() || 'A'
      if (label === 'X') continue
      const stanzaNo = poetry.lines[lineNo - 1]?.stanzaNo ?? 1
      const groupKey = constraints.rhymeChange === 'by_stanza'
        ? `${stanzaNo}:${label}`
        : label
      labelledGroups.set(groupKey, [
        ...(labelledGroups.get(groupKey) ?? []),
        lineNo,
      ])
    }
    if (enforceRhyme) {
      for (const [groupKey, lineNumbers] of labelledGroups) {
        const label = groupKey.includes(':')
          ? groupKey.slice(groupKey.indexOf(':') + 1)
          : groupKey
        const rhymeLines = lineNumbers
          .map((lineNo) => lines[lineNo - 1])
          .filter((line): line is EvidenceLine => Boolean(line))
        if (rhymeLines.length < 2) continue
        if (input.direction === 'en_to_zh') {
          const system = constraints.chineseRhymeSystem ?? 'mandarin'
          const knownMandarin = rhymeLines
            .map((line) => line.rhyme)
            .filter((rhyme): rhyme is string => Boolean(rhyme))
          const mandarinMatches =
            knownMandarin.length === rhymeLines.length &&
            new Set(knownMandarin).size === 1
          const knownPingshui = rhymeLines.map((line) => line.pingshuiGroups)
          const pingshuiMatches =
            knownPingshui.every((groups) => groups.length > 0) &&
            intersection(knownPingshui).length > 0
          if (
            (system === 'mandarin' || system === 'dual') &&
            !mandarinMatches
          ) {
            rhymeWarnings.push(
              `普通话检查：${label} 韵位第 ${lineNumbers.join('、')} 行的韵母未保持一致。`,
            )
          }
          if (
            (system === 'pingshui' || system === 'dual') &&
            !pingshuiMatches
          ) {
            rhymeWarnings.push(
              `平水韵检查：${label} 韵位第 ${lineNumbers.join('、')} 行未找到共同韵部，或存在未识别韵脚。`,
            )
          }
        } else if (
          input.direction === 'zh_to_en' &&
          constraints.englishRhymeMode === 'exact'
        ) {
          const known = rhymeLines
            .map((line) => line.rhyme)
            .filter((rhyme): rhyme is string => Boolean(rhyme))
          if (
            known.length !== rhymeLines.length ||
            new Set(known).size !== 1
          ) {
            rhymeWarnings.push(
              `Exact-rhyme check: ${label}-rhyme lines ${lineNumbers.join(', ')} do not share one known pronunciation signature.`,
            )
          }
        }
      }
    }
  }
  const warningCount =
    requiredTermsMissing.length +
    forbiddenTermsFound.length +
    numberWarnings.length +
    structureWarnings.length +
    punctuationWarnings.length +
    rhymeWarnings.length +
    boundaryWarnings.length
  const caveat =
    input.direction === 'en_to_zh'
      ? constraints.chineseRhymeSystem === 'pingshui' ||
        constraints.chineseRhymeSystem === 'dual'
        ? '平水韵结果来自内置一百零六韵字表；普通话听感、古今音变化、多音字和通韵变体仍需人工复核。'
        : '普通话拼音韵母仅为现代听感辅助证据，不等同于平水韵裁决；多音字和古典韵部仍需人工复核。'
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
          ...punctuationWarnings,
          ...boundaryWarnings,
          ...rhymeWarnings,
          `Line-ending evidence: ${lines
            .map(
              (line) =>
                `${line.lineNo}:${line.ending || 'unknown'}/${line.rhyme ?? 'unknown'}` +
                (line.pingshuiGroups.length
                  ? `/PingShui=${line.pingshuiGroups.join('|')}`
                  : ''),
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
          ...punctuationWarnings,
          ...boundaryWarnings,
          ...rhymeWarnings,
          `行末证据：${lines
            .map(
              (line) =>
                `${line.lineNo}:${line.ending || '未知'}/${line.rhyme ?? '未知'}` +
                (line.pingshuiGroups.length
                  ? `/平水=${line.pingshuiGroups.join('|')}`
                  : ''),
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
    punctuationWarnings,
    rhymeWarnings,
    boundaryWarnings,
    caveat,
    summary,
    naturalLanguage,
  }
}
