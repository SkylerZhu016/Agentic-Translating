import type { SemanticAgentOutput } from '../contracts/vnext'

/**
 * Parse the free-form semantic boundary protocol.
 *
 * Only the last line whose trimmed value is exactly `---` is a boundary.
 * Everything before it is downstream-visible body; everything after it is
 * human-facing annotation. The raw value is never rewritten.
 */
export function parseSemanticAgentOutput(raw: string): SemanticAgentOutput {
  const lines = raw.split(/\r\n?|\n/)
  let boundary = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() === '---') {
      boundary = index
      break
    }
  }

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
