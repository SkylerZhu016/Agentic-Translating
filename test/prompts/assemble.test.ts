import { describe, it, expect } from 'vitest'
import {
  interpolate,
  resolveTranslatorPrompt,
  buildTranslatorPrompt,
  buildStagePrompt,
  PromptAssemblyError,
} from '@/src/lib/prompts/assemble'
import type { ChatMessageInput } from '@/src/lib/prompts/assemble'

// ---------------------------------------------------------------------------
// PromptAssemblyError
// ---------------------------------------------------------------------------
describe('PromptAssemblyError', () => {
  it('should be an instance of Error', () => {
    const err = new PromptAssemblyError(['foo', 'bar'])
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(PromptAssemblyError)
    expect(err.name).toBe('PromptAssemblyError')
  })

  it('should expose missingVars', () => {
    const err = new PromptAssemblyError(['source_text', 'target_lang'])
    expect(err.missingVars).toEqual(['source_text', 'target_lang'])
  })

  it('should produce a readable message', () => {
    const err = new PromptAssemblyError(['x'])
    expect(err.message).toContain('x')
  })
})

// ---------------------------------------------------------------------------
// ChatMessageInput (type-level — check structural shape)
// ---------------------------------------------------------------------------
describe('ChatMessageInput', () => {
  it('should allow valid system and user messages', () => {
    const msg1: ChatMessageInput = { role: 'system', content: 'hello' }
    const msg2: ChatMessageInput = { role: 'user', content: 'world' }
    expect(msg1.role).toBe('system')
    expect(msg2.role).toBe('user')
  })
})

// ---------------------------------------------------------------------------
// interpolate
// ---------------------------------------------------------------------------
describe('interpolate', () => {
  it('replaces {{var}} with the corresponding value', () => {
    const { result } = interpolate('Hello {{name}}', { name: 'World' })
    expect(result).toBe('Hello World')
  })

  it('replaces multiple variables', () => {
    const { result } = interpolate('{{a}} + {{b}} = {{c}}', {
      a: '1',
      b: '2',
      c: '3',
    })
    expect(result).toBe('1 + 2 = 3')
  })

  it('returns template unchanged when there are no {{}} patterns', () => {
    const { result } = interpolate('Hello World', {})
    expect(result).toBe('Hello World')
  })

  it('handles empty template', () => {
    const { result } = interpolate('', { x: 'y' })
    expect(result).toBe('')
  })

  it('handles values with special characters', () => {
    const { result } = interpolate('{{text}}', {
      text: 'Hello "World" & <Friends>',
    })
    expect(result).toBe('Hello "World" & <Friends>')
  })

  it('throws PromptAssemblyError when a {{var}} has no matching key in vars', () => {
    expect(() => interpolate('Hello {{name}}', {})).toThrow(PromptAssemblyError)
  })

  it('throws with all missing variable names listed', () => {
    try {
      interpolate('{{a}} + {{b}} = {{c}}', { a: '1' })
      // force fail if no throw
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(PromptAssemblyError)
      const err = e as PromptAssemblyError
      // b and c are missing; a is present
      expect(err.missingVars).toEqual(
        expect.arrayContaining(['b', 'c']),
      )
      expect(err.missingVars).not.toContain('a')
    }
  })

  it('preserves unknown {{var}} in the result when keepUnknown is true', () => {
    const { result, warnings } = interpolate('Hello {{name}} and {{unknown}}', { name: 'World' }, { keepUnknown: true })
    expect(result).toBe('Hello World and {{unknown}}')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('unknown')
  })

  it('records warnings for unused vars when warnUnused is true', () => {
    const { warnings } = interpolate('Hello {{name}}', {
      name: 'World',
      extra: 'unused',
    }, { warnUnused: true })
    expect(warnings).toContainEqual(expect.stringContaining('extra'))
  })

  it('returns empty warnings array by default', () => {
    const { warnings } = interpolate('{{greeting}}', { greeting: 'Hi' })
    expect(warnings).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// resolveTranslatorPrompt
// ---------------------------------------------------------------------------
describe('resolveTranslatorPrompt', () => {
  const defaultTemplate = 'Translate {{source_text}} from {{source_lang}} to {{target_lang}}'

  it('returns override when prompt_override is a non-empty string', () => {
    const agent = { prompt_override: 'Custom prompt {{source_text}}' }
    expect(resolveTranslatorPrompt(agent, defaultTemplate)).toBe('Custom prompt {{source_text}}')
  })

  it('returns defaultTemplate when prompt_override is null', () => {
    const agent = { prompt_override: null }
    expect(resolveTranslatorPrompt(agent, defaultTemplate)).toBe(defaultTemplate)
  })

  it('returns defaultTemplate when prompt_override is undefined', () => {
    const agent = {} as { prompt_override?: string | null }
    expect(resolveTranslatorPrompt(agent, defaultTemplate)).toBe(defaultTemplate)
  })

  it('returns defaultTemplate when prompt_override is empty string', () => {
    const agent = { prompt_override: '' }
    expect(resolveTranslatorPrompt(agent, defaultTemplate)).toBe(defaultTemplate)
  })

  it('returns defaultTemplate when prompt_override is whitespace-only', () => {
    const agent = { prompt_override: '   ' }
    expect(resolveTranslatorPrompt(agent, defaultTemplate)).toBe(defaultTemplate)
  })
})

// ---------------------------------------------------------------------------
// buildTranslatorPrompt
// ---------------------------------------------------------------------------
describe('buildTranslatorPrompt', () => {
  const template = 'You are a {{source_lang}}→{{target_lang}} translator. Text: {{source_text}}'
  const params = {
    source_lang: 'en',
    target_lang: 'zh',
    source_text: 'Hello, world!',
  }

  it('returns a { system, user } pair', () => {
    const result = buildTranslatorPrompt(template, params)
    expect(result).toHaveProperty('system')
    expect(result).toHaveProperty('user')
    expect(result.system.role).toBe('system')
    expect(result.user.role).toBe('user')
  })

  it('system contains role instruction', () => {
    const result = buildTranslatorPrompt(template, params)
    expect(result.system.content).toContain('translator')
  })

  it('user contains interpolated content with source_text', () => {
    const result = buildTranslatorPrompt(template, params)
    expect(result.user.content).toContain('Hello, world!')
    expect(result.user.content).toContain('en')
    expect(result.user.content).toContain('zh')
  })

  it('no {{source_text}} residual in output', () => {
    const result = buildTranslatorPrompt(template, params)
    expect(result.user.content).not.toMatch(/\{\{source_text\}\}/)
    expect(result.user.content).not.toMatch(/\{\{/)
  })

  it('includes extra_instructions as additional paragraph when provided', () => {
    const result = buildTranslatorPrompt(template, {
      ...params,
      extra_instructions: 'Be concise.',
    })
    expect(result.system.content).toContain('Be concise.')
  })

  it('omits extra_instructions paragraph when not provided', () => {
    const result = buildTranslatorPrompt(template, params)
    expect(result.system.content).not.toContain('extra_instructions')
  })

  it('throws PromptAssemblyError if template references missing var', () => {
    expect(() =>
      buildTranslatorPrompt('Text: {{missing_var}}', params),
    ).toThrow(PromptAssemblyError)
  })

  it('throws if source_text is missing from params', () => {
    const { source_text: _, ...partial } = params
    expect(() =>
      buildTranslatorPrompt(template, partial as any),
    ).toThrow(PromptAssemblyError)
  })
})

// ---------------------------------------------------------------------------
// buildStagePrompt
// ---------------------------------------------------------------------------
describe('buildStagePrompt', () => {
  const stageSchema = `{
  "translated_text": "string",
  "confidence": "number"
}`
  const stageTemplate = 'Context: {{context}}'
  const contextJson = JSON.stringify({ source_text: 'Hello', lang: 'en' })

  it('returns a { system, user } pair', () => {
    const result = buildStagePrompt(stageTemplate, contextJson, stageSchema)
    expect(result).toHaveProperty('system')
    expect(result).toHaveProperty('user')
    expect(result.system.role).toBe('system')
    expect(result.user.role).toBe('user')
  })

  it('system contains free-form output instruction (not strict JSON)', () => {
    const result = buildStagePrompt(stageTemplate, contextJson, stageSchema)
    expect(result.system.content).toContain('自由输出')
    // Must NOT contain strict-JSON-only instruction
    expect(result.system.content).not.toMatch(/严格只输出/)
  })

  it('system contains the stage goal text', () => {
    const goal = '请审查这些译文的质量'
    const result = buildStagePrompt(stageTemplate, contextJson, goal)
    expect(result.system.content).toContain(goal)
  })

  it('system contains the --- separator convention for body+notes', () => {
    const result = buildStagePrompt(stageTemplate, contextJson, stageSchema)
    expect(result.system.content).toContain('---')
  })

  it('user contains the context JSON', () => {
    const result = buildStagePrompt(stageTemplate, contextJson, stageSchema)
    expect(result.user.content).toContain('source_text')
    expect(result.user.content).toContain('Hello')
  })

  it('throws PromptAssemblyError if template has missing vars', () => {
    expect(() =>
      buildStagePrompt('{{missing}}', contextJson, stageSchema),
    ).toThrow(PromptAssemblyError)
  })
})
