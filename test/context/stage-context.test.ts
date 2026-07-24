import { describe, it, expect } from 'vitest'
import { buildStageContext, buildChatContext } from '../../src/lib/context/stage-context'
import { estimateTokens } from '../../src/lib/guards/tokens'
import type { TranslationResult, StageOutput, ChatMessage } from '../../src/lib/contracts/types'
import { STAGE_CONTEXT_TOKEN_BUDGET, CHAT_CONTEXT_TURNS } from '../../src/lib/constants'

// ─── Helpers ─────────────────────────────────────────────────────

function trans(overrides: Partial<TranslationResult> = {}): TranslationResult {
  return {
    id: 1,
    session_id: 'sess_01J',
    agent_key: 'agent1',
    agent_snapshot: JSON.stringify({ name: 'Agent 1', model: 'gpt-4' }),
    status: 'complete',
    output_text: 'Hello',
    error: null,
    latency_ms: 100,
    attempt: 1,
    ...overrides,
  }
}

function stageOut(overrides: Partial<StageOutput> = {}): StageOutput {
  return {
    id: 1,
    session_id: 'sess_01J',
    stage: 'review',
    status: 'complete',
    prompt_used: null,
    raw_output: null,
    error: null,
    ...overrides,
  }
}

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 1,
    session_id: 'sess_01J',
    role: 'user',
    content: 'test message',
    tool_calls: null,
    tool_results: null,
    version_id: null,
    created_at: '2026-07-18T00:00:00Z',
    ...overrides,
  }
}

/** Generate N chat messages with sequential content */
function nMessages(n: number): ChatMessage[] {
  const out: ChatMessage[] = []
  for (let i = 1; i <= n; i++) {
    out.push(
      msg({
        id: i,
        role: i % 2 === 1 ? 'user' : 'assistant',
        content: `Message ${i}`,
        created_at: `2026-07-18T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
      }),
    )
  }
  return out
}

/** Repeat a CJK character N times for predictable token sizing (1 char = 1 token) */
function cjkText(count: number): string {
  return '翻'.repeat(count)
}

// =============================================================================
// buildStageContext
// =============================================================================

describe('buildStageContext', () => {
  it('should produce correct JSON shape with no truncation', () => {
    const result = buildStageContext('orchestrate', {
      sourceText: 'Hello world',
      sourceLang: 'en',
      targetLang: 'zh',
      translations: [
        trans({ agent_key: 'agent1', agent_snapshot: JSON.stringify({ name: 'Alpha', model: 'gpt-4' }), output_text: '你好世界' }),
      ],
      priorStages: [
        stageOut({ stage: 'review', raw_output: JSON.stringify({ assessments: [{ agent_id: 'agent1', keep: true }] }) }),
        stageOut({ stage: 'filter', raw_output: JSON.stringify({ selected_agent_ids: ['agent1'], rejected_agent_ids: [], rationale: 'good' }) }),
      ],
    })

    expect(result.truncated).toBe(false)
    expect(result.json.source).toEqual({ text: 'Hello world', from: 'en', to: 'zh' })
    expect(result.json.translations).toHaveLength(1)
    expect(result.json.translations[0]).toEqual({
      agent_id: 'agent1',
      name: 'Alpha',
      model: 'gpt-4',
      text: '你好世界',
    })
    expect(result.json.prior_stages.review).toBeDefined()
    expect(result.json.prior_stages.filter).toBeDefined()
    expect(result.json.prior_stages.orchestrate).toBeUndefined()
  })

  it('should omit prior_stages entries for absent stages', () => {
    const result = buildStageContext('review', {
      sourceText: 'Hi',
      sourceLang: 'en',
      targetLang: 'fr',
      translations: [],
      priorStages: [],
    })

    expect(result.json.prior_stages.review).toBeUndefined()
    expect(result.json.prior_stages.filter).toBeUndefined()
    expect(result.json.prior_stages.orchestrate).toBeUndefined()
    expect(result.truncated).toBe(false)
  })

  it('should include only review/filter/orchestrate in prior_stages (not assemble)', () => {
    const result = buildStageContext('orchestrate', {
      sourceText: 'Hi',
      sourceLang: 'en',
      targetLang: 'fr',
      translations: [],
      priorStages: [
        stageOut({ stage: 'review', raw_output: '{"assessments":[]}' }),
        stageOut({ stage: 'filter', raw_output: '{"selected_agent_ids":[],"rejected_agent_ids":[],"rationale":"ok"}' }),
        stageOut({ stage: 'orchestrate', raw_output: '{"structure_notes":"ok","segment_assignments":[]}' }),
        stageOut({ stage: 'assemble', raw_output: '{"final_text":"done"}' }),
      ],
    })

    expect(result.json.prior_stages.review).toBeDefined()
    expect(result.json.prior_stages.filter).toBeDefined()
    expect(result.json.prior_stages.orchestrate).toBeDefined()
    // assemble must NOT appear in prior_stages
    expect(Object.keys(result.json.prior_stages)).not.toContain('assemble')
  })

  // ── Token budget / truncation ──

  it('should keep every candidate when the legacy budget is exceeded', () => {
    // 6 translations, each 2000 CJK chars = 2000 tokens from text alone
    // This deliberately exceeds the old 6000-token budget. vNext must retain
    // the complete context and let the configured model report overflow.
    const allAgentKeys = ['agent1', 'agent2', 'agent3', 'agent4', 'agent5', 'agent6']
    const translations = allAgentKeys.map((k, i) =>
      trans({
        id: i + 1,
        agent_key: k,
        agent_snapshot: JSON.stringify({ name: `Agent ${i + 1}`, model: 'gpt-4' }),
        output_text: cjkText(2000),
      }),
    )

    const result = buildStageContext(
      'orchestrate',
      {
        sourceText: 'Hello world',
        sourceLang: 'en',
        targetLang: 'zh',
        translations,
        priorStages: [
          stageOut({
            stage: 'filter',
            raw_output: JSON.stringify({
              selected_agent_ids: ['agent1', 'agent3', 'agent4', 'agent6'],
              rejected_agent_ids: ['agent2', 'agent5'],
              rationale: 'quality filter',
            }),
          }),
        ],
      },
      STAGE_CONTEXT_TOKEN_BUDGET, // 6000
    )

    expect(result.truncated).toBe(false)
    expect(result.json.translations).toHaveLength(6)
    expect(result.json.translations.every((entry) => entry.text.length === 2000)).toBe(true)

    // Prove that the legacy budget argument no longer causes silent deletion.
    const jsonString = JSON.stringify(result.json)
    const finalTokens = estimateTokens(jsonString)
    expect(finalTokens).toBeGreaterThan(STAGE_CONTEXT_TOKEN_BUDGET)
  })

  // ── Body extraction from raw_output via `---` split ──

  it('should strip annotation after --- separator in prior_stages body', () => {
    const raw = '正文内容\n---\n这是注释部分，不应出现在 body 中'
    const result = buildStageContext('orchestrate', {
      sourceText: 'Hi',
      sourceLang: 'en',
      targetLang: 'fr',
      translations: [],
      priorStages: [stageOut({ stage: 'review', raw_output: raw })],
    })
    expect(result.json.prior_stages.review).toBeDefined()
    expect(result.json.prior_stages.review!.body).toBe('正文内容')
    // The annotation must NOT appear in the body
    expect(result.json.prior_stages.review!.body).not.toContain('注释')
  })

  it('should use the full raw_output as body when no --- separator present', () => {
    const raw = '完整的审查意见，没有注释分隔'
    const result = buildStageContext('orchestrate', {
      sourceText: 'Hi',
      sourceLang: 'en',
      targetLang: 'fr',
      translations: [],
      priorStages: [stageOut({ stage: 'review', raw_output: raw })],
    })
    expect(result.json.prior_stages.review!.body).toBe(raw)
  })

  it('should produce empty body when raw_output is null/empty', () => {
    const result1 = buildStageContext('orchestrate', {
      sourceText: 'Hi',
      sourceLang: 'en',
      targetLang: 'fr',
      translations: [],
      priorStages: [stageOut({ stage: 'review', raw_output: null })],
    })
    expect(result1.json.prior_stages.review!.body).toBe('')

    const result2 = buildStageContext('orchestrate', {
      sourceText: 'Hi',
      sourceLang: 'en',
      targetLang: 'fr',
      translations: [],
      priorStages: [stageOut({ stage: 'review', raw_output: '' })],
    })
    expect(result2.json.prior_stages.review!.body).toBe('')
  })

  it('dropRejectedTexts is no longer exported (function removed)', async () => {
    // The function was removed during the refactor; the named export must be
    // undefined on the module namespace.
    const mod = await import('../../src/lib/context/stage-context')
    expect((mod as Record<string, unknown>).dropRejectedTexts).toBeUndefined()
  })

  it('parseAgentSnapshot still works (regression test)', () => {
    // parseAgentSnapshot is invoked internally; we verify behavior via the
    // translations array. Invalid JSON → name/model 'unknown'; valid JSON →
    // parsed values.
    const result = buildStageContext('review', {
      sourceText: 'Hi',
      sourceLang: 'en',
      targetLang: 'fr',
      translations: [
        trans({
          agent_key: 'broken',
          agent_snapshot: '{not valid json}',
          output_text: 'Bonjour',
        }),
        trans({
          id: 2,
          agent_key: 'good',
          agent_snapshot: JSON.stringify({ name: 'Good Agent', model: 'claude-3' }),
          output_text: 'Salut',
        }),
      ],
      priorStages: [],
    })
    const broken = result.json.translations.find((t) => t.agent_id === 'broken')!
    expect(broken.name).toBe('unknown')
    expect(broken.model).toBe('unknown')
    expect(broken.text).toBe('Bonjour')

    const good = result.json.translations.find((t) => t.agent_id === 'good')!
    expect(good.name).toBe('Good Agent')
    expect(good.model).toBe('claude-3')
    expect(good.text).toBe('Salut')
  })

  it('should handle empty translations array gracefully', () => {
    const result = buildStageContext('orchestrate', {
      sourceText: 'Hi',
      sourceLang: 'en',
      targetLang: 'ja',
      translations: [],
      priorStages: [],
    })

    expect(result.json.translations).toEqual([])
    expect(result.truncated).toBe(false)
  })

  it('should not truncate when within budget', () => {
    const result = buildStageContext('review', {
      sourceText: 'Hello',
      sourceLang: 'en',
      targetLang: 'de',
      translations: [
        trans({ output_text: 'Hallo' }),
      ],
      priorStages: [],
    }, STAGE_CONTEXT_TOKEN_BUDGET)

    expect(result.truncated).toBe(false)
    const jsonString = JSON.stringify(result.json)
    expect(estimateTokens(jsonString)).toBeLessThanOrEqual(STAGE_CONTEXT_TOKEN_BUDGET)
  })

  it('should parse agent_snapshot gracefully when it is invalid JSON', () => {
    const result = buildStageContext('review', {
      sourceText: 'Hi',
      sourceLang: 'en',
      targetLang: 'fr',
      translations: [
        trans({
          agent_key: 'agent1',
          agent_snapshot: '{invalid json}',
          output_text: 'Bonjour',
        }),
      ],
      priorStages: [],
    })

    expect(result.json.translations[0].name).toBe('unknown')
    expect(result.json.translations[0].model).toBe('unknown')
    expect(result.json.translations[0].text).toBe('Bonjour')
  })
})

// =============================================================================
// buildChatContext
// =============================================================================

describe('buildChatContext', () => {
  it('should prepend system message with current text', () => {
    const messages = nMessages(3)
    const result = buildChatContext(messages, '最新译文', 20)

    expect(result[0].role).toBe('system')
    expect(result[0].content).toContain('最新译文')
    expect(result[0].content).toContain('replace_text')
  })

  it('should keep all messages when under maxTurns', () => {
    const messages = nMessages(5)
    const result = buildChatContext(messages, 'Hello', 20)

    // system + 5 messages (no omission)
    expect(result).toHaveLength(6)
    expect(result[1].role).toBe('user')
    expect(result[1].content).toBe('Message 1')
    expect(result[result.length - 1].content).toBe('Message 5')
  })

  it('should retain every message when the legacy maxTurns value is exceeded', () => {
    const maxTurns = 10
    const totalMessages = 25
    const messages = nMessages(totalMessages)
    const result = buildChatContext(messages, '当前文本', maxTurns)

    expect(result).toHaveLength(1 + totalMessages)
    expect(result[0].role).toBe('system')
    expect(result[0].content).toContain('当前文本')
    expect(result[1].role).toBe('user')
    expect(result[1].content).toBe('Message 1')
    expect(result[result.length - 1].role).toBe('user')
    expect(result[result.length - 1].content).toBe('Message 25')
  })

  it('should retain all messages beyond the legacy default turn count', () => {
    const totalMessages = CHAT_CONTEXT_TURNS + 5 // 25
    const messages = nMessages(totalMessages)
    const result = buildChatContext(messages, '文本')

    expect(result).toHaveLength(1 + totalMessages)
  })

  it('should handle exactly maxTurns messages without truncation', () => {
    const messages = nMessages(CHAT_CONTEXT_TURNS)
    const result = buildChatContext(messages, 'hello')

    // system + all messages = 21 entries, no omission placeholder
    expect(result).toHaveLength(1 + CHAT_CONTEXT_TURNS)
    // No omission entry (check that second entry is not a system omission)
    expect(result[1].role).not.toBe('system') // should be the first user message
  })

  it('should preserve role of each kept message', () => {
    const messages = nMessages(6)
    // odd = user, even = assistant
    const result = buildChatContext(messages, 'text', 10)

    for (let i = 1; i < result.length; i++) {
      const origIdx = i - 1
      if (origIdx % 2 === 0) {
        expect(result[i].role).toBe('user')
      } else {
        expect(result[i].role).toBe('assistant')
      }
    }
  })
})
