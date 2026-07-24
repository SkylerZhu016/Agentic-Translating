import type { SemanticAgentOutput } from '../contracts/vnext'

/**
 * Parse the free-form semantic boundary protocol.
 *
 * Only the first line whose trimmed value is exactly `---` is a boundary.
 * Everything before it is downstream-visible body; everything after it is
 * human-facing annotation. The raw value is never rewritten.
 */
export function parseSemanticAgentOutput(raw: string): SemanticAgentOutput {
  const lines = raw.split(/\r?\n/)
  const boundary = lines.findIndex((line) => line.trim() === '---')

  if (boundary < 0) {
    return {
      raw,
      body: raw.trim(),
      annotation: null,
    }
  }

  const body = lines.slice(0, boundary).join('\n').trim()
  const annotationText = lines.slice(boundary + 1).join('\n').trim()

  return {
    raw,
    body,
    annotation: annotationText.length > 0 ? annotationText : null,
  }
}

export function semanticBody(raw: string | null | undefined): string {
  return parseSemanticAgentOutput(raw ?? '').body
}
