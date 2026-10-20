import { describe, expect, it } from 'vitest'
import {
  createSemanticOutputStreamDecoder,
  type SemanticOutputStreamDelta,
} from '../../src/lib/protocol/semantic-output-stream'

function collect(chunks: string[]) {
  const decoder = createSemanticOutputStreamDecoder()
  let body = ''
  let annotation = ''
  const deltas: SemanticOutputStreamDelta[] = []
  for (const chunk of chunks) {
    const delta = decoder.push(chunk)
    deltas.push(delta)
    body += delta.bodyDelta
    annotation += delta.annotationDelta
  }
  return { body, annotation, deltas, end: decoder.finish() }
}

// Intentionally split UTF-16 code units, including the middle of emoji.
function oneCodeUnitChunks(value: string): string[] {
  return value.split('')
}

describe('semantic JSON streaming preview', () => {
  it('emits body text immediately without leaking JSON syntax or annotation', () => {
    const decoder = createSemanticOutputStreamDecoder()
    expect(decoder.push(' \r\n{\t"body": "')).toEqual({
      bodyDelta: '',
      annotationDelta: '',
      invalid: false,
      complete: false,
    })
    expect(decoder.push('翻译')).toEqual({
      bodyDelta: '翻译',
      annotationDelta: '',
      invalid: false,
      complete: false,
    })
    expect(decoder.push('正文", "annotation": "译者')).toEqual({
      bodyDelta: '正文',
      annotationDelta: '译者',
      invalid: false,
      complete: false,
    })
    expect(decoder.push('说明"} \n')).toEqual({
      bodyDelta: '',
      annotationDelta: '说明',
      invalid: false,
      complete: true,
    })
    expect(decoder.finish()).toEqual({
      bodyDelta: '',
      annotationDelta: '',
      invalid: false,
      complete: true,
    })
  })

  it.each([
    '{"body":"正文","annotation":"说明"}',
    '{"annotation":"说明","body":"正文"}',
    '{"annotation":null,"body":"正文"}',
    '{"body":"正文","annotation":""}',
    ' \n{\r"body"\t:\t"  正文\\n ",\n"annotation":null}\r\n',
    '{"bo\\u0064y":"正文","annot\\u0061tion":"说明"}',
  ])('supports every two-chunk split and single-code-unit chunks: %s', (raw) => {
    const expected = JSON.parse(raw) as { body: string; annotation: string | null }
    for (let split = 0; split <= raw.length; split += 1) {
      const parsed = collect([raw.slice(0, split), raw.slice(split)])
      expect(parsed.body).toBe(expected.body)
      expect(parsed.annotation).toBe(expected.annotation ?? '')
      expect(parsed.deltas.some((delta) => delta.invalid)).toBe(false)
      expect(parsed.end).toMatchObject({ invalid: false, complete: true })
    }
    const smallestChunks = collect(oneCodeUnitChunks(raw))
    expect(smallestChunks.body).toBe(expected.body)
    expect(smallestChunks.annotation).toBe(expected.annotation ?? '')
    expect(smallestChunks.end).toMatchObject({ invalid: false, complete: true })
  })

  it('decodes all JSON string escapes across arbitrary chunk boundaries', () => {
    const raw = String.raw`{"body":"quote: \" slash: \/ backslash: \\ \b\f\n\r\t \u4e2d\u6587","annotation":"literal \\u1234 and \\\" plus \u0000"}`
    const expected = JSON.parse(raw) as { body: string; annotation: string }
    const parsed = collect(oneCodeUnitChunks(raw))
    expect(parsed.body).toBe(expected.body)
    expect(parsed.annotation).toBe(expected.annotation)
    expect(parsed.end).toMatchObject({ invalid: false, complete: true })
  })

  it('holds escaped surrogate pairs until both halves can be emitted together', () => {
    const decoder = createSemanticOutputStreamDecoder()
    expect(decoder.push('{"body":"A\\uD83')).toMatchObject({ bodyDelta: 'A', invalid: false })
    expect(decoder.push('D\\uD')).toMatchObject({ bodyDelta: '', invalid: false })
    expect(decoder.push('E00')).toMatchObject({ bodyDelta: '😀', invalid: false })
    expect(decoder.push('","annotation":"\\uD83D')).toMatchObject({
      bodyDelta: '',
      annotationDelta: '',
      invalid: false,
    })
    expect(decoder.push('\\uDE80"}')).toMatchObject({
      bodyDelta: '',
      annotationDelta: '🚀',
      complete: true,
      invalid: false,
    })
  })

  it('holds literal surrogate pairs across chunks and supports mixed escape forms', () => {
    const decoder = createSemanticOutputStreamDecoder()
    expect(decoder.push('{"body":"\ud83d')).toMatchObject({ bodyDelta: '', invalid: false })
    expect(decoder.push('\ude00')).toMatchObject({ bodyDelta: '😀', invalid: false })
    expect(decoder.push('\\uD83D')).toMatchObject({ bodyDelta: '', invalid: false })
    expect(decoder.push('\ude80')).toMatchObject({ bodyDelta: '🚀', invalid: false })
    expect(decoder.push('\ud83d')).toMatchObject({ bodyDelta: '', invalid: false })
    expect(decoder.push('\\uDE3A","annotation":null}')).toMatchObject({
      bodyDelta: '😺',
      invalid: false,
      complete: true,
    })
  })

  it('preserves lone surrogates with the same string value as JSON.parse', () => {
    const raw = String.raw`{"body":"\uD800x\uD801\uD802\uDC00\uD803","annotation":"\uDC00"}`
    const expected = JSON.parse(raw) as { body: string; annotation: string }
    const parsed = collect(oneCodeUnitChunks(raw))
    expect(parsed.body).toBe(expected.body)
    expect(parsed.annotation).toBe(expected.annotation)
    expect(parsed.end.invalid).toBe(false)
  })

  it('keeps field-like and delimiter-like text inside a string in that field', () => {
    const body = 'text {"annotation":"stay in body"} --- <think>quoted text</think>'
    const annotation = '{"body":"stay in annotation"}'
    const parsed = collect(oneCodeUnitChunks(JSON.stringify({ annotation, body })))
    expect(parsed.body).toBe(body)
    expect(parsed.annotation).toBe(annotation)
    expect(parsed.end.invalid).toBe(false)
  })

  it.each([
    '```json\n{"body":"leak","annotation":null}\n```',
    '<think>{"body":"leak","annotation":null}</think>',
    'reasoning first\n{"body":"leak","annotation":null}',
    '[{"body":"leak","annotation":null}]',
    '{"wrapper":{"body":"leak","annotation":null}}',
    '{"body":{"body":"leak"},"annotation":null}',
    '{"annotation":{"body":"leak"},"body":"leak"}',
    '{"annotation":[{"body":"leak"}],"body":"leak"}',
    '{"BODY":"leak","annotation":null}',
  ])('rejects wrappers and nested fields without scanning forward: %s', (raw) => {
    const parsed = collect(oneCodeUnitChunks(raw))
    expect(parsed.body).toBe('')
    expect(parsed.annotation).toBe('')
    expect(parsed.end).toMatchObject({ invalid: true, complete: false })
  })

  it.each([
    '{}',
    '{"body":"ok"}',
    '{"annotation":null}',
    '{"body":"","annotation":null}',
    '{"body":" \\n\\t\\u00a0","annotation":null}',
    '{"body":null,"annotation":null}',
    '{"body":true,"annotation":null}',
    '{"body":1,"annotation":null}',
    '{"body":"ok","annotation":false}',
    '{"body":"ok","annotation":0}',
    '{"body":"ok","annotation":null,}',
    '{"body":"ok","annotation":null,"extra":"bad"}',
    '{"body":"ok","body":"duplicate","annotation":null}',
    '{"annotation":null,"annotation":"duplicate","body":"ok"}',
    '{"body":"ok","bo\\u0064y":"duplicate","annotation":null}',
    '{"body" "missing colon","annotation":null}',
    '{"body":"ok" "annotation":null}',
    "{'body':'single quotes','annotation':null}",
    '{"body":"bad\\x20","annotation":null}',
    '{"body":"bad\\u123z","annotation":null}',
    '{"body":"raw\nnewline","annotation":null}',
    '{"body":"raw\tTab","annotation":null}',
    '{"body":"ok","annotation":nulL}',
    '{"body":"ok","annotation":nu ll}',
    '{"body":"ok","annotation":nullx}',
    '{"body":"ok","annotation":null}tail',
    '{"body":"ok","annotation":null}{"body":"extra","annotation":null}',
    '\ufeff{"body":"ok","annotation":null}',
    '\u00a0{"body":"ok","annotation":null}',
    '{"body":"ok",/* comment */"annotation":null}',
  ])('invalidates malformed or nonconforming input without emitting its syntax: %s', (raw) => {
    const decoder = createSemanticOutputStreamDecoder()
    expect(decoder.push(raw)).toEqual({
      bodyDelta: '',
      annotationDelta: '',
      invalid: true,
      complete: false,
    })
    expect(decoder.push('{"body":"rescue","annotation":null}')).toEqual({
      bodyDelta: '',
      annotationDelta: '',
      invalid: true,
      complete: false,
    })
    expect(decoder.finish()).toMatchObject({ invalid: true, complete: false })
  })

  it('reports invalidation so a caller can clear an earlier partial preview', () => {
    const decoder = createSemanticOutputStreamDecoder()
    let bodyPreview = ''
    let annotationPreview = ''
    const chunks = [
      '{"body":"provisional",',
      '"annotation":"provisional note",',
      '"body":"duplicate"}',
    ]
    for (const chunk of chunks) {
      const delta = decoder.push(chunk)
      if (delta.invalid) {
        bodyPreview = ''
        annotationPreview = ''
      } else {
        bodyPreview += delta.bodyDelta
        annotationPreview += delta.annotationDelta
      }
    }
    expect(bodyPreview).toBe('')
    expect(annotationPreview).toBe('')
    expect(decoder.finish().invalid).toBe(true)
  })

  it('treats complete as provisional and rejects trailing content arriving later', () => {
    const decoder = createSemanticOutputStreamDecoder()
    expect(decoder.push('{"body":"ok","annotation":null}')).toMatchObject({
      bodyDelta: 'ok',
      complete: true,
      invalid: false,
    })
    expect(decoder.push(' \n')).toMatchObject({ complete: true, invalid: false })
    expect(decoder.push('\n```')).toEqual({
      bodyDelta: '',
      annotationDelta: '',
      complete: false,
      invalid: true,
    })
  })

  it.each([
    '',
    ' \r\n',
    '{',
    '{"body',
    '{"body"',
    '{"body":',
    '{"body":"text',
    '{"body":"text\\',
    '{"body":"text\\u',
    '{"body":"text\\u123',
    '{"body":"text\\uD83D',
    '{"body":"text"',
    '{"body":"text",',
    '{"body":"text","annotation":n',
    '{"body":"text","annotation":nu',
    '{"body":"text","annotation":nul',
    '{"body":"text","annotation":null',
  ])('requires finish to invalidate an otherwise valid unfinished prefix: %s', (raw) => {
    const decoder = createSemanticOutputStreamDecoder()
    expect(decoder.push(raw)).toMatchObject({ invalid: false, complete: false })
    expect(decoder.finish()).toEqual({
      bodyDelta: '',
      annotationDelta: '',
      invalid: true,
      complete: false,
    })
    expect(decoder.finish()).toMatchObject({ invalid: true, complete: false })
  })

  it('accepts empty chunks and an idempotent finish, but rejects new data after finish', () => {
    const decoder = createSemanticOutputStreamDecoder()
    expect(decoder.push('')).toMatchObject({ invalid: false, complete: false })
    decoder.push('{"body":"ok","annotation":null}')
    expect(decoder.push('')).toMatchObject({ invalid: false, complete: true })
    expect(decoder.finish()).toMatchObject({ invalid: false, complete: true })
    expect(decoder.finish()).toMatchObject({ invalid: false, complete: true })
    expect(decoder.push('')).toMatchObject({ invalid: false, complete: true })
    expect(decoder.push('more')).toMatchObject({ invalid: true, complete: false })
  })

  it('streams a long response without returning earlier text again', () => {
    const decoder = createSemanticOutputStreamDecoder()
    decoder.push('{"annotation":null,"body":"')
    const fragment = '这是较长的翻译文本。 A long translation. '
    let emittedLength = 0
    // A deterministic linear-work contract, not a timing-dependent benchmark.
    for (let index = 0; index < 10_000; index += 1) {
      const delta = decoder.push(fragment)
      expect(delta.bodyDelta).toBe(fragment)
      expect(delta.annotationDelta).toBe('')
      expect(delta.invalid).toBe(false)
      emittedLength += delta.bodyDelta.length
    }
    expect(emittedLength).toBe(fragment.length * 10_000)
    expect(decoder.push('"}')).toEqual({
      bodyDelta: '',
      annotationDelta: '',
      invalid: false,
      complete: true,
    })
    expect(decoder.finish().invalid).toBe(false)
  })
})
