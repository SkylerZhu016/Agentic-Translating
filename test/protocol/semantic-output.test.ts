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
