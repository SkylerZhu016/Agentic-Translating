/**
 * Flash model detection — R2: warn users when the coordinator is configured
 * with a flash-tier model (not recommended for orchestration).
 *
 * Uses word-boundary matching: "flash" must be a standalone token surrounded
 * by non-letter characters or string edges. This prevents false positives
 * like "reflash-model" or "flashy".
 *
 * @param modelName - The model identifier string (e.g. "gemini-1.5-flash")
 * @returns true if the model name contains the word "flash" at word boundaries
 */
export function detectFlashModel(modelName: string): boolean {
  // Word-boundary regex: flash preceded by start-of-string or non-letter,
  // followed by end-of-string or non-letter. Case-insensitive.
  return /(^|[^a-z])flash([^a-z]|$)/i.test(modelName)
}
