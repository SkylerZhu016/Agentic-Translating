import { describe, expect, it } from 'vitest'
import {
  chooseContextAnalysisBindings,
  contextAnalysisLens,
} from '../../src/lib/orchestration/vnext-runner'

const binding = (model: string, endpointId = 1) => ({
  model,
  endpointId,
  contextWindow: 256000,
})

describe('context analysis binding selection', () => {
  it('preserves two explicit independent calls using the same model', () => {
    const configured = [binding('DeepSeek V4 Flash'), binding('DeepSeek V4 Flash')]
    expect(chooseContextAnalysisBindings(configured, [])).toEqual(configured)
  })

  it('deduplicates models only for automatic fallback', () => {
    expect(
      chooseContextAnalysisBindings(undefined, [
        binding('flash'),
        binding('flash', 2),
        binding('glm'),
      ]),
    ).toEqual([binding('flash'), binding('glm')])
  })

  it('assigns different responsibilities when two calls share one model', () => {
    const primary = contextAnalysisLens('en', 0)
    const ambiguity = contextAnalysisLens('en', 1)
    expect(primary).not.toBe(ambiguity)
    expect(primary).toContain('proper nouns')
    expect(ambiguity).toContain('plausible counter-readings')
    expect(ambiguity).toContain('explicit user brief')
  })
})
