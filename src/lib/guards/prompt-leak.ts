export interface PromptLeakEvidence {
  matchedLineCount: number
  matchedCharacters: number
  matchedLines: string[]
}

/**
 * Detects substantial verbatim system-prompt echo in a model's visible output.
 * Short shared phrases are ignored so legitimate translation wording does not
 * trigger the guard.
 */
export function detectSystemPromptLeak(
  output: string,
  systemPrompt: string,
): PromptLeakEvidence | null {
  const normalizedOutput = output.replace(/\r\n?/g, '\n')
  const significantLines = [
    ...new Set(
      systemPrompt
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length >= 45),
    ),
  ]
  const matchedLines = significantLines.filter((line) =>
    normalizedOutput.includes(line),
  )
  const matchedCharacters = matchedLines.reduce(
    (sum, line) => sum + line.length,
    0,
  )
  if (matchedLines.length < 3 || matchedCharacters < 160) return null
  return {
    matchedLineCount: matchedLines.length,
    matchedCharacters,
    matchedLines,
  }
}
