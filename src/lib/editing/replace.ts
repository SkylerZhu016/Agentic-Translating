import { cascadingMatch, type MatchLevel } from './matcher';

export type ReplaceResult =
  | { ok: true; newText: string; level: MatchLevel }
  | { ok: false; reason: string; matchCount?: number; suggestions?: string[] };

export interface Edit {
  old_string: string;
  new_string: string;
}

export type BatchResult =
  | { ok: true; newText: string }
  | { ok: false; failedIndex: number; reason: string; suggestions?: string[] };

/**
 * Apply a replacement only when oldString occurs exactly once.
 *
 * The ordinary editor matcher deliberately tolerates whitespace, Unicode and
 * small spelling differences. That is useful for interactive human edits, but
 * unsafe for an LLM tool call: a plausible fuzzy match can silently modify the
 * wrong passage. Suggestions are diagnostic only and are never applied.
 */
export function applyExactReplacement(
  fullText: string,
  oldString: string,
  newString: string,
): ReplaceResult {
  if (!oldString) {
    return { ok: false, reason: 'old_string must not be empty' };
  }

  const first = fullText.indexOf(oldString);
  if (first < 0) {
    const diagnostic = cascadingMatch(oldString, fullText);
    const suggestions = diagnostic.status === 'found'
      ? [fullText.slice(diagnostic.start, diagnostic.end)]
      : diagnostic.status === 'not_found'
        ? diagnostic.suggestions
        : undefined;
    return {
      ok: false,
      reason: `exact text not found: "${oldString}" does not occur character-for-character in the current text`,
      suggestions,
    };
  }

  const second = fullText.indexOf(oldString, first + oldString.length);
  if (second >= 0) {
    let matchCount = 2;
    let cursor = second + oldString.length;
    while (cursor <= fullText.length) {
      const next = fullText.indexOf(oldString, cursor);
      if (next < 0) break;
      matchCount += 1;
      cursor = next + oldString.length;
    }
    return {
      ok: false,
      reason: `ambiguous exact match: found ${matchCount} occurrences; include more unchanged context`,
      matchCount,
    };
  }

  return {
    ok: true,
    newText:
      fullText.slice(0, first) +
      newString +
      fullText.slice(first + oldString.length),
    level: 'exact',
  };
}

/** Transactional exact-only batch used by model tool calls. */
export function applyExactReplacementBatch(
  fullText: string,
  edits: Edit[],
): BatchResult {
  if (edits.length === 0) return { ok: true, newText: fullText };

  let currentText = fullText;
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (edit.old_string === edit.new_string) continue;
    const result = applyExactReplacement(
      currentText,
      edit.old_string,
      edit.new_string,
    );
    if (!result.ok) {
      return {
        ok: false,
        failedIndex: i,
        reason: result.reason,
        suggestions: result.suggestions,
      };
    }
    currentText = result.newText;
  }

  return { ok: true, newText: currentText };
}

export function applyReplacement(fullText: string, oldString: string, newString: string): ReplaceResult {
  const match = cascadingMatch(oldString, fullText);

  if (match.status === 'found') {
    const newText = fullText.substring(0, match.start) + newString + fullText.substring(match.end);
    return { ok: true, newText, level: match.level };
  }

  if (match.status === 'ambiguous') {
    return {
      ok: false,
      reason: `ambiguous match: found ${match.matchCount} occurrences at level '${match.level}' — please provide more context`,
      matchCount: match.matchCount,
    };
  }

  return {
    ok: false,
    reason: `text not found: "${oldString}" could not be matched in the current text`,
    suggestions: match.suggestions,
  };
}

export function applyReplacementBatch(fullText: string, edits: Edit[]): BatchResult {
  if (edits.length === 0) return { ok: true, newText: fullText };

  let currentText = fullText;

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (edit.old_string === edit.new_string) continue;

    const result = applyReplacement(currentText, edit.old_string, edit.new_string);
    if (!result.ok) {
      return { ok: false, failedIndex: i, reason: result.reason };
    }
    currentText = result.newText;
  }

  return { ok: true, newText: currentText };
}
