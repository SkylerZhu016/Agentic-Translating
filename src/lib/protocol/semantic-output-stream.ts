export interface SemanticOutputStreamDelta {
  bodyDelta: string
  annotationDelta: string
  /** Sticky: discard all previously rendered preview when this becomes true. */
  invalid: boolean
  /**
   * The object has closed with both fields present. This is preview state, not
   * evidence that the final response is valid: more input can invalidate it.
   */
  complete: boolean
}

export interface SemanticOutputStreamDecoder {
  push(delta: string): SemanticOutputStreamDelta
  /** Mark the input as ended. Incomplete input becomes invalid. Idempotent. */
  finish(): SemanticOutputStreamDelta
}

type Field = 'body' | 'annotation'
type State = 'start' | 'key' | 'colon' | 'value' | 'string' | 'null' | 'separator' | 'done'
type EscapeState = 'none' | 'escape' | 'unicode'

function isJsonWhitespace(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r'
}

function hexDigit(character: string): number {
  const code = character.charCodeAt(0)
  if (code >= 0x30 && code <= 0x39) return code - 0x30
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10
  return -1
}

/**
 * Decode only string values of top-level `body` and `annotation` for a preview.
 *
 * Each input code unit is consumed once. Persistent state is bounded: this
 * decoder keeps no raw response or accumulated output. JSON escapes and UTF-16
 * surrogate pairs may cross any chunk boundary.
 *
 * Exactly one object containing a nonblank body string and an annotation
 * string/null is accepted. Unknown/duplicate keys, wrappers and nested values
 * stop decoding permanently. On invalid input this call's deltas are empty;
 * callers must also clear any earlier preview when `invalid` becomes true.
 *
 * Always validate the entire final response with the strict semantic parser
 * before saving or using it downstream. Even `complete` is provisional until
 * the stream ends. Plain text/legacy output belongs to its own parser.
 */
export function createSemanticOutputStreamDecoder(): SemanticOutputStreamDecoder {
  let state: State = 'start'
  let invalid = false
  let finished = false
  let stringTarget: Field | 'key' = 'key'
  let field: Field = 'body'
  let key = ''
  let bodySeen = false
  let annotationSeen = false
  let bodyHasText = false
  let escapeState: EscapeState = 'none'
  let unicodeValue = 0
  let unicodeDigits = 0
  let nullIndex = 0
  let pendingHighSurrogate = ''

  function result(bodyDelta = '', annotationDelta = ''): SemanticOutputStreamDelta {
    return {
      bodyDelta: invalid ? '' : bodyDelta,
      annotationDelta: invalid ? '' : annotationDelta,
      invalid,
      complete: !invalid && state === 'done',
    }
  }

  return {
    push(delta) {
      if (finished && delta.length > 0) invalid = true
      if (invalid || delta.length === 0) return result()

      // These arrays only contain the current push's decoded output, never
      // previous chunks. Joining once avoids repeatedly copying a growing body.
      const bodyParts: string[] = []
      const annotationParts: string[] = []

      function emit(text: string) {
        if (stringTarget === 'body') bodyParts.push(text)
        else annotationParts.push(text)
      }

      function decoded(character: string) {
        if (stringTarget === 'key') {
          key += character
          // Reject impossible keys early and keep key storage bounded.
          if (!'body'.startsWith(key) && !'annotation'.startsWith(key)) invalid = true
          return
        }

        if (stringTarget === 'body' && character.trim().length > 0) bodyHasText = true
        const code = character.charCodeAt(0)
        if (pendingHighSurrogate) {
          const high = pendingHighSurrogate
          pendingHighSurrogate = ''
          if (code >= 0xdc00 && code <= 0xdfff) {
            emit(high + character)
            return
          }
          // JSON permits lone surrogates. Preserve them exactly as JSON.parse
          // would, while keeping valid pairs together in the emitted deltas.
          emit(high)
        }
        if (code >= 0xd800 && code <= 0xdbff) pendingHighSurrogate = character
        else emit(character)
      }

      function closeString() {
        if (stringTarget === 'key') {
          if (key === 'body' && !bodySeen) {
            bodySeen = true
            field = 'body'
          } else if (key === 'annotation' && !annotationSeen) {
            annotationSeen = true
            field = 'annotation'
          } else {
            invalid = true
            return
          }
          state = 'colon'
          return
        }

        if (pendingHighSurrogate) {
          emit(pendingHighSurrogate)
          pendingHighSurrogate = ''
        }
        if (stringTarget === 'body' && !bodyHasText) invalid = true
        else state = 'separator'
      }

      for (let index = 0; index < delta.length && !invalid; index += 1) {
        const character = delta[index]

        if (state === 'string') {
          if (escapeState === 'unicode') {
            const digit = hexDigit(character)
            if (digit < 0) {
              invalid = true
              continue
            }
            unicodeValue = unicodeValue * 16 + digit
            unicodeDigits += 1
            if (unicodeDigits === 4) {
              escapeState = 'none'
              decoded(String.fromCharCode(unicodeValue))
            }
          } else if (escapeState === 'escape') {
            escapeState = 'none'
            switch (character) {
              case '"':
              case '\\':
              case '/':
                decoded(character)
                break
              case 'b':
                decoded('\b')
                break
              case 'f':
                decoded('\f')
                break
              case 'n':
                decoded('\n')
                break
              case 'r':
                decoded('\r')
                break
              case 't':
                decoded('\t')
                break
              case 'u':
                escapeState = 'unicode'
                unicodeValue = 0
                unicodeDigits = 0
                break
              default:
                invalid = true
            }
          } else if (character === '"') {
            closeString()
          } else if (character === '\\') {
            escapeState = 'escape'
          } else if (character.charCodeAt(0) < 0x20) {
            invalid = true
          } else {
            decoded(character)
          }
          continue
        }

        if (state === 'null') {
          if (character !== 'null'[nullIndex]) invalid = true
          else {
            nullIndex += 1
            if (nullIndex === 4) state = 'separator'
          }
          continue
        }

        if (isJsonWhitespace(character)) continue

        switch (state) {
          case 'start':
            if (character === '{') state = 'key'
            else invalid = true
            break
          case 'key':
            if (character === '"') {
              key = ''
              stringTarget = 'key'
              state = 'string'
            } else invalid = true
            break
          case 'colon':
            if (character === ':') state = 'value'
            else invalid = true
            break
          case 'value':
            if (character === '"') {
              stringTarget = field
              state = 'string'
            } else if (field === 'annotation' && character === 'n') {
              nullIndex = 1
              state = 'null'
            } else invalid = true
            break
          case 'separator':
            if (character === ',') state = 'key'
            else if (character === '}' && bodySeen && annotationSeen) state = 'done'
            else invalid = true
            break
          case 'done':
            invalid = true
            break
        }
      }

      return invalid ? result() : result(bodyParts.join(''), annotationParts.join(''))
    },
    finish() {
      finished = true
      if (state !== 'done') invalid = true
      return result()
    },
  }
}
