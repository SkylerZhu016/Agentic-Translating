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
  | { ok: false; failedIndex: number; reason: string };

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
