import { describe, expect, it } from 'vitest'
import { BUILTIN_AGENT_VARIANTS } from '../../src/lib/prompts/bidirectional'
import {
  buildDynamicFallbackTeam,
  inferRequiredDynamicArchetypes,
  poetryPlanningEnabled,
} from '../../src/lib/orchestration/vnext-runner'

describe('dynamic team policy', () => {
  it('always keeps fidelity, naturalness, and form in competition for classical Chinese verse', () => {
    expect(
      inferRequiredDynamicArchetypes(
        '相见时难别亦难，东风无力百花残。春蚕到死丝方尽，蜡炬成灰泪始干。晓镜但愁云鬓改，夜吟应觉月光寒。蓬山此去无多路，青鸟殷勤为探看。',
      ),
    ).toEqual(['semantic-fidelity', 'target-naturalness', 'poetry-form'])
  })

  it('always keeps fidelity, naturalness, and form in competition for lineated English poetry', () => {
    expect(
      inferRequiredDynamicArchetypes(
        'One line\nA second line\nA third line\nA fourth line',
      ),
    ).toEqual(['semantic-fidelity', 'target-naturalness', 'poetry-form'])
  })

  it('keeps the general fallback pair for ordinary prose', () => {
    expect(
      inferRequiredDynamicArchetypes('A short ordinary paragraph.'),
    ).toEqual(['semantic-fidelity', 'target-naturalness'])
  })

  it('honours explicit poetry enable and disable settings', () => {
    expect(
      inferRequiredDynamicArchetypes(
        'A deliberately ambiguous one-line text.',
        '',
        { poetryMode: 'on' },
      ),
    ).toEqual(['semantic-fidelity', 'target-naturalness', 'poetry-form'])
    expect(
      inferRequiredDynamicArchetypes(
        'Line one\nLine two\nLine three\nLine four',
        '',
        { poetryMode: 'off' },
      ),
    ).toEqual(['semantic-fidelity', 'target-naturalness'])
  })

  it('repairs the invalid-tool fallback into a three-role poetry team that enables planning', () => {
    const allowed = BUILTIN_AGENT_VARIANTS.filter(
      (variant) => variant.direction === 'en_to_zh',
    )
    const enforced = buildDynamicFallbackTeam(
      {
        id: 'poetry-fallback',
        source_text: 'One line\nTwo lines\nThree lines\nFour lines',
        source_lang: 'English',
        target_lang: 'Chinese',
        state: 'draft',
        task_brief: 'Translate this poem.',
        config_snapshot: '{}',
      },
      allowed,
      { poetryMode: 'on' },
    )
    const archetypeIds = enforced.map((item) => item.variant.archetypeId)

    expect(archetypeIds).toEqual([
      'semantic-fidelity',
      'target-naturalness',
      'poetry-form',
    ])
    expect(poetryPlanningEnabled({ isPoetry: true }, archetypeIds)).toBe(true)
  })
})
