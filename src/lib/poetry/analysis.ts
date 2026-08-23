import { dictionary } from 'cmu-pronouncing-dictionary'
import { getInitialAndFinal, pinyin } from 'pinyin-pro'
import type {
  TranslationConstraints,
  TranslationDirection,
} from '../contracts/vnext'

export type PoetryBoundaryKind = 'continuation' | 'closure' | 'open'

export interface PoetrySourceLine {
  lineNo: number
  stanzaNo: number
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
  rhymeRequirement: 'explicit' | 'source-stable' | 'conditional' | 'none'
  sourceRhymeStable: boolean
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
      stanzaNo: 1,
      text,
      punctuation,
      boundary: boundaryOf(punctuation),
    })
  }
  return lines
}

function splitWrittenLines(sourceText: string): PoetrySourceLine[] {
  const lines: PoetrySourceLine[] = []
  let stanzaNo = 1
  let pendingStanzaBreak = false
  for (const rawLine of sourceText.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) {
      if (lines.length > 0) pendingStanzaBreak = true
      continue
    }
    if (pendingStanzaBreak) {
      stanzaNo += 1
      pendingStanzaBreak = false
    }
    const punctuation = line.match(/[,，;；:：.!?。！？]+$/u)?.[0] ?? ''
    lines.push({
      lineNo: lines.length + 1,
      stanzaNo,
      text: punctuation ? line.slice(0, -punctuation.length).trimEnd() : line,
      punctuation,
      boundary: boundaryOf(punctuation),
    })
  }
  return lines
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

function englishRhyme(word: string) {
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
  return phones
    .slice(vowelIndex)
    .map((phone) => phone.replace(/[012]/g, ''))
    .join('-')
}

function sourceRhymeSignature(line: PoetrySourceLine) {
  const han = finalHan(line.text)
  if (han) return mandarinFinal(han)
  const ending = line.text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*$/)?.[0]
  return ending ? englishRhyme(ending.replace(/’/g, "'")) : null
}

function stableSourceRhyme(lines: PoetrySourceLine[]) {
  const signatures = lines.map(sourceRhymeSignature)
  const stanzas = new Map<number, PoetrySourceLine[]>()
  for (const line of lines) {
    stanzas.set(line.stanzaNo, [...(stanzas.get(line.stanzaNo) ?? []), line])
  }
  const stableLines = new Set<number>()
  const stanzaStability: boolean[] = []
  for (const stanzaLines of stanzas.values()) {
    const stanzaSignatures = stanzaLines.map(
      (line) => signatures[line.lineNo - 1],
    )
    const counts = new Map<string, number>()
    for (const signature of stanzaSignatures) {
      if (signature) counts.set(signature, (counts.get(signature) ?? 0) + 1)
    }
    const repeated = new Set(
      [...counts]
        .filter(([, count]) => count >= 2)
        .map(([signature]) => signature),
    )
    const repeatedLines = stanzaLines.filter((line) => {
      const signature = signatures[line.lineNo - 1]
      return Boolean(signature && repeated.has(signature))
    })
    const repeatedCoverageStable =
      repeatedLines.length >= Math.max(2, Math.ceil(stanzaLines.length * 0.6))

    const evenLines = stanzaLines.filter((_, index) => (index + 1) % 2 === 0)
    const evenSignatures = evenLines
      .map((line) => signatures[line.lineNo - 1])
      .filter((signature): signature is string => Boolean(signature))
    const evenPositionStable =
      evenLines.length >= 2 &&
      evenSignatures.length === evenLines.length &&
      new Set(evenSignatures).size === 1

    if (repeatedCoverageStable) {
      for (const line of repeatedLines) stableLines.add(line.lineNo)
    }
    if (evenPositionStable) {
      for (const line of evenLines) stableLines.add(line.lineNo)
      const first = stanzaLines[0]
      if (
        first &&
        signatures[first.lineNo - 1] === evenSignatures[0]
      ) {
        stableLines.add(first.lineNo)
      }
    }
    stanzaStability.push(repeatedCoverageStable || evenPositionStable)
  }
  const stable = stanzaStability.length > 0 && stanzaStability.every(Boolean)
  return {
    stable,
    rhymeLines: stable ? [...stableLines].sort((a, b) => a - b) : [],
    signatures,
  }
}

function explicitRhymePolicy(
  direction: TranslationDirection | undefined,
  taskBrief: string,
  constraints: TranslationConstraints,
  taskScheme: ReturnType<typeof taskBriefRhymeScheme>,
) {
  const brief = taskBrief.toLowerCase()
  const clauses = brief.split(
    /[。；;.\n]|\b(?:but|however|yet)\b|但(?:是)?|不过/iu,
  )
  const explicitlyBansRhyme = clauses.some((clause) => {
    if (/不(?:要|得|应).{0,8}无韵|非\s*无韵/iu.test(clause)) return false
    return /(?:不要|不得|禁止|切勿)(?:使用|加入|添加|采用)?\s*押韵|(?:译成|采用|使用|写成|保持)?\s*无韵(?:诗|体)?|(?:do not|don't|must not)\s+(?:use\s+|add\s+|introduce\s+)?rhyme\b|never\s+(?:add|use|introduce)?\s*rhyme\b|\bwithout rhyme\b|\bunrhymed\b|^\s*no rhyme(?:\s*,?\s*please)?\s*$/iu.test(
      clause,
    )
  })
  const conditionalRhymeRequest = clauses.some((clause) => {
    if (!/押(?:同一)?韵|韵脚|韵式|\brhym(?:e|ed|ing)\b|rhyme scheme|end[- ]rhyme/iu.test(clause)) {
      return false
    }
    return /如|若|如果|只要|不损|可以|可押|尽量|不强制|不要求|不要强行|if\b|when possible|if possible|may\b|can\b|optional|(?:do not|don't|must not|never)\s+force|not required|no rhyme (?:is )?required/iu.test(
      clause,
    )
  })
  const explicitlyRequestsRhyme = clauses.some((clause) => {
    if (!/押(?:同一)?韵|韵脚|韵式|\brhym(?:e|ed|ing)\b|rhyme scheme|end[- ]rhyme/iu.test(clause)) {
      return false
    }
    if (/如|若|如果|只要|不损|可以|可押|尽量|不强制|不要求|不要强行|if\b|when possible|if possible|may\b|can\b|optional|(?:do not|don't|must not|never)\s+force|not required|no rhyme (?:is )?required/iu.test(clause)) {
      return false
    }
    return /必须|务必|一定|须|需要|要求|要押|请.{0,16}押|按.{0,16}韵|must\b|required|require\b|shall\b|need to|please|use (?:an? )?rhyme|rhyme scheme/iu.test(
      clause,
    )
  })
  const explicitlyNoRhyme =
    (direction === 'zh_to_en' && constraints.englishRhymeMode === 'none') ||
    constraints.poetryTargetForm === 'free_verse' ||
    explicitlyBansRhyme
  const explicitlyRequiresRhyme =
    constraints.rhymePositions === 'all_lines' ||
    constraints.rhymePositions === 'even_lines' ||
    constraints.rhymePositions === 'custom' ||
    Boolean(constraints.rhymeScheme?.trim()) ||
    constraints.firstLineRhyme === 'yes' ||
    constraints.rhymeChange === 'single' ||
    (direction === 'zh_to_en' && constraints.englishRhymeMode === 'exact') ||
    (direction === 'zh_to_en' && constraints.englishRhymeMode === 'near') ||
    constraints.poetryTargetForm === 'regulated' ||
    (explicitlyRequestsRhyme && taskScheme.state !== 'scheme_rejected') ||
    taskScheme.state === 'explicit'
  return {
    explicitlyNoRhyme,
    explicitlyRequiresRhyme:
      explicitlyRequiresRhyme && !explicitlyNoRhyme,
    explicitlyConditionalRhyme:
      !explicitlyNoRhyme &&
      !explicitlyRequiresRhyme &&
      (conditionalRhymeRequest || taskScheme.state === 'conditional'),
  }
}

function taskBriefRhymeScheme(taskBrief: string) {
  const clauses = taskBrief.split(
    /[。；;.\n]|\b(?:but|however|yet)\b|但(?:是)?|不过/iu,
  )
  let result: {
    scheme: string
    state: 'explicit' | 'conditional' | 'scheme_rejected' | null
  } = { scheme: '', state: null }
  for (const clause of clauses) {
    const patterns = [
      /(?:use|apply|follow|avoid)\s+(?:an?\s+)?([a-z]{2,16}(?:[\s/-]+[a-z]{2,16})*)\s+rhyme scheme\b/iu,
      /^\s*([a-z]{2,16}(?:[\s/-]+[a-z]{2,16})*)\s+rhyme scheme\b/iu,
      /\brhyme scheme\s*(?:is|of|[:：])?\s*([a-z]{2,16}(?:[\s/-]+[a-z]{2,16})*)/iu,
      /(?:使用|采用|按照?|不要使用|不得使用|禁止使用)\s*([a-z]{2,16}(?:[\s/-]+[a-z]{2,16})*)\s*(?:韵式|押韵方案)/iu,
      /^\s*([a-z]{2,16}(?:[\s/-]+[a-z]{2,16})*)\s*(?:韵式|押韵方案)/iu,
      /(?:韵式|押韵方案)\s*(?:为|是|采用|使用|[:：])?\s*([a-z]{2,16}(?:[\s/-]+[a-z]{2,16})*)/iu,
      /(?:[Uu]se|[Aa]pply|[Ff]ollow|[Aa]void|使用|采用|按照?|不要使用|不得使用|禁止使用)\s+(?:an?\s+)?([A-Z]{2,64}(?:[/-][A-Z]{2,64})*)/u,
      /^\s*([a-z]{2,16}(?:[\s/-]+[a-z]{2,16})*)\s+(?:optional|optionally)\b/iu,
    ]
    const match = patterns
      .map((pattern) => clause.match(pattern))
      .find((candidate) => Boolean(candidate?.[1]))
    const normalized = match?.[1]?.replace(/[\s/-]+/g, '').toUpperCase() ?? ''
    if (normalized.length < 2 || normalized.length > 64) continue
    const state = /(?:do not|don't|never|must not|avoid)\s+(?:use|apply|follow)|(?:不要|不得|禁止|切勿).{0,8}(?:使用|采用|按)/iu.test(
      clause,
    )
      ? 'scheme_rejected'
      : /如|若|如果|只要|不损|可以|可选|尽量|if\b|when possible|if possible|optional|optionally|may\b|can\b/iu.test(
          clause,
        )
        ? 'conditional'
        : 'explicit'
    result = { scheme: normalized, state }
  }
  return result
}

function expandedRhymeScheme(
  rawScheme: string | undefined,
  lines: PoetrySourceLine[],
) {
  const scheme = (rawScheme ?? '').replace(/[^A-Za-z]/g, '')
  if (!scheme) return ''
  if (scheme.length >= lines.length) return scheme.slice(0, lines.length)
  const stanzas = new Map<number, PoetrySourceLine[]>()
  for (const line of lines) {
    stanzas.set(line.stanzaNo, [...(stanzas.get(line.stanzaNo) ?? []), line])
  }
  if ([...stanzas.values()].every((stanza) => stanza.length === scheme.length)) {
    return [...stanzas.values()].map(() => scheme).join('')
  }
  if (lines.length % scheme.length === 0) {
    return scheme.repeat(lines.length / scheme.length)
  }
  return scheme.padEnd(lines.length, 'x')
}

function canonicalSchemeByStanza(
  rawScheme: string,
  lines: PoetrySourceLine[],
) {
  let stanzaNo: number | null = null
  let nextLabel = 0
  let labels = new Map<string, string>()
  return lines.map((line, index) => {
    if (line.stanzaNo !== stanzaNo) {
      stanzaNo = line.stanzaNo
      nextLabel = 0
      labels = new Map()
    }
    const label = rawScheme[index]?.toUpperCase() ?? 'X'
    if (label === 'X') return 'x'
    if (!labels.has(label)) {
      labels.set(label, String.fromCharCode(65 + nextLabel))
      nextLabel += 1
    }
    return labels.get(label)!
  }).join('')
}

function suggestedRhymeLines(
  lines: PoetrySourceLine[],
  constraints: TranslationConstraints,
  stableRhymeLines: number[],
  explicitRhyme: boolean,
) {
  const stanzaPositions = new Map<number, number>()
  const evenLines = lines.filter((line) => {
    const position = (stanzaPositions.get(line.stanzaNo) ?? 0) + 1
    stanzaPositions.set(line.stanzaNo, position)
    return position % 2 === 0
  })
  if (constraints.rhymePositions === 'custom') {
    const explicit = [...new Set(constraints.customRhymeLines ?? [])]
      .filter((line) => line > 0 && line <= lines.length)
      .sort((a, b) => a - b)
    if (explicit.length > 0) return explicit
    const scheme = expandedRhymeScheme(constraints.rhymeScheme, lines)
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
  if (constraints.rhymePositions === 'even_lines') {
    return evenLines.map((line) => line.lineNo)
  }
  if (constraints.rhymePositions === 'auto' || !constraints.rhymePositions) {
    const scheme = expandedRhymeScheme(constraints.rhymeScheme, lines)
    if (scheme) {
      return [...scheme]
        .map((label, index) => ({ label, lineNo: index + 1 }))
        .filter(({ label }) => label.toLowerCase() !== 'x')
        .map(({ lineNo }) => lineNo)
    }
    const auto = stableRhymeLines.length > 0
      ? [...stableRhymeLines]
      : explicitRhyme
        ? evenLines.map((line) => line.lineNo)
        : []
    if (constraints.firstLineRhyme === 'no') {
      return auto.filter((lineNo) => lineNo !== 1)
    }
    if (constraints.firstLineRhyme === 'yes' && lines.length > 0) {
      return [...new Set([1, ...auto])].sort((a, b) => a - b)
    }
    return auto
  }
  return []
}

function schemeFor(
  lines: PoetrySourceLine[],
  rhymeLines: number[],
  sourceSignatures: Array<string | null>,
) {
  const rhyming = new Set(rhymeLines)
  const labels = new Map<string, string>()
  let nextLabel = 0
  return lines.map((line, index) => {
    if (!rhyming.has(line.lineNo)) return 'x'
    const signature = sourceSignatures[index]
    if (!signature) return 'A'
    if (!labels.has(signature)) {
      labels.set(signature, String.fromCharCode(65 + nextLabel))
      nextLabel += 1
    }
    return labels.get(signature)!
  }).join('')
}

export function analyzePoetrySource(input: {
  sourceText: string
  taskBrief?: string
  direction?: TranslationDirection
  constraints?: TranslationConstraints
}): PoetrySourceAnalysis {
  const baseConstraints = input.constraints ?? {}
  const taskScheme = taskBriefRhymeScheme(input.taskBrief ?? '')
  const constraints =
    taskScheme.scheme &&
    taskScheme.state !== 'scheme_rejected' &&
    !baseConstraints.rhymeScheme?.trim()
    ? { ...baseConstraints, rhymeScheme: taskScheme.scheme }
    : baseConstraints
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
  const sourceRhyme = stableSourceRhyme(lines)
  const sourceStableScheme = schemeFor(
    lines,
    sourceRhyme.rhymeLines,
    sourceRhyme.signatures,
  )
  const rejectedScheme = taskScheme.state === 'scheme_rejected'
    ? expandedRhymeScheme(taskScheme.scheme, lines)
    : ''
  const sourceStableSchemeRejected =
    sourceRhyme.stable &&
    Boolean(rejectedScheme) &&
    canonicalSchemeByStanza(sourceStableScheme, lines) ===
      canonicalSchemeByStanza(rejectedScheme, lines)
  const explicitPolicy = explicitRhymePolicy(
    input.direction,
    input.taskBrief ?? '',
    baseConstraints,
    taskScheme,
  )
  const rhymeRequirement = explicitPolicy.explicitlyNoRhyme
    ? 'none'
    : explicitPolicy.explicitlyRequiresRhyme
      ? 'explicit'
      : explicitPolicy.explicitlyConditionalRhyme
        ? 'conditional'
        : sourceStableSchemeRejected
          ? 'conditional'
          : sourceRhyme.stable
            ? 'source-stable'
            : 'conditional'
  const rhymeLines = rhymeRequirement === 'none'
    ? []
    : suggestedRhymeLines(
        lines,
        constraints,
        rhymeRequirement === 'source-stable' ? sourceRhyme.rhymeLines : [],
        rhymeRequirement === 'explicit',
      )
  return {
    isPoetry,
    reason,
    lines,
    stanzaCount: stanzaCount(input.sourceText),
    suggestedRhymeLines: rhymeLines,
    suggestedScheme:
      rhymeRequirement === 'none'
        ? schemeFor(lines, [], sourceRhyme.signatures)
        : expandedRhymeScheme(constraints.rhymeScheme, lines) ||
          schemeFor(
            lines,
            rhymeLines,
            rhymeRequirement === 'source-stable'
              ? sourceRhyme.signatures
              : lines.map(() => null),
          ),
    rhymeRequirement,
    sourceRhymeStable: sourceRhyme.stable,
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
    ? `Poetry settings: ${JSON.stringify(shared)}. An "auto" rhyme position or scheme is conditional evidence, not a binding form target; fixed rhyme becomes binding only through an explicit request or a highly stable source scheme. These settings do not request lyric singability, melody fitting, or syllable-to-note alignment.`
    : `诗歌设置：${JSON.stringify(shared)}。“auto”韵位或韵式只表示条件证据，不构成固定形式硬目标；固定押韵只有在用户明确要求或源文韵式高度稳定时才具有约束力。这些设置不包含歌词可唱性、旋律适配或音符级音节对齐。`
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
      ? `Detected ${analysis.lines.length} poetic lines; rhyme requirement ${analysis.rhymeRequirement}; suggested rhyme positions ${analysis.suggestedRhymeLines.join(', ') || 'none'}; suggested scheme ${analysis.suggestedScheme}.`
      : `检测到 ${analysis.lines.length} 个诗句；押韵要求 ${analysis.rhymeRequirement}；建议韵位 ${analysis.suggestedRhymeLines.join('、') || '无'}；建议韵式 ${analysis.suggestedScheme}。`
  return [header, ...rows].join('\n')
}

export function containsLyricSpecificRequest(sourceText: string, taskBrief = '') {
  return LYRIC_TERMS.test(`${taskBrief}\n${sourceText}`)
}
