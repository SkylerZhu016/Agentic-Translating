import { describe, expect, it } from 'vitest'
import { detectSystemPromptLeak } from '../../src/lib/guards/prompt-leak'

const systemPrompt = `你是英译中总成编辑。

# 组装工作
1. 执行编排中有依据的选择，并逐句回查原文。重新核对语义骨架、确定程度、句间逻辑、术语口径、数字单位、意象次序和结构。
2. 把编排正文当作可修改的工作稿。候选或编排共同采用的措辞仍需独立判断；发现翻译腔、错误术语或不自然搭配时，直接依据原文重写。
3. 提交前独立朗读译文，逐项确认关键词的词性、修饰对象、动宾关系与搭配。修复翻译腔造成的伪歧义，同时避免凭空扩写。`

describe('system prompt leak guard', () => {
  it('detects multiple substantial verbatim prompt lines', () => {
    const output = `${systemPrompt}

愿荣耀归于上帝。`
    const evidence = detectSystemPromptLeak(output, systemPrompt)
    expect(evidence?.matchedLineCount).toBeGreaterThanOrEqual(3)
    expect(evidence?.matchedCharacters).toBeGreaterThanOrEqual(160)
  })

  it('ignores one shared phrase and normal translation output', () => {
    const output =
      '愿荣耀归于上帝。译文逐句回查原文后，仍应当作为独立中文成品成立。'
    expect(detectSystemPromptLeak(output, systemPrompt)).toBeNull()
  })
})
