import { createHash } from 'node:crypto'
import type {
  DisagreementCandidate,
  DisagreementCandidateFragmentDto,
  DisagreementDifferenceKind,
  DisagreementFallbackReason,
  DisagreementFinalAlignmentStatus,
  DisagreementHintDto,
  DisagreementHintKind,
  DisagreementHotspotDto,
  DisagreementMapDto,
  DisagreementMapInput,
  DisagreementSegmentationMode,
  DisagreementSourceRangeDto,
  DisagreementSourceSegmentDto,
} from '../contracts/disagreement-map'

export const DISAGREEMENT_SEGMENTER_VERSION = 'deterministic-v1'

const FULL_TEXT_MESSAGE = '本次只能按全文比较' as const
const MAX_TEXT_LENGTH = 200_000
const MAX_SEGMENTS = 400
const HOTSPOT_DISTANCE_THRESHOLD = 0.08

interface InternalSegment extends DisagreementSourceSegmentDto {
  boundaryBefore: boolean
}

interface SegmentGroup {
  segments: InternalSegment[]
  text: string
}

interface CandidateAlignment {
  candidate: DisagreementCandidate
  groups: SegmentGroup[]
}

interface ExtractedValue {
  normalized: string
  display: string
}

const ENGLISH_NEGATIONS = new Set([
  'cannot',
  'hardly',
  'neither',
  'never',
  'no',
  'nor',
  'not',
  'rarely',
  'scarcely',
  'without',
])

const CHINESE_NEGATIONS = [
  '并不',
  '并非',
  '从未',
  '不得',
  '不能',
  '没有',
  '无法',
  '未必',
  '未曾',
  '不',
  '没',
  '未',
  '无',
  '非',
  '莫',
  '勿',
  '别',
  '否',
] as const

const ENGLISH_PROPER_NOUN_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'but',
  'for',
  'from',
  'he',
  'her',
  'his',
  'i',
  'if',
  'in',
  'it',
  'its',
  'no',
  'not',
  'of',
  'on',
  'or',
  'our',
  'she',
  'so',
  'that',
  'the',
  'their',
  'then',
  'they',
  'this',
  'to',
  'we',
  'when',
  'with',
  'you',
])

const CHINESE_ENTITY_SUFFIXES =
  '公司|集团|大学|学院|研究院|委员会|政府|共和国|联邦|帝国|省|市|县|州|山|河|湖|海|岛'

const CHINESE_TERM_SUFFIXES =
  '术|学|法|论|模型|系统|协议|算法|接口|数据库|引擎|框架|网络|平台|机制|策略|标准'

function normalizeNewlines(text: string) {
  return text.replace(/\r\n?/g, '\n')
}

function normalizeVisibleText(text: string) {
  return text.normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

function canonicalCandidates(candidates: DisagreementCandidate[]) {
  return candidates.map((candidate) => ({
    invocationId: candidate.invocationId,
    agentName: candidate.agentName,
    model: candidate.model,
    body: normalizeNewlines(candidate.body),
  }))
}

/**
 * Hashes the ordered candidate collection. Source/final text and FSBP
 * annotations are intentionally outside the fingerprint.
 */
export function computeCandidateSetHash(
  candidates: DisagreementCandidate[],
): string {
  const canonical = JSON.stringify({
    version: 1,
    candidates: canonicalCandidates(candidates),
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

function safeCandidateSetHash(candidates: unknown): string {
  try {
    if (Array.isArray(candidates)) {
      const safe = candidates.map((candidate) => {
        const value =
          candidate && typeof candidate === 'object'
            ? (candidate as Record<string, unknown>)
            : {}
        return {
          invocationId:
            typeof value.invocationId === 'string' ? value.invocationId : '',
          agentName: typeof value.agentName === 'string' ? value.agentName : '',
          model: typeof value.model === 'string' ? value.model : '',
          body: typeof value.body === 'string' ? value.body : '',
        }
      })
      return computeCandidateSetHash(safe)
    }
  } catch {
    // The constant fallback is still a valid SHA-256 fingerprint.
  }
  return createHash('sha256').update('[]', 'utf8').digest('hex')
}

function trimRange(text: string, start: number, end: number) {
  let trimmedStart = start
  let trimmedEnd = end
  while (trimmedStart < trimmedEnd && /\s/u.test(text[trimmedStart])) {
    trimmedStart++
  }
  while (trimmedEnd > trimmedStart && /\s/u.test(text[trimmedEnd - 1])) {
    trimmedEnd--
  }
  return { start: trimmedStart, end: trimmedEnd }
}

function makeSegment(
  sourceText: string,
  startOffset: number,
  endOffset: number,
  index: number,
  paragraphIndex: number,
  stanzaIndex: number | null,
  lineIndex: number | null,
  boundaryBefore: boolean,
): InternalSegment {
  return {
    id: `source-${index + 1}`,
    index,
    text: sourceText.slice(startOffset, endOffset),
    startOffset,
    endOffset,
    paragraphIndex,
    stanzaIndex,
    lineIndex,
    boundaryBefore,
  }
}

interface TextRange {
  start: number
  end: number
}

interface StanzaTextRange extends TextRange {
  stanzaIndex: number
}

function paragraphRanges(text: string): TextRange[] {
  const ranges: TextRange[] = []
  const separator = /(?:\r\n|\r|\n)[\t ]*(?:\r\n|\r|\n)+/gu
  let start = 0
  for (const match of text.matchAll(separator)) {
    const index = match.index ?? 0
    const trimmed = trimRange(text, start, index)
    if (trimmed.start < trimmed.end) ranges.push(trimmed)
    start = index + match[0].length
  }
  const trimmed = trimRange(text, start, text.length)
  if (trimmed.start < trimmed.end) ranges.push(trimmed)
  return ranges
}

function lineRanges(text: string): StanzaTextRange[] {
  const ranges: StanzaTextRange[] = []
  const matcher = /[^\r\n]*(?:\r\n|\r|\n|$)/gu
  let stanzaIndex = 0
  let sawContentInStanza = false
  for (const match of text.matchAll(matcher)) {
    if (!match[0] && (match.index ?? 0) === text.length) break
    const rawEnd = (match.index ?? 0) + match[0].replace(/(?:\r\n|\r|\n)$/u, '').length
    const trimmed = trimRange(text, match.index ?? 0, rawEnd)
    if (trimmed.start < trimmed.end) {
      ranges.push({ ...trimmed, stanzaIndex })
      sawContentInStanza = true
    } else if (sawContentInStanza) {
      stanzaIndex++
      sawContentInStanza = false
    }
  }
  return ranges
}

function continuouslyTypesetPoetryRanges(text: string): TextRange[] {
  if (!/[\p{Script=Han}]/u.test(text) || /\r|\n/u.test(text)) return []
  const ranges: TextRange[] = []
  const matcher = /[^，。！？；]+[，。！？；]?/gu
  for (const match of text.matchAll(matcher)) {
    const start = match.index ?? 0
    const trimmed = trimRange(text, start, start + match[0].length)
    if (trimmed.start < trimmed.end) ranges.push(trimmed)
  }
  if (ranges.length < 4) return []
  const hanLengths = ranges.map(
    (range) =>
      text.slice(range.start, range.end).match(/[\p{Script=Han}]/gu)?.length ?? 0,
  )
  const classicalLines = hanLengths.filter(
    (length) => length === 5 || length === 7,
  ).length
  return classicalLines >= Math.ceil(ranges.length * 0.75) ? ranges : []
}

function median(values: number[]) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function looksLikeWrittenPoetry(text: string, ranges: TextRange[]) {
  if (ranges.length < 2) return false
  const lengths = ranges.map((range) =>
    Array.from(normalizeVisibleText(text.slice(range.start, range.end))).length,
  )
  const shortLineRatio =
    lengths.filter((length) => length > 0 && length <= 72).length / lengths.length
  const hasStanzaBreak = /(?:\r\n|\r|\n)[\t ]*(?:\r\n|\r|\n)+/u.test(text)
  if (hasStanzaBreak && ranges.length >= 3 && median(lengths) <= 100) {
    return true
  }
  if (ranges.length >= 3) {
    return median(lengths) <= 60 && shortLineRatio >= 0.75
  }
  const shorter = Math.min(...lengths)
  const longer = Math.max(...lengths)
  const lineEndings = ranges.map(
    (range) =>
      text.slice(range.start, range.end).match(/[.!?。！？]/gu)?.length ?? 0,
  )
  return (
    median(lengths) <= 60 &&
    shortLineRatio === 1 &&
    shorter / Math.max(1, longer) >= 0.55 &&
    lineEndings.every((count) => count <= 1)
  )
}

function fallbackSentenceRanges(text: string, baseOffset: number): TextRange[] {
  const ranges: TextRange[] = []
  const matcher = /[^.!?。！？]+(?:[.!?。！？]+[\]})〉》」』”’"']*|$)/gu
  for (const match of text.matchAll(matcher)) {
    const trimmed = trimRange(
      text,
      match.index ?? 0,
      (match.index ?? 0) + match[0].length,
    )
    if (trimmed.start < trimmed.end) {
      ranges.push({
        start: baseOffset + trimmed.start,
        end: baseOffset + trimmed.end,
      })
    }
  }
  return ranges
}

function sentenceRanges(
  wholeText: string,
  paragraph: TextRange,
): TextRange[] {
  const text = wholeText.slice(paragraph.start, paragraph.end)
  try {
    if (typeof Intl.Segmenter === 'function') {
      const segmenter = new Intl.Segmenter(undefined, {
        granularity: 'sentence',
      })
      const ranges: TextRange[] = []
      for (const item of segmenter.segment(text)) {
        const trimmed = trimRange(
          text,
          item.index,
          item.index + item.segment.length,
        )
        if (trimmed.start < trimmed.end) {
          ranges.push({
            start: paragraph.start + trimmed.start,
            end: paragraph.start + trimmed.end,
          })
        }
      }
      if (ranges.length > 0) return ranges
    }
  } catch {
    // The deterministic punctuation segmenter below is the required fallback.
  }
  return fallbackSentenceRanges(text, paragraph.start)
}

function segmentText(text: string): {
  mode: Exclude<DisagreementSegmentationMode, 'full_text'>
  segments: InternalSegment[]
} {
  const physicalLines = lineRanges(text)
  const continuousPoetry = continuouslyTypesetPoetryRanges(text)
  if (
    continuousPoetry.length > 0 ||
    looksLikeWrittenPoetry(text, physicalLines)
  ) {
    const ranges: StanzaTextRange[] =
      continuousPoetry.length > 0
        ? continuousPoetry.map((range) => ({ ...range, stanzaIndex: 0 }))
        : physicalLines
    let lineIndex = 0
    const segments = ranges.map((range, index) => {
      const stanzaIndex = range.stanzaIndex
      if (
        index > 0 &&
        stanzaIndex !== ranges[index - 1].stanzaIndex
      ) {
        lineIndex = 0
      }
      const segment = makeSegment(
        text,
        range.start,
        range.end,
        index,
        stanzaIndex,
        stanzaIndex,
        lineIndex,
        index > 0 &&
          stanzaIndex !== ranges[index - 1].stanzaIndex,
      )
      lineIndex++
      return segment
    })
    return { mode: 'poetry_line', segments }
  }

  const paragraphs = paragraphRanges(text)
  const sentenceSegments: InternalSegment[] = []
  let hasSentenceSplit = false
  for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
    const ranges = sentenceRanges(text, paragraph)
    if (ranges.length > 1) hasSentenceSplit = true
    for (const range of ranges) {
      sentenceSegments.push(
        makeSegment(
          text,
          range.start,
          range.end,
          sentenceSegments.length,
          paragraphIndex,
          null,
          null,
          sentenceSegments.length > 0 &&
            sentenceSegments.at(-1)?.paragraphIndex !== paragraphIndex,
        ),
      )
    }
  }
  if (sentenceSegments.length > 0 && hasSentenceSplit) {
    return { mode: 'sentence', segments: sentenceSegments }
  }

  const paragraphSegments = paragraphs.map((range, index) =>
    makeSegment(
      text,
      range.start,
      range.end,
      index,
      index,
      null,
      null,
      index > 0,
    ),
  )
  return { mode: 'paragraph', segments: paragraphSegments }
}

function segmentByMode(
  text: string,
  mode: Exclude<DisagreementSegmentationMode, 'full_text'>,
): InternalSegment[] {
  if (mode === 'poetry_line') {
    const written = lineRanges(text)
    const ranges: StanzaTextRange[] =
      written.length > 1
        ? written
        : continuouslyTypesetPoetryRanges(text).map((range) => ({
            ...range,
            stanzaIndex: 0,
          }))
    return ranges.map((range, index) => {
      const stanzaIndex = range.stanzaIndex
      return makeSegment(
        text,
        range.start,
        range.end,
        index,
        stanzaIndex,
        stanzaIndex,
        index,
        index > 0 &&
          stanzaIndex !== ranges[index - 1].stanzaIndex,
      )
    })
  }
  const paragraphs = paragraphRanges(text)
  if (mode === 'paragraph') {
    return paragraphs.map((range, index) =>
      makeSegment(
        text,
        range.start,
        range.end,
        index,
        index,
        null,
        null,
        index > 0,
      ),
    )
  }
  const segments: InternalSegment[] = []
  for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
    for (const range of sentenceRanges(text, paragraph)) {
      segments.push(
        makeSegment(
          text,
          range.start,
          range.end,
          segments.length,
          paragraphIndex,
          null,
          null,
          segments.length > 0 &&
            segments.at(-1)?.paragraphIndex !== paragraphIndex,
        ),
      )
    }
  }
  return segments
}

/** Exposed for deterministic unit tests and future server-side pagination. */
export function segmentDisagreementSource(sourceText: string): {
  mode: Exclude<DisagreementSegmentationMode, 'full_text'>
  segments: DisagreementSourceSegmentDto[]
} {
  const segmented = segmentText(sourceText)
  return {
    mode: segmented.mode,
    segments: segmented.segments.map(({ boundaryBefore: _, ...segment }) =>
      segment,
    ),
  }
}

function joinSegments(segments: InternalSegment[]) {
  return segments
    .map((segment, index) => {
      if (index === 0) return segment.text
      const previous = segments[index - 1]
      const separator =
        segment.lineIndex !== null && previous.lineIndex !== null
          ? segment.stanzaIndex !== previous.stanzaIndex
            ? '\n\n'
            : '\n'
          : segment.boundaryBefore
            ? '\n\n'
            : ' '
      return `${separator}${segment.text}`
    })
    .join('')
}

function makeGroup(segments: InternalSegment[]): SegmentGroup {
  return { segments, text: joinSegments(segments) }
}

function balancedGroups(segments: InternalSegment[], count: number) {
  if (count <= 0 || segments.length < count) return null
  if (segments.length === count) {
    return segments.map((segment) => makeGroup([segment]))
  }
  const groups: SegmentGroup[] = []
  let previous = 0
  for (let index = 1; index <= count; index++) {
    const ideal = Math.round((index * segments.length) / count)
    const end = Math.max(previous + 1, Math.min(ideal, segments.length - (count - index)))
    groups.push(makeGroup(segments.slice(previous, end)))
    previous = end
  }
  return groups
}

function comparisonUnits(text: string) {
  const normalized = normalizeVisibleText(text).toLocaleLowerCase()
  const withoutPunctuation = normalized.replace(/[\p{P}\p{S}\s]+/gu, '')
  return Array.from(withoutPunctuation).slice(0, 4_000)
}

function diceSimilarity(left: string, right: string) {
  const leftUnits = comparisonUnits(left)
  const rightUnits = comparisonUnits(right)
  if (leftUnits.length === 0 || rightUnits.length === 0) {
    return leftUnits.length === rightUnits.length ? 1 : 0
  }
  if (leftUnits.join('') === rightUnits.join('')) return 1
  if (leftUnits.length === 1 || rightUnits.length === 1) return 0
  const counts = new Map<string, number>()
  for (let index = 0; index < leftUnits.length - 1; index++) {
    const bigram = `${leftUnits[index]}\u0000${leftUnits[index + 1]}`
    counts.set(bigram, (counts.get(bigram) ?? 0) + 1)
  }
  let intersection = 0
  for (let index = 0; index < rightUnits.length - 1; index++) {
    const bigram = `${rightUnits[index]}\u0000${rightUnits[index + 1]}`
    const count = counts.get(bigram) ?? 0
    if (count > 0) {
      intersection++
      counts.set(bigram, count - 1)
    }
  }
  return (
    (2 * intersection) /
    (Math.max(1, leftUnits.length - 1) + Math.max(1, rightUnits.length - 1))
  )
}

function crossedBoundaries(segments: InternalSegment[]) {
  return segments.slice(1).filter((segment) => segment.boundaryBefore).length
}

function alignGroups(
  segments: InternalSegment[],
  references: SegmentGroup[],
): SegmentGroup[] | null {
  const groupCount = references.length
  if (segments.length < groupCount || groupCount === 0) return null
  if (segments.length === groupCount) {
    return segments.map((segment) => makeGroup([segment]))
  }

  const totalLength = Math.max(
    1,
    segments.reduce((sum, segment) => sum + comparisonUnits(segment.text).length, 0),
  )
  const referenceTotal = Math.max(
    1,
    references.reduce((sum, group) => sum + comparisonUnits(group.text).length, 0),
  )
  const parent = Array.from({ length: groupCount + 1 }, () =>
    Array<number>(segments.length + 1).fill(-1),
  )
  let previous = Array<number>(segments.length + 1).fill(Number.POSITIVE_INFINITY)
  previous[0] = 0
  const expectedSize = segments.length / groupCount
  const maxGroupSize = Math.ceil(expectedSize * 3) + 4

  for (let groupIndex = 1; groupIndex <= groupCount; groupIndex++) {
    const current = Array<number>(segments.length + 1).fill(Number.POSITIVE_INFINITY)
    const minimumEnd = groupIndex
    const maximumEnd = segments.length - (groupCount - groupIndex)
    for (let end = minimumEnd; end <= maximumEnd; end++) {
      const minimumStart = Math.max(groupIndex - 1, end - maxGroupSize)
      for (let start = minimumStart; start < end; start++) {
        if (!Number.isFinite(previous[start])) continue
        const group = makeGroup(segments.slice(start, end))
        const groupLength = comparisonUnits(group.text).length
        const reference = references[groupIndex - 1]
        const referenceLength = comparisonUnits(reference.text).length
        const similarityCost = 1 - diceSimilarity(group.text, reference.text)
        const lengthCost = Math.abs(
          groupLength / totalLength - referenceLength / referenceTotal,
        )
        const positionCost =
          Math.abs(start / segments.length - (groupIndex - 1) / groupCount) +
          Math.abs(end / segments.length - groupIndex / groupCount)
        const boundaryCost =
          Math.abs(
            crossedBoundaries(group.segments) -
              crossedBoundaries(reference.segments),
          ) * 0.12
        const cost =
          previous[start] +
          similarityCost * 0.5 +
          lengthCost * 0.3 +
          positionCost * 0.2 +
          boundaryCost
        if (cost < current[end]) {
          current[end] = cost
          parent[groupIndex][end] = start
        }
      }
    }
    previous = current
  }

  if (!Number.isFinite(previous[segments.length])) return null
  const groups: SegmentGroup[] = []
  let end = segments.length
  for (let groupIndex = groupCount; groupIndex > 0; groupIndex--) {
    const start = parent[groupIndex][end]
    if (start < 0) return null
    groups.unshift(makeGroup(segments.slice(start, end)))
    end = start
  }
  return end === 0 ? groups : null
}

function normalizedPunctuation(character: string) {
  const equivalents: Record<string, string> = {
    '，': ',',
    '。': '.',
    '！': '!',
    '？': '?',
    '：': ':',
    '；': ';',
    '‘': "'",
    '’': "'",
    '“': '"',
    '”': '"',
    '「': '"',
    '」': '"',
    '『': '"',
    '』': '"',
  }
  return equivalents[character] ?? character
}

function punctuationValues(text: string): ExtractedValue[] {
  return Array.from(text.match(/[\p{P}]/gu) ?? []).map((value) => ({
    normalized: normalizedPunctuation(value),
    display: value,
  }))
}

function numberValues(text: string): ExtractedValue[] {
  const normalized = text.normalize('NFKC')
  const matches =
    normalized.match(
      /[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:%|‰)?|[零〇一二两三四五六七八九十百千万亿]+/gu,
    ) ?? []
  return matches.map((value) => ({
    normalized: value.replace(/,/g, ''),
    display: value,
  }))
}

function negationValues(text: string): ExtractedValue[] {
  const values: ExtractedValue[] = []
  const normalized = text.normalize('NFKC')
  const englishMatcher = /\b[\p{L}]+(?:n't)?\b/giu
  for (const match of normalized.matchAll(englishMatcher)) {
    const lower = match[0].toLocaleLowerCase()
    if (lower.endsWith("n't") || ENGLISH_NEGATIONS.has(lower)) {
      values.push({ normalized: lower, display: match[0] })
    }
  }
  const chineseMatcher = new RegExp(CHINESE_NEGATIONS.join('|'), 'gu')
  for (const match of normalized.matchAll(chineseMatcher)) {
    values.push({ normalized: match[0], display: match[0] })
  }
  return values
}

function properNounValues(text: string): ExtractedValue[] {
  const values: ExtractedValue[] = []
  const normalized = text.normalize('NFKC')
  const englishMatcher =
    /\b(?:[A-Z]{2,}(?:[-/][A-Z0-9]+)*|[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)*)\b/gu
  for (const match of normalized.matchAll(englishMatcher)) {
    const lower = match[0].toLocaleLowerCase()
    const prefix = normalized.slice(0, match.index ?? 0).trimEnd()
    const sentenceInitial = !prefix || /[.!?。！？]$/u.test(prefix)
    const inherentlyMarked =
      /^[A-Z]{2,}(?:[-/][A-Z0-9]+)*$/u.test(match[0]) ||
      /\s/u.test(match[0])
    if (
      !ENGLISH_PROPER_NOUN_STOPWORDS.has(lower) &&
      (!sentenceInitial || inherentlyMarked)
    ) {
      values.push({ normalized: lower, display: match[0] })
    }
  }
  const chineseMatcher = new RegExp(
    `[\\p{Script=Han}]{2,12}(?:${CHINESE_ENTITY_SUFFIXES})`,
    'gu',
  )
  for (const match of normalized.matchAll(chineseMatcher)) {
    values.push({ normalized: match[0], display: match[0] })
  }
  return values
}

function terminologyValues(text: string): ExtractedValue[] {
  const values: ExtractedValue[] = []
  const normalized = text.normalize('NFKC')
  const matchers = [
    /`([^`\r\n]{1,80})`/gu,
    /(?:《([^《》\r\n]{1,80})》|「([^「」\r\n]{1,80})」|『([^『』\r\n]{1,80})』)/gu,
    /\b[\p{L}\p{N}]+(?:[-/][\p{L}\p{N}]+)+\b/gu,
    /\b[A-Z]{2,}[A-Z0-9]*\b/gu,
  ]
  for (const matcher of matchers) {
    for (const match of normalized.matchAll(matcher)) {
      const display = match.slice(1).find(Boolean) ?? match[0]
      values.push({ normalized: display.toLocaleLowerCase(), display })
    }
  }
  const chineseMatcher = new RegExp(
    `[\\p{Script=Han}]{2,12}(?:${CHINESE_TERM_SUFFIXES})`,
    'gu',
  )
  for (const match of normalized.matchAll(chineseMatcher)) {
    values.push({ normalized: match[0], display: match[0] })
  }
  const seen = new Set<string>()
  return values.filter((value) => {
    const key = `${value.normalized}\u0000${value.display}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const HINT_EXTRACTORS: Record<
  DisagreementHintKind,
  (text: string) => ExtractedValue[]
> = {
  punctuation: punctuationValues,
  number: numberValues,
  negation: negationValues,
  proper_noun: properNounValues,
  terminology: terminologyValues,
}

function inventorySignature(values: ExtractedValue[]) {
  return values
    .map((value) => value.normalized)
    .sort((left, right) => left.localeCompare(right))
    .join('\u0001')
}

function deterministicHints(
  fragments: DisagreementCandidateFragmentDto[],
): DisagreementHintDto[] {
  const hints: DisagreementHintDto[] = []
  for (const kind of Object.keys(HINT_EXTRACTORS) as DisagreementHintKind[]) {
    const extracted = fragments.map((fragment) => ({
      invocationId: fragment.invocationId,
      values: HINT_EXTRACTORS[kind](fragment.bodySegment),
    }))
    const signatures = new Set(
      extracted.map((entry) => inventorySignature(entry.values)),
    )
    const hasAnyValue = extracted.some((entry) => entry.values.length > 0)
    if (signatures.size <= 1 || !hasAnyValue) continue
    hints.push({
      kind,
      confidence: 'deterministic',
      candidateValues: extracted.map((entry) => ({
        invocationId: entry.invocationId,
        values: entry.values.map((value) => value.display),
      })),
    })
  }
  return hints
}

function lexicalText(text: string, preserveCase: boolean) {
  const value = normalizeVisibleText(text).replace(/[\p{P}\p{S}]+/gu, '')
  return preserveCase ? value : value.toLocaleLowerCase()
}

function differenceScore(fragments: DisagreementCandidateFragmentDto[]) {
  let maximum = 0
  for (let left = 0; left < fragments.length; left++) {
    for (let right = left + 1; right < fragments.length; right++) {
      const leftText = fragments[left].bodySegment
      const rightText = fragments[right].bodySegment
      let distance = 1 - diceSimilarity(leftText, rightText)
      if (
        distance === 0 &&
        normalizeVisibleText(leftText) !== normalizeVisibleText(rightText)
      ) {
        distance = 0.1
      }
      maximum = Math.max(maximum, distance)
    }
  }
  return Math.round(maximum * 1_000) / 1_000
}

function differenceKinds(
  fragments: DisagreementCandidateFragmentDto[],
  hints: DisagreementHintDto[],
): DisagreementDifferenceKind[] {
  const kinds = new Set<DisagreementDifferenceKind>()
  const caseSensitive = new Set(
    fragments.map((fragment) => lexicalText(fragment.bodySegment, true)),
  )
  if (caseSensitive.size > 1) kinds.add('wording')
  for (const hint of hints) kinds.add(hint.kind)
  if (new Set(fragments.map((fragment) => fragment.unitCount)).size > 1) {
    kinds.add('structure')
  }
  if (
    kinds.size === 0 &&
    new Set(
      fragments.map((fragment) =>
        normalizeVisibleText(fragment.bodySegment),
      ),
    ).size > 1
  ) {
    kinds.add('wording')
  }
  return [
    'wording',
    'punctuation',
    'number',
    'negation',
    'proper_noun',
    'terminology',
    'structure',
  ].filter((kind): kind is DisagreementDifferenceKind => kinds.has(kind as DisagreementDifferenceKind))
}

function sourceRange(
  group: SegmentGroup,
  originalSourceText: string,
): DisagreementSourceRangeDto {
  const first = group.segments[0]
  const last = group.segments.at(-1) ?? first
  return {
    segmentIds: group.segments.map((segment) => segment.id),
    startOffset: first.startOffset,
    endOffset: last.endOffset,
    text: originalSourceText.slice(first.startOffset, last.endOffset),
  }
}

function makeFallback(
  input: Partial<DisagreementMapInput>,
  hash: string,
  reason: DisagreementFallbackReason,
  sourceSegments: DisagreementSourceSegmentDto[] = [],
): DisagreementMapDto {
  const candidates = Array.isArray(input.candidates)
    ? input.candidates
        .filter(
          (candidate): candidate is DisagreementCandidate =>
            Boolean(candidate) &&
            typeof candidate.invocationId === 'string' &&
            typeof candidate.agentName === 'string' &&
            typeof candidate.model === 'string' &&
            typeof candidate.body === 'string',
        )
        .map((candidate) => ({
          invocationId: candidate.invocationId,
          agentName: candidate.agentName,
          model: candidate.model,
          body: candidate.body,
        }))
    : []
  return {
    status: 'full_text_fallback',
    segmenterVersion: DISAGREEMENT_SEGMENTER_VERSION,
    candidateSetHash: hash,
    segmentationMode: 'full_text',
    sourceSegments,
    hotspots: [],
    finalAlignmentStatus:
      typeof input.finalText === 'string' ? 'unavailable' : 'not_provided',
    fallback: {
      reason,
      message: FULL_TEXT_MESSAGE,
      sourceText: typeof input.sourceText === 'string' ? input.sourceText : '',
      candidates,
      finalText: typeof input.finalText === 'string' ? input.finalText : null,
    },
  }
}

function validCandidate(candidate: unknown): candidate is DisagreementCandidate {
  if (!candidate || typeof candidate !== 'object') return false
  const value = candidate as Record<string, unknown>
  return (
    typeof value.invocationId === 'string' &&
    value.invocationId.trim().length > 0 &&
    typeof value.agentName === 'string' &&
    value.agentName.trim().length > 0 &&
    typeof value.model === 'string' &&
    value.model.trim().length > 0 &&
    typeof value.body === 'string'
  )
}

function validateInput(input: unknown): DisagreementFallbackReason | null {
  if (!input || typeof input !== 'object') return 'invalid_input'
  const value = input as Record<string, unknown>
  if (typeof value.sourceText !== 'string') return 'invalid_input'
  if (!Array.isArray(value.candidates)) return 'invalid_input'
  if (value.finalText !== undefined && typeof value.finalText !== 'string') {
    return 'invalid_input'
  }
  if (!value.candidates.every(validCandidate)) return 'invalid_input'
  const ids = value.candidates.map((candidate) => candidate.invocationId)
  if (new Set(ids).size !== ids.length) return 'invalid_input'
  if (value.candidates.length < 2) return 'insufficient_candidates'
  if (!value.sourceText.trim()) return 'empty_source'
  if (value.candidates.some((candidate) => !candidate.body.trim())) {
    return 'empty_candidate'
  }
  const texts = [
    value.sourceText,
    ...value.candidates.map((candidate) => candidate.body),
    typeof value.finalText === 'string' ? value.finalText : '',
  ]
  if (texts.some((text) => text.length > MAX_TEXT_LENGTH)) return 'too_large'
  return null
}

function publicSegments(segments: InternalSegment[]) {
  return segments.map(({ boundaryBefore: _, ...segment }) => segment)
}

/**
 * Builds a pure, deterministic disagreement map from explicit semantic bodies.
 * Every runtime failure degrades to full-text comparison instead of blocking
 * translation, drafting, or export.
 */
export function buildDisagreementMap(input: DisagreementMapInput): DisagreementMapDto {
  const hash = safeCandidateSetHash(
    input && typeof input === 'object' ? input.candidates : undefined,
  )
  const validationError = validateInput(input)
  if (validationError) return makeFallback(input ?? {}, hash, validationError)

  let source: ReturnType<typeof segmentText> | null = null
  try {
    source = segmentText(input.sourceText)
    if (source.segments.length === 0) {
      return makeFallback(input, hash, 'segmentation_failed')
    }
    if (source.segments.length > MAX_SEGMENTS) {
      return makeFallback(
        input,
        hash,
        'too_large',
        publicSegments(source.segments),
      )
    }

    const candidateSegments = input.candidates.map((candidate) => ({
      candidate,
      segments: segmentByMode(candidate.body, source!.mode),
    }))
    if (
      candidateSegments.some(
        (entry) =>
          entry.segments.length === 0 || entry.segments.length > MAX_SEGMENTS,
      )
    ) {
      return makeFallback(
        input,
        hash,
        'segmentation_failed',
        publicSegments(source.segments),
      )
    }

    const minimumCandidateCount = Math.min(
      ...candidateSegments.map((entry) => entry.segments.length),
    )
    const groupCount = Math.min(source.segments.length, minimumCandidateCount)
    if (
      groupCount === 0 ||
      (source.segments.length > 1 && groupCount === 1) ||
      (source.segments.length > 2 &&
        groupCount < Math.ceil(source.segments.length * 0.5))
    ) {
      return makeFallback(
        input,
        hash,
        'alignment_failed',
        publicSegments(source.segments),
      )
    }

    const anchor = [...candidateSegments].sort((left, right) => {
      const leftDistance = Math.abs(
        left.segments.length - source!.segments.length,
      )
      const rightDistance = Math.abs(
        right.segments.length - source!.segments.length,
      )
      return leftDistance - rightDistance
    })[0]
    const anchorGroups = balancedGroups(anchor.segments, groupCount)
    const sourceGroups = balancedGroups(source.segments, groupCount)
    if (!anchorGroups || !sourceGroups) {
      return makeFallback(
        input,
        hash,
        'alignment_failed',
        publicSegments(source.segments),
      )
    }

    const alignments: CandidateAlignment[] = []
    for (const entry of candidateSegments) {
      const groups =
        entry === anchor
          ? anchorGroups
          : alignGroups(entry.segments, anchorGroups)
      if (!groups) {
        return makeFallback(
          input,
          hash,
          'alignment_failed',
          publicSegments(source.segments),
        )
      }
      alignments.push({ candidate: entry.candidate, groups })
    }

    let finalGroups: SegmentGroup[] | null = null
    let finalAlignmentStatus: DisagreementFinalAlignmentStatus = 'not_provided'
    if (input.finalText !== undefined) {
      const finalSegments = input.finalText.trim()
        ? segmentByMode(input.finalText, source.mode)
        : []
      finalGroups = alignGroups(finalSegments, anchorGroups)
      finalAlignmentStatus = finalGroups ? 'aligned' : 'unavailable'
    }

    const hotspots: DisagreementHotspotDto[] = []
    for (let index = 0; index < groupCount; index++) {
      const fragments = alignments.map(({ candidate, groups }) => ({
        invocationId: candidate.invocationId,
        agentName: candidate.agentName,
        model: candidate.model,
        bodySegment: groups[index].text,
        unitCount: groups[index].segments.length,
      }))
      const visibleVariants = new Set(
        fragments.map((fragment) =>
          normalizeVisibleText(fragment.bodySegment),
        ),
      )
      if (visibleVariants.size <= 1) continue

      const hints = deterministicHints(fragments)
      const score = differenceScore(fragments)
      const kinds = differenceKinds(fragments, hints)
      if (score < HOTSPOT_DISTANCE_THRESHOLD && hints.length === 0) continue

      const finalSegment = finalGroups?.[index]?.text ?? null
      const normalizedFinal = finalSegment
        ? normalizeVisibleText(finalSegment)
        : null
      const adoptedCandidateIds = normalizedFinal
        ? fragments
            .filter(
              (fragment) =>
                normalizeVisibleText(fragment.bodySegment) === normalizedFinal,
            )
            .map((fragment) => fragment.invocationId)
        : []

      const hotspot: DisagreementHotspotDto = {
        id: `hotspot-${index + 1}`,
        index,
        sourceRange: sourceRange(sourceGroups[index], input.sourceText),
        candidates: fragments,
        finalSegment,
        adoptedCandidateIds,
        differenceScore: score,
        differenceKinds: kinds,
        hints,
      }
      hotspots.push(hotspot)
    }

    return {
      status: 'ready',
      segmenterVersion: DISAGREEMENT_SEGMENTER_VERSION,
      candidateSetHash: hash,
      segmentationMode: source.mode,
      sourceSegments: publicSegments(source.segments),
      hotspots,
      finalAlignmentStatus,
      fallback: null,
    }
  } catch {
    return makeFallback(
      input,
      hash,
      'internal_error',
      source ? publicSegments(source.segments) : [],
    )
  }
}
