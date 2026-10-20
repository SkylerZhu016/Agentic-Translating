/** Only an explicit marker line opts a frozen prompt into integrated review. */
export const INTEGRATED_REVIEW_MARKER = '[review:integrated-v1]'

export function reviewExecutionStrategy(
  prompt: string,
): 'integrated' | 'independent_lenses' {
  return prompt.split(/\r?\n/).some((line) => line.trim() === INTEGRATED_REVIEW_MARKER)
    ? 'integrated'
    : 'independent_lenses'
}

export function reviewCallCount(prompt: string): 1 | 3 {
  return reviewExecutionStrategy(prompt) === 'integrated' ? 1 : 3
}
