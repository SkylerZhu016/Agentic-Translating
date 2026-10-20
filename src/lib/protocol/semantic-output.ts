import type { SemanticAgentOutput } from '../contracts/vnext'

export const SEMANTIC_JSON_PROTOCOL_MARKER = '[protocol:json-v1]'

export type SemanticOutputFormat = 'json' | 'auto' | 'legacy'

export type SemanticOutputErrorCode =
  | 'semantic_output_invalid_json'
  | 'semantic_output_invalid_schema'
  | 'semantic_output_empty_body'

const ERROR_MESSAGES: Record<SemanticOutputErrorCode, string> = {
  semantic_output_invalid_json:
    'Agent output must be one complete JSON object without code fences or surrounding text.',
  semantic_output_invalid_schema:
    'Agent output must contain exactly body (string) and annotation (string or null), with no duplicate fields.',
  semantic_output_empty_body: 'Agent output body must contain non-whitespace text.',
}

/** Stable, content-free errors can be logged without copying model output. */
export class SemanticOutputError extends Error {
  readonly code: SemanticOutputErrorCode

  constructor(code: SemanticOutputErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'SemanticOutputError'
    this.code = code
  }
}

export const SEMANTIC_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    body: { type: 'string', minLength: 1, pattern: '\\S' },
    annotation: { type: ['string', 'null'] },
  },
  required: ['body', 'annotation'],
  additionalProperties: false,
} as const

/**
 * The saved prompt is the contract. Old preset revisions have no marker and
 * retain their historical parser, even after the built-in catalog is updated.
 */
export function semanticOutputFormatForPrompt(
  prompt: string,
): 'json' | 'legacy' {
  return prompt.includes(SEMANTIC_JSON_PROTOCOL_MARKER) ? 'json' : 'legacy'
}

/** JSON.parse accepts duplicate keys, so inspect key tokens before accepting it. */
function hasDuplicateTopLevelKeys(raw: string): boolean {
  const keys = new Set<string>()
  let depth = 0
  let expectingKey = false

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]
    if (character === '"') {
      const start = index
      index += 1
      while (index < raw.length) {
        if (raw[index] === '\\') {
          index += 2
          continue
        }
        if (raw[index] === '"') break
        index += 1
      }
      if (depth === 1 && expectingKey) {
        const key = JSON.parse(raw.slice(start, index + 1)) as string
        if (keys.has(key)) return true
        keys.add(key)
        expectingKey = false
      }
    } else if (character === '{' || character === '[') {
      depth += 1
      if (depth === 1) expectingKey = true
    } else if (character === '}' || character === ']') {
      depth -= 1
    } else if (character === ',' && depth === 1) {
      expectingKey = true
    }
  }

  return false
}

function parseJsonOutput(raw: string): SemanticAgentOutput {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new SemanticOutputError('semantic_output_invalid_json')
  }

  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new SemanticOutputError('semantic_output_invalid_schema')
  }

  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (
    keys.length !== 2 ||
    !Object.hasOwn(record, 'body') ||
    !Object.hasOwn(record, 'annotation') ||
    typeof record.body !== 'string' ||
    !(typeof record.annotation === 'string' || record.annotation === null) ||
    hasDuplicateTopLevelKeys(raw)
  ) {
    throw new SemanticOutputError('semantic_output_invalid_schema')
  }
  if (!record.body.trim()) {
    throw new SemanticOutputError('semantic_output_empty_body')
  }
  return {
    raw,
    body: record.body,
    annotation: record.annotation,
  }
}

/**
 * New generation must select `json` from its saved prompt marker. `auto` is
 * for historical reads: valid semantic JSON is decoded, otherwise the old
 * final-standalone-divider/plain-text convention is preserved. A literal
 * brace in an archived poem must not make its body disappear.
 */
export function parseSemanticAgentOutput(
  raw: string,
  options: { format?: SemanticOutputFormat } = {},
): SemanticAgentOutput {
  if (options.format === 'json') return parseJsonOutput(raw)

  if (options.format !== 'legacy') {
    try {
      return parseJsonOutput(raw)
    } catch (error) {
      if (!(error instanceof SemanticOutputError)) throw error
    }
  }

  const lines = raw.split(/\r\n?|\n/)
  let boundary = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() === '---') {
      boundary = index
      break
    }
  }

  if (boundary < 0) {
    return {
      raw,
      body: raw.trim(),
      annotation: null,
    }
  }

  const body = lines.slice(0, boundary).join('\n').trim()
  const annotationText = lines.slice(boundary + 1).join('\n').trim()

  return {
    raw,
    body,
    annotation: annotationText.length > 0 ? annotationText : null,
  }
}

export function semanticBody(raw: string | null | undefined): string {
  return parseSemanticAgentOutput(raw ?? '').body
}
