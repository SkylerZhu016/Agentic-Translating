// ─── Types ────────────────────────────────────────────────────────────

export type MatchLevel = 'exact' | 'trim_end' | 'trim' | 'unicode' | 'fuzzy';

export type MatchResult =
  | { status: 'found'; level: MatchLevel; start: number; end: number }
  | { status: 'ambiguous'; level: MatchLevel; matchCount: number }
  | { status: 'not_found'; suggestions?: string[] };

// ─── Internal: Normalized View ────────────────────────────────────────

interface NormalizedView {
  text: string;
  origStart: number[];
  origEnd: number[];
}

function mapToOriginal(view: NormalizedView, matchStart: number, matchEnd: number): { start: number; end: number } {
  if (matchStart >= view.origStart.length) {
    return { start: view.origStart[view.origStart.length - 1] ?? 0, end: view.origStart[view.origStart.length - 1] ?? 0 };
  }
  const start = view.origStart[matchStart];
  const end = matchEnd > 0 && matchEnd <= view.origEnd.length
    ? view.origEnd[matchEnd - 1]
    : (matchStart > 0 ? view.origEnd[matchStart - 1] : start);
  return { start, end };
}

// ─── CRLF Normalization ───────────────────────────────────────────────

function buildCRLFView(original: string): NormalizedView {
  const textParts: string[] = [];
  const origStart: number[] = [];
  const origEnd: number[] = [];
  let i = 0;
  while (i < original.length) {
    if (original[i] === '\r' && i + 1 < original.length && original[i + 1] === '\n') {
      textParts.push('\n');
      origStart.push(i);
      origEnd.push(i + 2);
      i += 2;
    } else {
      textParts.push(original[i]);
      origStart.push(i);
      origEnd.push(i + 1);
      i++;
    }
  }
  return { text: textParts.join(''), origStart, origEnd };
}

// ─── Level 2 & 3: Line-based trimming ─────────────────────────────────

function buildTrimEndView(original: string): NormalizedView {
  const textParts: string[] = [];
  const origStart: number[] = [];
  const origEnd: number[] = [];
  let i = 0;
  const len = original.length;

  while (i < len) {
    let lineStart = i;
    let lineEnd = i;
    while (lineEnd < len && original[lineEnd] !== '\n' && original[lineEnd] !== '\r') {
      lineEnd++;
    }
    let contentEnd = lineEnd;
    while (contentEnd > lineStart && (original[contentEnd - 1] === ' ' || original[contentEnd - 1] === '\t')) {
      contentEnd--;
    }
    for (let j = lineStart; j < contentEnd; j++) {
      textParts.push(original[j]);
      origStart.push(j);
      origEnd.push(j + 1);
    }
    if (lineEnd < len) {
      if (original[lineEnd] === '\r' && lineEnd + 1 < len && original[lineEnd + 1] === '\n') {
        textParts.push('\n');
        origStart.push(lineEnd);
        origEnd.push(lineEnd + 2);
        i = lineEnd + 2;
      } else {
        textParts.push(original[lineEnd]);
        origStart.push(lineEnd);
        origEnd.push(lineEnd + 1);
        i = lineEnd + 1;
      }
    } else {
      i = lineEnd;
    }
  }
  return { text: textParts.join(''), origStart, origEnd };
}

function buildTrimView(original: string): NormalizedView {
  const textParts: string[] = [];
  const origStart: number[] = [];
  const origEnd: number[] = [];
  let i = 0;
  const len = original.length;

  while (i < len) {
    let lineStart = i;
    let lineEnd = i;
    while (lineEnd < len && original[lineEnd] !== '\n' && original[lineEnd] !== '\r') {
      lineEnd++;
    }
    let contentStart = lineStart;
    while (contentStart < lineEnd && (original[contentStart] === ' ' || original[contentStart] === '\t')) {
      contentStart++;
    }
    let contentEnd = lineEnd;
    while (contentEnd > contentStart && (original[contentEnd - 1] === ' ' || original[contentEnd - 1] === '\t')) {
      contentEnd--;
    }
    for (let j = contentStart; j < contentEnd; j++) {
      textParts.push(original[j]);
      origStart.push(j);
      origEnd.push(j + 1);
    }
    if (lineEnd < len) {
      if (original[lineEnd] === '\r' && lineEnd + 1 < len && original[lineEnd + 1] === '\n') {
        textParts.push('\n');
        origStart.push(lineEnd);
        origEnd.push(lineEnd + 2);
        i = lineEnd + 2;
      } else {
        textParts.push(original[lineEnd]);
        origStart.push(lineEnd);
        origEnd.push(lineEnd + 1);
        i = lineEnd + 1;
      }
    } else {
      i = lineEnd;
    }
  }
  return { text: textParts.join(''), origStart, origEnd };
}

// ─── Level 4: Unicode Normalization ───────────────────────────────────

const SMART_QUOTE_MAP: Record<string, string> = {
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'",
  '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"',
  '\u00A0': ' ',
};

function buildUnicodeView(original: string): NormalizedView {
  const interParts: string[] = [];
  const interStart: number[] = [];
  const interEnd: number[] = [];

  for (let i = 0; i < original.length; i++) {
    const ch = original[i];
    const mapped = SMART_QUOTE_MAP[ch] ?? ch;
    interParts.push(mapped);
    interStart.push(i);
    interEnd.push(i + 1);
  }

  const intermediate = interParts.join('');
  const nfcResult = intermediate.normalize('NFC');

  const nfcOrigStart: number[] = [];
  const nfcOrigEnd: number[] = [];
  let intIdx = 0;

  for (let nfcIdx = 0; nfcIdx < nfcResult.length; nfcIdx++) {
    const nfcChar = nfcResult[nfcIdx];
    const nfdDecomp = nfcChar.normalize('NFD');
    const consumed = nfdDecomp.length;

    if (consumed > 0 && intIdx < interStart.length) {
      nfcOrigStart.push(interStart[intIdx]);
      const lastConsumedIdx = intIdx + consumed - 1;
      nfcOrigEnd.push(lastConsumedIdx < interEnd.length ? interEnd[lastConsumedIdx] : interEnd[interEnd.length - 1]);
    } else if (intIdx < interStart.length) {
      nfcOrigStart.push(interStart[intIdx]);
      nfcOrigEnd.push(interEnd[intIdx]);
    }
    intIdx += consumed;
  }

  return { text: nfcResult, origStart: nfcOrigStart, origEnd: nfcOrigEnd };
}

// ─── Level 5: Fuzzy (Levenshtein sliding window) ──────────────────────

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array(n + 1).fill(0);
  let curr = new Array(n + 1).fill(0);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 0; i < m; i++) {
    curr[0] = i + 1;
    for (let j = 0; j < n; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      curr[j + 1] = Math.min(curr[j] + 1, prev[j + 1] + 1, prev[j] + cost);
    }
    const temp = prev;
    prev = curr;
    curr = temp;
  }

  return prev[n];
}

// ─── All-matches finder ────────────────────────────────────────────────

function findAllMatches(haystack: string, needle: string): number[] {
  const indices: number[] = [];
  if (!needle) return indices;
  let pos = 0;
  while (pos <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, pos);
    if (found === -1) break;
    indices.push(found);
    pos = found + 1;
  }
  return indices;
}

// ─── Suggestion generator ─────────────────────────────────────────────

function generateSuggestions(fullText: string, oldString: string, maxSuggestions: number = 3): string[] {
  if (!fullText || !oldString) return [];
  const len = oldString.length;
  const candidates: { text: string; dist: number }[] = [];
  const step = Math.max(1, Math.floor(fullText.length / 50));

  for (let start = 0; start <= fullText.length - Math.max(1, len); start += step) {
    for (let w = Math.max(1, len - 3); w <= Math.min(fullText.length - start, len + 3); w++) {
      const window = fullText.substring(start, start + w);
      const dist = levenshteinDistance(window, oldString);
      candidates.push({ text: window, dist });
    }
  }

  candidates.sort((a, b) => a.dist - b.dist);
  const seen = new Set<string>();
  const results: string[] = [];
  for (const c of candidates) {
    if (!seen.has(c.text) && c.text.length > 0) {
      seen.add(c.text);
      results.push(c.text);
      if (results.length >= maxSuggestions) break;
    }
  }
  return results;
}

// ─── Level matchers ────────────────────────────────────────────────────

interface LevelMatchResult {
  status: 'found' | 'ambiguous' | 'not_found';
  matchCount?: number;
  start?: number;
  end?: number;
}

function tryMatchAtLevel(view: NormalizedView, normalizedOldString: string): LevelMatchResult {
  const matches = findAllMatches(view.text, normalizedOldString);
  if (matches.length > 1) return { status: 'ambiguous', matchCount: matches.length };
  if (matches.length === 0) return { status: 'not_found' };
  const matchStart = matches[0];
  const matchEnd = matchStart + normalizedOldString.length;
  const orig = mapToOriginal(view, matchStart, matchEnd);
  return { status: 'found', start: orig.start, end: orig.end };
}

function tryFuzzyMatch(crlfView: NormalizedView, oldStringCRLF: string): LevelMatchResult {
  const fullText = crlfView.text;
  const oldString = oldStringCRLF;
  const maxDist = Math.max(2, Math.floor(oldString.length / 20));
  const windowSize = oldString.length;
  const minWindow = Math.max(1, windowSize - maxDist);
  const maxWindow = Math.min(fullText.length, windowSize + maxDist);

  let bestDist = Infinity;
  let bestStart = -1;
  let bestEnd = -1;
  let tieCount = 0;

  for (let start = 0; start <= fullText.length - minWindow; start++) {
    for (let len = minWindow; len <= Math.min(fullText.length - start, maxWindow); len++) {
      const window = fullText.substring(start, start + len);
      const dist = levenshteinDistance(window, oldString);
      if (dist <= maxDist) {
        if (dist < bestDist) {
          bestDist = dist;
          bestStart = start;
          bestEnd = start + len;
          tieCount = 1;
        } else if (dist === bestDist && (start !== bestStart || len !== bestEnd - bestStart)) {
          tieCount++;
        }
      }
    }
  }

  if (bestDist === Infinity || bestStart === -1) return { status: 'not_found' };
  if (tieCount > 1) return { status: 'ambiguous', matchCount: tieCount };
  const orig = mapToOriginal(crlfView, bestStart, bestEnd);
  return { status: 'found', start: orig.start, end: orig.end };
}

// ─── Main Cascade ──────────────────────────────────────────────────────

export function cascadingMatch(oldString: string, fullText: string): MatchResult {
  if (!oldString || oldString.length === 0) {
    return { status: 'not_found' };
  }

  const fullCRLF = buildCRLFView(fullText);
  const oldCRLF = buildCRLFView(oldString);
  const oldStringNorm = oldCRLF.text;

  // Level 1: exact
  const exactResult = tryMatchAtLevel(fullCRLF, oldStringNorm);
  if (exactResult.status === 'found') return { status: 'found', level: 'exact', start: exactResult.start!, end: exactResult.end! };
  if (exactResult.status === 'ambiguous') return { status: 'ambiguous', level: 'exact', matchCount: exactResult.matchCount! };

  // Level 2: trim_end
  const trimEndView = buildTrimEndView(fullText);
  const oldTrimEnd = buildTrimEndView(oldString);
  const trimEndResult = tryMatchAtLevel(trimEndView, oldTrimEnd.text);
  if (trimEndResult.status === 'found') return { status: 'found', level: 'trim_end', start: trimEndResult.start!, end: trimEndResult.end! };
  if (trimEndResult.status === 'ambiguous') return { status: 'ambiguous', level: 'trim_end', matchCount: trimEndResult.matchCount! };

  // Level 3: trim
  const trimView = buildTrimView(fullText);
  const oldTrim = buildTrimView(oldString);
  const trimResult = tryMatchAtLevel(trimView, oldTrim.text);
  if (trimResult.status === 'found') return { status: 'found', level: 'trim', start: trimResult.start!, end: trimResult.end! };
  if (trimResult.status === 'ambiguous') return { status: 'ambiguous', level: 'trim', matchCount: trimResult.matchCount! };

  // Level 4: unicode
  const unicodeView = buildUnicodeView(fullText);
  const oldUnicode = buildUnicodeView(oldString);
  const unicodeResult = tryMatchAtLevel(unicodeView, oldUnicode.text);
  if (unicodeResult.status === 'found') return { status: 'found', level: 'unicode', start: unicodeResult.start!, end: unicodeResult.end! };
  if (unicodeResult.status === 'ambiguous') return { status: 'ambiguous', level: 'unicode', matchCount: unicodeResult.matchCount! };

  // Level 5: fuzzy
  const fuzzyResult = tryFuzzyMatch(fullCRLF, oldStringNorm);
  if (fuzzyResult.status === 'found') return { status: 'found', level: 'fuzzy', start: fuzzyResult.start!, end: fuzzyResult.end! };
  if (fuzzyResult.status === 'ambiguous') return { status: 'ambiguous', level: 'fuzzy', matchCount: fuzzyResult.matchCount! };

  const suggestions = generateSuggestions(fullCRLF.text, oldStringNorm);
  return { status: 'not_found', suggestions: suggestions.length > 0 ? suggestions : undefined };
}
