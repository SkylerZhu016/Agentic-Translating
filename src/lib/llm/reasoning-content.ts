/**
 * Opt-in compatibility for providers that wrap reasoning in a leading
 * <think> block. This is deliberately not a general tag/HTML sanitizer:
 * once visible content starts, every subsequent character is kept verbatim.
 */
export class LeadingThinkFilter {
  private state: 'prefix' | 'reasoning' | 'content' = 'prefix';
  private pending = '';

  constructor(private readonly onReasoning: (fragment: string) => void) {}

  push(fragment: string): string {
    if (!fragment) return '';
    if (this.state === 'content') return fragment;

    let input = this.pending + fragment;
    this.pending = '';
    if (this.state === 'prefix') {
      const leadingWhitespace = input.match(/^\s*/)?.[0].length ?? 0;
      const candidate = input.slice(leadingWhitespace);
      // Keep the undecided prefix bounded even for whitespace-only output.
      if (leadingWhitespace <= 256 && '<think>'.startsWith(candidate)) {
        this.pending = input;
        if (candidate !== '<think>') return '';
      }
      if (leadingWhitespace > 256 || !candidate.startsWith('<think>')) {
        this.state = 'content';
        return input;
      }
      this.state = 'reasoning';
      this.pending = '';
      input = candidate.slice('<think>'.length);
    }

    const closingTag = '</think>';
    const closeIndex = input.indexOf(closingTag);
    if (closeIndex >= 0) {
      if (closeIndex) this.onReasoning(input.slice(0, closeIndex));
      this.state = 'content';
      return input.slice(closeIndex + closingTag.length);
    }

    // Only the possible closing-tag suffix survives between chunks.
    let pendingLength = Math.min(input.length, closingTag.length - 1);
    while (pendingLength && !closingTag.startsWith(input.slice(-pendingLength))) {
      pendingLength -= 1;
    }
    const reasoning = pendingLength ? input.slice(0, -pendingLength) : input;
    if (reasoning) this.onReasoning(reasoning);
    this.pending = pendingLength ? input.slice(-pendingLength) : '';
    return '';
  }

  finish(): { content: string; incomplete: boolean } {
    if (this.state === 'reasoning') {
      if (this.pending) this.onReasoning(this.pending);
      this.pending = '';
      return { content: '', incomplete: true };
    }
    if (this.state === 'prefix' && this.pending.trim()) {
      this.pending = '';
      return { content: '', incomplete: true };
    }
    const content = this.pending;
    this.pending = '';
    this.state = 'content';
    return { content, incomplete: false };
  }
}
