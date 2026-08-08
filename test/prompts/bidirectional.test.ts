import { describe, expect, it } from 'vitest'
import {
  BUILTIN_AGENT_ARCHETYPES,
  BUILTIN_AGENT_VARIANTS,
  BUILTIN_DIRECTION_BUNDLES,
} from '../../src/lib/prompts/bidirectional'

function allPromptText(): string {
  return [
    ...BUILTIN_AGENT_VARIANTS.map((variant) => variant.rolePrompt),
    ...BUILTIN_DIRECTION_BUNDLES.flatMap((bundle) => [
      bundle.mainAgentSystemPrompt,
      bundle.workerBasePrompt,
      bundle.reviewPrompt,
      bundle.filterPrompt,
      bundle.orchestratePrompt,
      bundle.assemblePrompt,
      bundle.editingPrompt,
      ...Object.values(bundle.toolDescriptions),
    ]),
  ].join('\n')
}

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

  it('keeps the complete prompt chain in the language of its direction', () => {
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
    expect(enToZh.mainAgentSystemPrompt).toContain('主编 Agent')
    expect(zhToEn.mainAgentSystemPrompt).toContain('managing editor')
    expect(Object.values(zhToEn.toolDescriptions).join(' ')).not.toMatch(
      /[\u3400-\u9fff]/u,
    )
  })

  it('gives each translating role detailed focus, examples, checks, and final annotation rules', () => {
    for (const variant of BUILTIN_AGENT_VARIANTS) {
      expect(variant.promptVersion).toBe(17)

      if (variant.archetypeId === 'cultural-context') {
        expect(variant.rolePrompt.length).toBeGreaterThan(600)
        expect(variant.rolePrompt).toMatch(
          variant.promptLanguage === 'zh'
            ? /# 分析范围[\s\S]+# 举例[\s\S]+# 输出要求/
            : /# Scope[\s\S]+# Example[\s\S]+# Output/,
        )
        expect(variant.rolePrompt).not.toContain(
          '系统会把最后一条独立“---”视为',
        )
        continue
      }

      expect(variant.rolePrompt.length).toBeGreaterThan(650)
      expect(variant.rolePrompt).toMatch(
        variant.promptLanguage === 'zh'
          ? /# 工作重点[\s\S]+# 举例[\s\S]+# 输出前检查/
          : /# Focus[\s\S]+# Example[\s\S]+# Final check/,
      )
      expect(variant.rolePrompt).toMatch(
        variant.promptLanguage === 'zh'
          ? /# 注释[\s\S]+最后一条独立“---”/
          : /# Annotation[\s\S]+final standalone "---"/,
      )
    }
  })

  it('keeps poetry-specific form out of the global translation defaults', () => {
    const bundle = BUILTIN_DIRECTION_BUNDLES.find(
      (item) => item.direction === 'en_to_zh',
    )!
    expect(bundle.workerBasePrompt).not.toContain('五言')
    expect(bundle.mainAgentSystemPrompt).not.toContain('五言')

    const poetry = BUILTIN_AGENT_VARIANTS.filter(
      (item) => item.archetypeId === 'poetry-form',
    )
    expect(poetry).toHaveLength(2)
    expect(poetry[0].rolePrompt).toMatch(/诗行|line/)
    expect(poetry[1].rolePrompt).toMatch(/诗行|line/)
  })

  it('forbids source-less dashes and semicolons throughout translation and editing prompts', () => {
    for (const bundle of BUILTIN_DIRECTION_BUNDLES) {
      expect(bundle.workerBasePrompt).toMatch(/破折号|dash/)
      expect(bundle.workerBasePrompt).toMatch(/分号|semicolon/)
      expect(bundle.editingPrompt).toMatch(/指定范围|requested scope/)
    }

    for (const variant of BUILTIN_AGENT_VARIANTS.filter(
      (item) => item.archetypeId !== 'cultural-context',
    )) {
      const bundle = BUILTIN_DIRECTION_BUNDLES.find(
        (item) => item.direction === variant.direction,
      )!
      const assembledWorkerPrompt = `${bundle.workerBasePrompt}\n${variant.rolePrompt}`
      expect(assembledWorkerPrompt).toMatch(/破折号|dash/)
      expect(assembledWorkerPrompt).toMatch(/分号|semicolon/)
    }
  })

  it('uses the final standalone divider throughout candidate and stage prompts', () => {
    for (const variant of BUILTIN_AGENT_VARIANTS.filter(
      (item) => item.archetypeId !== 'cultural-context',
    )) {
      expect(variant.rolePrompt).toMatch(/最后一条独立|final standalone/)
    }

    for (const bundle of BUILTIN_DIRECTION_BUNDLES) {
      expect(bundle.reviewPrompt).toMatch(/最后一条独立|final standalone/)
      expect(bundle.filterPrompt).toMatch(/最后一条独立|final standalone/)
      expect(bundle.orchestratePrompt).toMatch(
        /最后一条独立|final standalone/,
      )
      expect(bundle.assemblePrompt).toMatch(/最后一条独立|final standalone/)
      expect(bundle.version).toBe(21)
      expect(bundle.editingPrompt).toMatch(/Requirement and audit closure|要求与审查闭环/)
      expect(bundle.workerBasePrompt).toMatch(
        /explicit requirement|用户明确提出的要求/,
      )
      expect(bundle.reviewPrompt).toMatch(
        /advisory|只作辅助/,
      )
      expect(bundle.editingPrompt).toMatch(
        /patch[- ]regression|Patch 回归/i,
      )
    }
  })

  it('defines a natural-language body contract for every deliberation stage', () => {
    for (const bundle of BUILTIN_DIRECTION_BUNDLES) {
      expect(bundle.reviewPrompt).toMatch(
        /审查证据|review evidence/,
      )
      expect(bundle.reviewPrompt).toMatch(
        /不要在正文中另写一份完整译文|Do not replace the review body with another complete translation/,
      )
      expect(bundle.filterPrompt).toMatch(
        /选稿决策|decision record/,
      )
      expect(bundle.orchestratePrompt).toMatch(
        /完整的工作译稿|one complete working translation/,
      )
      expect(bundle.assemblePrompt).toMatch(
        /可修改的工作稿|editable working draft/,
      )
    }
  })

  it('keeps rhyme audit inventories out of the assembled translation body', () => {
    const enToZh = BUILTIN_DIRECTION_BUNDLES.find(
      (bundle) => bundle.direction === 'en_to_zh',
    )!
    const zhToEn = BUILTIN_DIRECTION_BUNDLES.find(
      (bundle) => bundle.direction === 'zh_to_en',
    )!
    expect(enToZh.assemblePrompt).toContain('诗歌成品私下校验')
    expect(enToZh.assemblePrompt).not.toContain('逐行列出每个句末字')
    expect(zhToEn.assemblePrompt).toContain('Private final poetry check')
    expect(zhToEn.assemblePrompt).not.toContain('List the stressed vowel')
  })

  it('keeps locked evaluation examples and the banned Chinese contrast pattern out of production prompts', () => {
    const combined = allPromptText()
    expect(combined).not.toMatch(/不是[\s\S]{0,80}而是/u)
    expect(combined).not.toMatch(
      /Jerome|Wells|Darwin|Lovelace|Hopkins|Hardy|Douglass|Auld|苏轼|张岱|沈复|王安石|明月几时有|Analytical Engine/u,
    )
  })
})
