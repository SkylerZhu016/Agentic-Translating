import { describe, it, expect } from 'vitest';
import { cascadingMatch, type MatchResult } from '@/src/lib/editing/matcher';

function found(result: MatchResult) {
  if (result.status !== 'found') throw new Error(`Expected found, got ${result.status}`);
  return result;
}
function ambiguous(result: MatchResult) {
  if (result.status !== 'ambiguous') throw new Error(`Expected ambiguous, got ${result.status}`);
  return result;
}
function notFound(result: MatchResult) {
  if (result.status !== 'not_found') throw new Error(`Expected not_found, got ${result.status}`);
  return result;
}

describe('cascadingMatch — Level 1: exact', () => {
  it('single exact match returns found', () => {
    const r = found(cascadingMatch('hello', 'hello world'));
    expect(r.level).toBe('exact');
    expect(r.start).toBe(0);
    expect(r.end).toBe(5);
  });

  it('exact match in middle of text', () => {
    const r = found(cascadingMatch('world', 'hello world!'));
    expect(r.level).toBe('exact');
    expect(r.start).toBe(6);
    expect(r.end).toBe(11);
  });

  it('multiple exact matches → ambiguous (reject, no guessing)', () => {
    const r = ambiguous(cascadingMatch('the', 'the cat and the dog'));
    expect(r.level).toBe('exact');
    expect(r.matchCount).toBe(2);
  });

  it('exact match count for Chinese text', () => {
    const r = ambiguous(cascadingMatch('月', '明月松间照，清泉石上流，月下飞天镜'));
    expect(r.level).toBe('exact');
    expect(r.matchCount).toBe(2);
  });

  it('exact match with special regex characters does not use regex', () => {
    const r = found(cascadingMatch('(test)', 'prefix (test) suffix'));
    expect(r.level).toBe('exact');
    expect(r.start).toBe(7);
    expect(r.end).toBe(13);
  });

  it('no exact match proceeds to next level', () => {
    const r = found(cascadingMatch('hello  ', 'hello\nworld'));
    expect(r.level).toBe('trim_end');
  });
});

describe('cascadingMatch — Level 2: trim_end', () => {
  it('trailing whitespace mismatch resolved via trim_end', () => {
    const fullText = 'hello\nworld';
    const r = found(cascadingMatch('hello   ', fullText));
    expect(r.level).toBe('trim_end');
    expect(fullText.substring(r.start, r.end)).toBe('hello');
  });

  it('old string has trailing space, full text does not', () => {
    const fullText = 'hello\nworld';
    const r = found(cascadingMatch('hello  ', fullText));
    expect(r.level).toBe('trim_end');
    expect(fullText.substring(r.start, r.end)).toBe('hello');
  });

  it('both sides have different trailing whitespace', () => {
    const fullText = 'hello\nworld';
    const r = found(cascadingMatch('hello     ', fullText));
    expect(r.level).toBe('trim_end');
    expect(fullText.substring(r.start, r.end)).toBe('hello');
  });

  it('multiple matches after trim_end → ambiguous', () => {
    const fullText = 'A\nB\nA';
    const r = ambiguous(cascadingMatch('A  ', fullText));
    expect(r.level).toBe('trim_end');
    expect(r.matchCount).toBe(2);
  });
});

describe('cascadingMatch — Level 3: trim', () => {
  it('leading whitespace difference matched via trim', () => {
    const fullText = 'hello world';
    const r = found(cascadingMatch('  hello world', fullText));
    expect(r.level).toBe('trim');
    expect(fullText.substring(r.start, r.end)).toBe('hello world');
  });

  it('indentation differences resolved via trim', () => {
    const fullText = 'console.log("hi")';
    const r = found(cascadingMatch('\t\tconsole.log("hi")', fullText));
    expect(r.level).toBe('trim');
    expect(fullText.substring(r.start, r.end)).toBe('console.log("hi")');
  });

  it('trailing whitespace on the same line also caught by trim', () => {
    const fullText = 'hello';
    const r = found(cascadingMatch('  hello   ', fullText));
    expect(r.level).toBe('trim');
    expect(r.status).toBe('found');
  });

  it('multiple matches after trim → ambiguous', () => {
    const fullText = '  X\n  X';
    const r = ambiguous(cascadingMatch(' X ', fullText));
    expect(r.level === 'trim_end' || r.level === 'trim').toBe(true);
    expect(r.matchCount).toBe(2);
  });
});

describe('cascadingMatch — Level 4: unicode', () => {
  it('NFD source + NFC oldString matched via unicode', () => {
    const nfdText = 'caf\u0065\u0301';
    const nfcOld = 'caf\u00E9';
    const r = found(cascadingMatch(nfcOld, nfdText));
    expect(r.level).toBe('unicode');
    expect(nfdText.substring(r.start, r.end)).toBe(nfdText);
  });

  it('NFC source + NFD oldString matched via unicode', () => {
    const nfcText = 'caf\u00E9';
    const nfdOld = 'caf\u0065\u0301';
    const r = found(cascadingMatch(nfdOld, nfcText));
    expect(r.level).toBe('unicode');
    expect(nfcText.substring(r.start, r.end)).toBe(nfcText);
  });

  it('NFC source + NFC oldString — exact should catch it first', () => {
    const nfcText = 'caf\u00E9';
    const nfcOld = 'caf\u00E9';
    const r = found(cascadingMatch(nfcOld, nfcText));
    expect(r.level).toBe('exact');
    expect(r.start).toBe(0);
    expect(r.end).toBe(4);
  });

  it('smart quotes → straight quotes conversion', () => {
    const fullText = 'He said \u201Chello\u201D to me';
    const oldString = '"hello"';
    const r = found(cascadingMatch(oldString, fullText));
    expect(r.level).toBe('unicode');
    expect(fullText.substring(r.start, r.end)).toBe('\u201Chello\u201D');
  });

  it('smart single quotes → straight single quotes', () => {
    const fullText = "It\u2019s a test";
    const oldString = "It's a test";
    const r = found(cascadingMatch(oldString, fullText));
    expect(r.level).toBe('unicode');
    expect(fullText.substring(r.start, r.end)).toBe("It\u2019s a test");
  });

  it('nbsp → space conversion', () => {
    const fullText = 'hello\u00A0world';
    const oldString = 'hello world';
    const r = found(cascadingMatch(oldString, fullText));
    expect(r.level).toBe('unicode');
    expect(fullText.substring(r.start, r.end)).toBe('hello\u00A0world');
  });

  it('combined unicode transformations', () => {
    const fullText = '\u201Cresum\u0065\u0301\u00A0test\u201D';
    const oldString = '"resum\u00E9 test"';
    const r = found(cascadingMatch(oldString, fullText));
    expect(r.level).toBe('unicode');
  });
});

describe('cascadingMatch — Level 5: fuzzy', () => {
  it('single character substitution matched via fuzzy', () => {
    const r = found(cascadingMatch('helo world', 'hello world'));
    expect(r.level).toBe('fuzzy');
    expect('hello world'.substring(r.start, r.end)).toBe('hello world');
  });

  it('single character insertion matched via fuzzy', () => {
    const r = found(cascadingMatch('helllo world', 'hello world'));
    expect(r.level).toBe('fuzzy');
  });

  it('single character deletion matched via fuzzy', () => {
    const r = found(cascadingMatch('helo world', 'hello world'));
    expect(r.level).toBe('fuzzy');
  });

  it('fuzzy respects threshold ≤ max(2, len/20)', () => {
    const r = found(cascadingMatch('helo wrld', 'hello world'));
    expect(r.level).toBe('fuzzy');
  });

  it('exceeds fuzzy threshold → not_found', () => {
    const r = notFound(cascadingMatch('hxllx wxrld', 'hello world'));
    expect(r.status).toBe('not_found');
    expect(r.suggestions).toBeDefined();
    expect(r.suggestions!.length).toBeGreaterThanOrEqual(1);
    expect(r.suggestions!.length).toBeLessThanOrEqual(3);
  });

  it('fuzzy is NOT used when exact works', () => {
    const r = found(cascadingMatch('hello world', 'hello world'));
    expect(r.level).toBe('exact');
  });

  it('multiple similar matches within threshold → ambiguous', () => {
    const r = ambiguous(cascadingMatch('xyz', 'axya bxyb'));
    expect(r.level).toBe('fuzzy');
    expect(r.matchCount).toBeGreaterThanOrEqual(2);
  });
});

describe('cascadingMatch — CRLF normalization', () => {
  it('CRLF full text + LF old string matches and preserves CRLF', () => {
    const fullText = 'line1\r\nline2\r\nline3';
    const oldString = 'line1\nline2';
    const r = found(cascadingMatch(oldString, fullText));
    expect(r.status).toBe('found');
    expect(fullText.substring(r.start, r.end)).toBe('line1\r\nline2');
  });

  it('LF full text + CRLF old string also matches', () => {
    const fullText = 'line1\nline2\nline3';
    const oldString = 'line1\r\nline2';
    const r = found(cascadingMatch(oldString, fullText));
    expect(r.status).toBe('found');
    expect(fullText.substring(r.start, r.end)).toBe('line1\nline2');
  });

  it('mixed CRLF and LF in same file handled', () => {
    const fullText = 'A\r\nB\nC\r\nD';
    const oldString = 'A\nB\nC\nD';
    const r = found(cascadingMatch(oldString, fullText));
    expect(r.status).toBe('found');
    expect(r.start).toBe(0);
    expect(r.end).toBe(fullText.length);
  });
});

describe('cascadingMatch — not_found with suggestions', () => {
  it('returns suggestions on complete miss', () => {
    const fullText = 'The quick brown fox jumps over the lazy dog';
    const oldString = 'completely different text';
    const r = notFound(cascadingMatch(oldString, fullText));
    expect(r.status).toBe('not_found');
    expect(r.suggestions).toBeDefined();
    expect(r.suggestions!.length).toBeGreaterThanOrEqual(1);
    expect(r.suggestions!.length).toBeLessThanOrEqual(3);
    for (const s of r.suggestions!) {
      expect(fullText.includes(s)).toBe(true);
    }
  });

  it('empty full text returns not_found with no suggestions', () => {
    const r = notFound(cascadingMatch('hello', ''));
    expect(r.status).toBe('not_found');
  });
});

describe('cascadingMatch — position mapping integrity', () => {
  it('trim_end: start/end point to original text positions', () => {
    const fullText = 'hello   \nworld';
    const r = found(cascadingMatch('hello   ', fullText));
    expect(r.start).toBeGreaterThanOrEqual(0);
    expect(r.end).toBeLessThanOrEqual(fullText.length);
    expect(r.start).toBeLessThan(r.end);
  });

  it('trim: start/end point to original text positions', () => {
    const fullText = '   indented code\n   more code';
    const r = found(cascadingMatch('  indented code', fullText));
    expect(r.start).toBeGreaterThanOrEqual(0);
    expect(r.end).toBeLessThanOrEqual(fullText.length);
    const matched = fullText.substring(r.start, r.end);
    expect(matched.includes('indented code')).toBe(true);
  });

  it('unicode: start/end map to original (non-normalized) text', () => {
    const fullText = '\u201Chello\u201D';
    const r = found(cascadingMatch('"hello"', fullText));
    const matched = fullText.substring(r.start, r.end);
    expect(matched).toBe('\u201Chello\u201D');
  });

  it('fuzzy: start/end map correctly to original text', () => {
    const fullText = 'The quick brown fox jumps';
    const r = found(cascadingMatch('quik brown fox', fullText));
    expect(r.level).toBe('fuzzy');
    const matched = fullText.substring(r.start, r.end);
    expect(matched).toContain('quick');
  });
});

describe('cascadingMatch — multi-match across every level', () => {
  it('exact level: multiple matches rejected', () => {
    const r = ambiguous(cascadingMatch('X', 'X Y X'));
    expect(r.level).toBe('exact');
    expect(r.matchCount).toBe(2);
  });

  it('trim_end level: multiple matches rejected', () => {
    const r = ambiguous(cascadingMatch('X  ', 'X\nY\nX'));
    expect(r.level).toBe('trim_end');
    expect(r.matchCount).toBe(2);
  });

  it('trim level: multiple matches rejected', () => {
    const fullText = '  abc\n  abc';
    const r = ambiguous(cascadingMatch('abc ', fullText));
    expect(r.level === 'trim_end' || r.level === 'trim').toBe(true);
    expect(r.matchCount).toBeGreaterThanOrEqual(2);
  });

  it('unicode level: multiple matches after normalization', () => {
    const fullText = 'hello\u00A0world and hello\u00A0world again';
    const oldString = 'hello world';
    const r = ambiguous(cascadingMatch(oldString, fullText));
    expect(r.level).toBe('unicode');
    expect(r.matchCount).toBe(2);
  });
});
