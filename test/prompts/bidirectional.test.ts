import { describe, expect, it } from 'vitest'
import {
  BUILTIN_AGENT_ARCHETYPES,
  BUILTIN_AGENT_VARIANTS,
  BUILTIN_DIRECTION_BUNDLES,
} from '../../src/lib/prompts/bidirectional'

describe('bidirectional built-in catalog', () => {
  it('defines 10 archetypes and exactly 20 paired variants', () => {
    expect(BUILTIN_AGENT_ARCHETYPES).toHaveLength(10)
    expect(BUILTIN_AGENT_VARIANTS).toHaveLength(20)
    for (const archetype of BUILTIN_AGENT_ARCHETYPES) {
      const variants = BUILTIN_AGENT_VARIANTS.filter(
        (variant) => variant.archetypeId === archetype.id,
      )
      expect(variants).toHaveLength(2)
      expect(new Set(variants.map((variant) => variant.direction))).toEqual(
        new Set(['en_to_zh', 'zh_to_en']),
      )
    }
  })

  it('keeps prompt language aligned throughout each direction', () => {
    const chinese = BUILTIN_AGENT_VARIANTS.filter(
      (variant) => variant.direction === 'en_to_zh',
    )
    const english = BUILTIN_AGENT_VARIANTS.filter(
      (variant) => variant.direction === 'zh_to_en',
    )
    expect(chinese).toHaveLength(10)
    expect(english).toHaveLength(10)
    expect(chinese.every((variant) => variant.promptLanguage === 'zh')).toBe(
      true,
    )
    expect(english.every((variant) => variant.promptLanguage === 'en')).toBe(
      true,
    )

    const enToZh = BUILTIN_DIRECTION_BUNDLES.find(
      (bundle) => bundle.direction === 'en_to_zh',
    )!
    const zhToEn = BUILTIN_DIRECTION_BUNDLES.find(
      (bundle) => bundle.direction === 'zh_to_en',
    )!
    expect(enToZh.promptLanguage).toBe('zh')
    expect(zhToEn.promptLanguage).toBe('en')
    expect(enToZh.mainAgentSystemPrompt).toContain('主编 Agent')
    expect(zhToEn.mainAgentSystemPrompt).toContain('managing editor')
    expect(Object.values(zhToEn.toolDescriptions).join(' ')).not.toMatch(
      /[\u3400-\u9fff]/u,
    )
  })

  it('keeps five-character verse out of the global English-to-Chinese defaults', () => {
    const bundle = BUILTIN_DIRECTION_BUNDLES.find(
      (item) => item.direction === 'en_to_zh',
    )!
    expect(bundle.workerBasePrompt).not.toContain('五言')
    expect(bundle.mainAgentSystemPrompt).not.toContain('五言')
  })
})
