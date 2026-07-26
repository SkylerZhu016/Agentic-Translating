import { getInitialAndFinal, pinyin } from 'pinyin-pro'
import type {
  TranslationConstraints,
  TranslationDirection,
} from '../contracts/vnext'

export type PoetryBoundaryKind = 'continuation' | 'closure' | 'open'

export interface PoetrySourceLine {
  lineNo: number
  text: string
  punctuation: string
  boundary: PoetryBoundaryKind
}

export interface PoetrySourceAnalysis {
  isPoetry: boolean
  reason: string
  lines: PoetrySourceLine[]
  stanzaCount: number
  suggestedRhymeLines: number[]
  suggestedScheme: string
}

const POETRY_TERMS =
  /诗|词|曲|韵|格律|古体|近体|绝句|律诗|poem|poetry|verse|rhyme|meter|stanza/i
const LYRIC_TERMS = /歌词|填词|演唱|旋律|lyrics?|singable|melody/i

function boundaryOf(punctuation: string): PoetryBoundaryKind {
  if (/[,，;；:：]$/.test(punctuation)) return 'continuation'
  if (/[.!?。！？]$/.test(punctuation)) return 'closure'
  return 'open'
}

function splitContinuouslyTypesetChinese(sourceText: string): PoetrySourceLine[] {
  const lines: PoetrySourceLine[] = []
  const matcher = /([^，。！？；\r\n]+?)([，。！？；]|$)/gu
  for (const match of sourceText.matchAll(matcher)) {
    const text = match[1].trim()
    if (!text) continue
    const punctuation = match[2] ?? ''
    lines.push({
      lineNo: lines.length + 1,
      text,
      punctuation,
      boundary: boundaryOf(punctuation),
    })
  }
  return lines
}

function splitWrittenLines(sourceText: string): PoetrySourceLine[] {
  return sourceText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const punctuation = line.match(/[,，;；:：.!?。！？]+$/u)?.[0] ?? ''
      return {
        lineNo: index + 1,
        text: punctuation ? line.slice(0, -punctuation.length).trimEnd() : line,
        punctuation,
        boundary: boundaryOf(punctuation),
      }
    })
}

function stanzaCount(sourceText: string) {
  const trimmed = sourceText.trim()
  return trimmed ? trimmed.split(/\r?\n\s*\r?\n+/).length : 0
}

function finalHan(text: string) {
  return Array.from(text.match(/[\p{Script=Han}]/gu) ?? []).at(-1) ?? ''
}

function mandarinFinal(character: string) {
  if (!character) return null
  const reading = pinyin(character, { toneType: 'none' })
  if (!reading || reading === character) return null
  return getInitialAndFinal(reading).final || null
}

function firstLineAppearsToRhyme(lines: PoetrySourceLine[]) {
  if (lines.length < 2) return false
  const first = mandarinFinal(finalHan(lines[0].text))
  const second = mandarinFinal(finalHan(lines[1].text))
  return Boolean(first && second && first === second)
}

function suggestedRhymeLines(
  lines: PoetrySourceLine[],
  constraints: TranslationConstraints,
) {
  if (constraints.rhymePositions === 'custom') {
    const explicit = [...new Set(constraints.customRhymeLines ?? [])]
      .filter((line) => line > 0 && line <= lines.length)
      .sort((a, b) => a - b)
    if (explicit.length > 0) return explicit
    const scheme = (constraints.rhymeScheme ?? '')
      .replace(/[^A-Za-z]/g, '')
      .slice(0, lines.length)
    if (scheme.length > 0) {
      return [...scheme]
        .map((label, index) => ({ label, lineNo: index + 1 }))
        .filter(({ label }) => label.toLowerCase() !== 'x')
        .map(({ lineNo }) => lineNo)
    }
    return []
  }
  if (constraints.rhymePositions === 'all_lines') {
    return lines.map((line) => line.lineNo)
  }
  const even = lines
    .filter((line) => line.lineNo % 2 === 0)
    .map((line) => line.lineNo)
  if (
    constraints.firstLineRhyme === 'yes' ||
    (constraints.firstLineRhyme !== 'no' && firstLineAppearsToRhyme(lines))
  ) {
    return [1, ...even]
  }
  return even
}

function schemeFor(lines: PoetrySourceLine[], rhymeLines: number[]) {
  const rhyming = new Set(rhymeLines)
  return lines.map((line) => (rhyming.has(line.lineNo) ? 'A' : 'x')).join('')
}

export function analyzePoetrySource(input: {
  sourceText: string
  taskBrief?: string
  constraints?: TranslationConstraints
}): PoetrySourceAnalysis {
  const constraints = input.constraints ?? {}
  const writtenLines = splitWrittenLines(input.sourceText)
  const containsHan = /[\p{Script=Han}]/u.test(input.sourceText)
  const punctuationPhrases = containsHan
    ? splitContinuouslyTypesetChinese(input.sourceText)
    : []
  const lines =
    writtenLines.length >= 2
      ? writtenLines
      : punctuationPhrases.length >= 4
        ? punctuationPhrases
        : writtenLines
  const compactHanLengths = lines.map(
    (line) => line.text.match(/[\p{Script=Han}]/gu)?.length ?? 0,
  )
  const classicalShape =
    lines.length >= 4 &&
    compactHanLengths.filter((length) => length === 5 || length === 7).length >=
      Math.ceil(lines.length * 0.75)
  const termSignal = POETRY_TERMS.test(
    `${input.taskBrief ?? ''}\n${input.sourceText}`,
  )
  const lineSignal = writtenLines.length >= 4
  const mode = constraints.poetryMode ?? 'auto'
  const isPoetry =
    mode === 'on' ||
    (mode !== 'off' && (termSignal || classicalShape || lineSignal))
  const reason =
    mode === 'on'
      ? '用户明确启用诗歌专项'
      : mode === 'off'
        ? '用户明确关闭诗歌专项'
        : classicalShape
          ? '检测到五言或七言为主的连续诗句'
          : termSignal
            ? '原文或任务要求含有诗歌形式信号'
            : lineSignal
              ? '检测到多行诗体排版'
              : '未检测到足够强的诗歌信号'
  const rhymeLines = suggestedRhymeLines(lines, constraints)
  return {
    isPoetry,
    reason,
    lines,
    stanzaCount: stanzaCount(input.sourceText),
    suggestedRhymeLines: rhymeLines,
    suggestedScheme:
      constraints.rhymeScheme?.trim() || schemeFor(lines, rhymeLines),
  }
}

export function poetrySettingsText(
  direction: TranslationDirection,
  constraints: TranslationConstraints,
  language: 'zh' | 'en',
) {
  const settings =
    direction === 'en_to_zh'
      ? {
          form: constraints.poetryTargetForm ?? 'preserve',
          rhymeSystem: constraints.chineseRhymeSystem ?? 'mandarin',
          rhymeMode: 'not-applicable',
        }
      : {
          form: constraints.poetryTargetForm ?? 'preserve',
          rhymeSystem: 'not-applicable',
          rhymeMode: constraints.englishRhymeMode ?? 'natural',
        }
  const shared = {
    ...settings,
    positions: constraints.rhymePositions ?? 'auto',
    customLines: constraints.customRhymeLines ?? [],
    scheme: constraints.rhymeScheme?.trim() || 'auto',
    firstLine: constraints.firstLineRhyme ?? 'auto',
    change: constraints.rhymeChange ?? 'source',
    priority: constraints.poetryPriority ?? 'balanced',
  }
  return language === 'en'
    ? `Poetry settings: ${JSON.stringify(shared)}. These settings do not request lyric singability, melody fitting, or syllable-to-note alignment.`
    : `诗歌设置：${JSON.stringify(shared)}。这些设置不包含歌词可唱性、旋律适配或音符级音节对齐。`
}

export function poetryBoundaryMapText(
  analysis: PoetrySourceAnalysis,
  language: 'zh' | 'en',
) {
  const rows = analysis.lines.map((line) =>
    language === 'en'
      ? `${line.lineNo}. ${line.text}${line.punctuation} [${line.boundary}]`
      : `${line.lineNo}. ${line.text}${line.punctuation}【${line.boundary}】`,
  )
  const header =
    language === 'en'
      ? `Detected ${analysis.lines.length} poetic lines; suggested rhyme positions ${analysis.suggestedRhymeLines.join(', ') || 'none'}; suggested scheme ${analysis.suggestedScheme}.`
      : `检测到 ${analysis.lines.length} 个诗句；建议韵位 ${analysis.suggestedRhymeLines.join('、') || '无'}；建议韵式 ${analysis.suggestedScheme}。`
  return [header, ...rows].join('\n')
}

export function containsLyricSpecificRequest(sourceText: string, taskBrief = '') {
  return LYRIC_TERMS.test(`${taskBrief}\n${sourceText}`)
}
