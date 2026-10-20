import { describe, expect, it } from 'vitest'
import {
  parseSemanticAgentOutput,
  SemanticOutputError,
  SEMANTIC_JSON_PROTOCOL_MARKER,
  semanticOutputFormatForPrompt,
  semanticBody,
} from '../../src/lib/protocol/semantic-output'

describe('FSBP semantic output', () => {
  it('uses the complete response as body when no boundary exists', () => {
    const raw = '  完整正文\n第二行  '
    expect(parseSemanticAgentOutput(raw)).toEqual({
      raw,
      body: '完整正文\n第二行',
      annotation: null,
    })
  })

  it('recognizes the last standalone boundary with LF', () => {
    const raw = '正文\n --- \n正文中的分隔线\n---\n最终注释'
    expect(parseSemanticAgentOutput(raw)).toEqual({
      raw,
      body: '正文\n --- \n正文中的分隔线',
      annotation: '最终注释',
    })
  })

  it('recognizes CRLF without rewriting raw', () => {
    const raw = 'body\r\n---\r\nannotation'
    const parsed = parseSemanticAgentOutput(raw)
    expect(parsed.raw).toBe(raw)
    expect(parsed.body).toBe('body')
    expect(parsed.annotation).toBe('annotation')
  })

  it('recognizes a bare CR boundary while preserving raw', () => {
    const raw = 'body\r---\rannotation'
    expect(parseSemanticAgentOutput(raw)).toEqual({
      raw,
      body: 'body',
      annotation: 'annotation',
    })
  })

  it('does not treat inline or longer hyphens as a boundary', () => {
    expect(semanticBody('one --- two\n----\nthree')).toBe(
      'one --- two\n----\nthree',
    )
  })

  it('allows an empty body but exposes it to candidate validation', () => {
    expect(parseSemanticAgentOutput('---\nnotes')).toEqual({
      raw: '---\nnotes',
      body: '',
      annotation: 'notes',
    })
  })

  it('keeps an earlier standalone divider in the body', () => {
    expect(semanticBody('第一部分\n---\n第二部分\n---\n说明')).toBe(
      '第一部分\n---\n第二部分',
    )
  })

  it('uses a trailing standalone divider as an empty annotation boundary', () => {
    expect(parseSemanticAgentOutput('正文\n---')).toEqual({
      raw: '正文\n---',
      body: '正文',
      annotation: null,
    })
  })
})

describe('structured semantic output', () => {
  it('decodes only the two fields and preserves raw and body formatting', () => {
    const body = '  第一行\n\n"第二行"\\原样\t🙂  '
    const annotation = '  人工可读的说明  '
    const raw = JSON.stringify({ body, annotation })
    expect(parseSemanticAgentOutput(raw, { format: 'json' })).toEqual({
      raw,
      body,
      annotation,
    })
    expect(parseSemanticAgentOutput(raw)).toEqual({ raw, body, annotation })
  })

  it('accepts either field order and an explicit null annotation', () => {
    const raw = '{"annotation":null,"body":"正文\\n---\\n正文内的横线"}'
    expect(parseSemanticAgentOutput(raw, { format: 'json' })).toEqual({
      raw,
      body: '正文\n---\n正文内的横线',
      annotation: null,
    })
  })

  it.each([
    '',
    'plain text',
    '```json\n{"body":"正文","annotation":null}\n```',
    '{"body":"正文","annotation":null',
    '{"body":"正文","annotation":null}\nextra',
    '{"body":"正文","annotation":null}{"body":"two","annotation":null}',
    '<think>provider text</think>{"body":"正文","annotation":null}',
  ])('rejects an invalid JSON envelope without leaking it as body: %s', (raw) => {
    expect(() => parseSemanticAgentOutput(raw, { format: 'json' }))
      .toThrowError(SemanticOutputError)
    try {
      parseSemanticAgentOutput(raw, { format: 'json' })
    } catch (error) {
      expect((error as SemanticOutputError).code)
        .toBe('semantic_output_invalid_json')
    }
  })

  it.each([
    'null',
    '[]',
    '"正文"',
    '{"body":"正文"}',
    '{"annotation":null}',
    '{"body":4,"annotation":null}',
    '{"body":"正文","annotation":{"note":"说明"}}',
    '{"body":"正文","annotation":null,"reasoning":"hidden"}',
    '{"body":"first","body":"second","annotation":null}',
    '{"body":"first","b\\u006fdy":"second","annotation":null}',
  ])('rejects schema violations and duplicate fields: %s', (raw) => {
    expect(() => parseSemanticAgentOutput(raw, { format: 'json' }))
      .toThrowError(expect.objectContaining({
        code: 'semantic_output_invalid_schema',
      }))
  })

  it.each(['', ' \r\n\t'])('rejects an empty stage body', (body) => {
    expect(() => parseSemanticAgentOutput(
      JSON.stringify({ body, annotation: null }),
      { format: 'json' },
    )).toThrowError(expect.objectContaining({
      code: 'semantic_output_empty_body',
    }))
  })

  it('preserves literal XML-like tags inside valid delivered strings', () => {
    for (const envelope of [
      { body: '<think>literal source tag</think>正文', annotation: null },
      { body: '正文', annotation: '<analysis>literal example</analysis>' },
    ]) {
      const raw = JSON.stringify(envelope)
      expect(parseSemanticAgentOutput(raw, { format: 'json' })).toEqual({
        raw,
        ...envelope,
      })
    }
  })

  it('keeps archived brace-led prose and explicit legacy JSON unchanged', () => {
    const raw = '{a line of an old poem}\n第二行'
    expect(parseSemanticAgentOutput(raw).body).toBe(raw)
    const legacyJson = '{"body":"quoted data","annotation":null}'
    expect(parseSemanticAgentOutput(legacyJson, { format: 'legacy' }).body)
      .toBe(legacyJson)
  })

  it('keeps legacy malformed JSON text readable without weakening strict mode', () => {
    const raw = '{"body":"unclosed historical text'
    expect(parseSemanticAgentOutput(raw).body).toBe(raw)
    expect(() => parseSemanticAgentOutput(raw, { format: 'json' }))
      .toThrow(SemanticOutputError)
  })

  it('preserves literal tag text in old archives without guessing provider reasoning', () => {
    const raw = '<think>quoted\n---\nsource</think>\n正文\n---\n注释'
    for (const format of ['auto', 'legacy'] as const) {
      expect(parseSemanticAgentOutput(raw, { format })).toEqual({
        raw,
        body: '<think>quoted\n---\nsource</think>\n正文',
        annotation: '注释',
      })
    }
    const incompleteLiteral = '<think>an intentionally unfinished source tag'
    expect(parseSemanticAgentOutput(incompleteLiteral).body).toBe(incompleteLiteral)
  })

  it('uses the saved explicit marker instead of guessing from bundle versions', () => {
    expect(semanticOutputFormatForPrompt('Old freely formatted prompt v99'))
      .toBe('legacy')
    expect(semanticOutputFormatForPrompt(`Stage\n${SEMANTIC_JSON_PROTOCOL_MARKER}`))
      .toBe('json')

    const archivedLiteral = '{"body":"quoted source data","annotation":null}'
    expect(parseSemanticAgentOutput(archivedLiteral, {
      format: semanticOutputFormatForPrompt('Old freely formatted prompt v99'),
    }).body).toBe(archivedLiteral)
  })
})
