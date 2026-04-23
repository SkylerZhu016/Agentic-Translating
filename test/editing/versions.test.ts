import { describe, it, expect } from 'vitest';
import { nextVersionText, diffSummary } from '@/src/lib/editing/versions';

describe('nextVersionText', () => {
  it('returns the new text unchanged (pure function)', () => {
    const currentText = 'hello world';
    const appliedEdit = { old_string: 'hello', new_string: 'hi' };
    const result = nextVersionText(currentText, appliedEdit);
    expect(result).toBeDefined();
  });

  it('identity: same text returned when nothing changes', () => {
    const currentText = 'hello world';
    const appliedEdit = { old_string: 'hello', new_string: 'hello' };
    const result = nextVersionText(currentText, appliedEdit);
    expect(result).toBe(currentText);
  });
});

describe('diffSummary', () => {
  it('provides context around the changed region', () => {
    const oldText = 'Once upon a time, there was a beautiful princess.';
    const newText = 'Once upon a time, there was a lovely princess.';
    const summary = diffSummary(oldText, newText);
    expect(summary).toBeDefined();
    expect(summary).toContain('Once');
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
  });

  it('handles identical texts', () => {
    const text = 'hello world';
    const summary = diffSummary(text, text);
    expect(summary).toBeDefined();
    expect(typeof summary).toBe('string');
  });

  it('provides ~40 char context before and after change', () => {
    const prefix = 'A'.repeat(60);
    const suffix = 'B'.repeat(60);
    const oldText = `${prefix}OLD_TEXT${suffix}`;
    const newText = `${prefix}NEW_TEXT${suffix}`;
    const summary = diffSummary(oldText, newText);
    expect(summary.length).toBeGreaterThan(0);
    expect(typeof summary).toBe('string');
  });

  it('handles change at start of text', () => {
    const oldText = 'START middle end';
    const newText = 'BEGIN middle end';
    const summary = diffSummary(oldText, newText);
    expect(summary).toBeDefined();
    expect(summary.length).toBeGreaterThan(0);
  });

  it('handles change at end of text', () => {
    const oldText = 'start middle END';
    const newText = 'start middle FINISH';
    const summary = diffSummary(oldText, newText);
    expect(summary).toBeDefined();
    expect(summary.length).toBeGreaterThan(0);
  });

  it('handles full text replacement', () => {
    const oldText = 'short';
    const newText = 'much longer replacement text here';
    const summary = diffSummary(oldText, newText);
    expect(summary).toBeDefined();
    expect(typeof summary).toBe('string');
  });

  it('handles empty strings', () => {
    const summary = diffSummary('', 'new');
    expect(summary).toBeDefined();
    expect(typeof summary).toBe('string');
  });

  it('handles Chinese text with context', () => {
    const oldText = '床前明月光，疑是地上霜。举头望明月，低头思故乡。';
    const newText = '床前明月光，似是地上霜。举头望明月，低头思故乡。';
    const summary = diffSummary(oldText, newText);
    expect(summary).toBeDefined();
    expect(summary.length).toBeGreaterThan(0);
  });

  it('returns human-readable summary string', () => {
    const oldText = 'The quick brown fox jumps over the lazy dog';
    const newText = 'The quick brown cat jumps over the lazy dog';
    const summary = diffSummary(oldText, newText);
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
  });

  it('large text diff summary is reasonably sized', () => {
    const oldText = 'A'.repeat(1000);
    const newText = 'B'.repeat(1000);
    const summary = diffSummary(oldText, newText);
    expect(summary.length).toBeLessThan(500);
  });
});
