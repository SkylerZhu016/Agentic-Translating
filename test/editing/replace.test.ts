import { describe, it, expect } from 'vitest';
import { applyReplacement, applyReplacementBatch } from '@/src/lib/editing/replace';
import type { ReplaceResult, BatchResult } from '@/src/lib/editing/replace';

describe('applyReplacement — single', () => {
  it('exact match replaces correctly', () => {
    const r = applyReplacement('hello world', 'hello', 'hi') as Extract<ReplaceResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.newText).toBe('hi world');
    expect(r.level).toBe('exact');
  });

  it('trim_end match succeeds and replaces', () => {
    const fullText = 'hello\nworld';
    const r = applyReplacement(fullText, 'hello  ', 'hi') as Extract<ReplaceResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.newText).toBe('hi\nworld');
    expect(r.level).toBe('trim_end');
  });

  it('trim match succeeds and replaces', () => {
    const fullText = 'hello world';
    const r = applyReplacement(fullText, '  hello world', 'hi') as Extract<ReplaceResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.newText).toBe('hi');
    expect(r.level).toBe('trim');
  });

  it('unicode match succeeds and replaces preserving original formatting', () => {
    const fullText = 'He said \u201Chello\u201D';
    const r = applyReplacement(fullText, '"hello"', '"hi"') as Extract<ReplaceResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.newText).toBe('He said "hi"');
    expect(r.level).toBe('unicode');
  });

  it('fuzzy match succeeds and replaces', () => {
    const fullText = 'hello world';
    const r = applyReplacement(fullText, 'helo world', 'hi there') as Extract<ReplaceResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.newText).toBe('hi there');
    expect(r.level).toBe('fuzzy');
  });

  it('ambiguous match returns false with reason', () => {
    const r = applyReplacement('X Y X', 'X', 'Z') as Extract<ReplaceResult, { ok: false }>;
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('ambiguous');
    expect(r.matchCount).toBe(2);
  });

  it('not_found returns false with reason and suggestions', () => {
    const r = applyReplacement('hello world', 'xyz', 'abc') as Extract<ReplaceResult, { ok: false }>;
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('not found');
    expect(r.suggestions).toBeDefined();
  });

  it('oldString equals newString → no error but level preserved', () => {
    const r = applyReplacement('hello world', 'hello', 'hello') as Extract<ReplaceResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.newText).toBe('hello world');
    expect(r.level).toBe('exact');
  });

  it('CRLF text preserved through replacement', () => {
    const fullText = 'line1\r\nline2\r\nline3';
    const r = applyReplacement(fullText, 'line2', 'LINE2') as Extract<ReplaceResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.newText).toBe('line1\r\nLINE2\r\nline3');
  });

  it('replace with empty string works', () => {
    const r = applyReplacement('hello world', ' world', '') as Extract<ReplaceResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.newText).toBe('hello');
  });

  it('replace entire text with new content', () => {
    const r = applyReplacement('old text', 'old text', 'new text') as Extract<ReplaceResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.newText).toBe('new text');
  });
});

describe('applyReplacementBatch — transactional', () => {
  it('single edit batch succeeds', () => {
    const r = applyReplacementBatch('hello world', [
      { old_string: 'hello', new_string: 'hi' },
    ]) as Extract<BatchResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.newText).toBe('hi world');
  });

  it('multiple edits applied in sequence', () => {
    const r = applyReplacementBatch('hello beautiful world', [
      { old_string: 'hello', new_string: 'hi' },
      { old_string: 'beautiful', new_string: 'lovely' },
    ]) as Extract<BatchResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.newText).toBe('hi lovely world');
  });

  it('transactional: one edit fails → entire batch rolls back, original unchanged', () => {
    const original = 'A B C';
    const r = applyReplacementBatch(original, [
      { old_string: 'A', new_string: 'X' },
      { old_string: '不存在', new_string: 'Y' },
    ]) as Extract<BatchResult, { ok: false }>;
    expect(r.ok).toBe(false);
    expect(r.failedIndex).toBe(1);
    expect(r.reason).toBeDefined();
    if ('newText' in r) {
      expect(r.newText).toBe(original);
    }
  });

  it('transactional: second edit fails, third not attempted', () => {
    const original = 'first second third';
    const r = applyReplacementBatch(original, [
      { old_string: 'first', new_string: '1st' },
      { old_string: 'nonexistent', new_string: 'X' },
      { old_string: 'third', new_string: '3rd' },
    ]) as Extract<BatchResult, { ok: false }>;
    expect(r.ok).toBe(false);
    expect(r.failedIndex).toBe(1);
  });

  it('no-op edit (new==old) skipped without error', () => {
    const r = applyReplacementBatch('hello world', [
      { old_string: 'hello', new_string: 'hello' },
      { old_string: 'world', new_string: 'earth' },
    ]) as Extract<BatchResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.newText).toBe('hello earth');
  });

  it('all edits are no-ops → text unchanged', () => {
    const r = applyReplacementBatch('hello world', [
      { old_string: 'hello', new_string: 'hello' },
      { old_string: 'world', new_string: 'world' },
    ]) as Extract<BatchResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.newText).toBe('hello world');
  });

  it('empty batch returns original text', () => {
    const r = applyReplacementBatch('hello world', []) as Extract<BatchResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.newText).toBe('hello world');
  });

  it('ambitious batch: all different match levels succeed transactionally', () => {
    const fullText = 'hello\nworld\n  foo bar  ';
    const r = applyReplacementBatch(fullText, [
      { old_string: 'hello   ', new_string: 'hi' },
      { old_string: 'world', new_string: 'earth' },
      { old_string: '  foo bar', new_string: 'baz' },
    ]) as Extract<BatchResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.newText).toContain('hi');
    expect(r.newText).toContain('earth');
    expect(r.newText).toContain('baz');
  });

  it('ambiguous match in batch → fails with reason', () => {
    const r = applyReplacementBatch('X Y X', [
      { old_string: 'X', new_string: 'Z' },
    ]) as Extract<BatchResult, { ok: false }>;
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('ambiguous');
  });

  it('batch preserves CRLF line endings', () => {
    const fullText = 'A\r\nB\r\nC';
    const r = applyReplacementBatch(fullText, [
      { old_string: 'B', new_string: 'BB' },
    ]) as Extract<BatchResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.newText).toBe('A\r\nBB\r\nC');
  });
});
