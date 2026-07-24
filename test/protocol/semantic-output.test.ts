import { describe, expect, it } from 'vitest'
import {
  parseSemanticAgentOutput,
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

  it('recognizes the first standalone boundary with LF', () => {
    const raw = '正文\n --- \n注释\n---\n注释中的分隔线'
    expect(parseSemanticAgentOutput(raw)).toEqual({
      raw,
      body: '正文',
      annotation: '注释\n---\n注释中的分隔线',
    })
  })

  it('recognizes CRLF without rewriting raw', () => {
    const raw = 'body\r\n---\r\nannotation'
    const parsed = parseSemanticAgentOutput(raw)
    expect(parsed.raw).toBe(raw)
    expect(parsed.body).toBe('body')
    expect(parsed.annotation).toBe('annotation')
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
})
