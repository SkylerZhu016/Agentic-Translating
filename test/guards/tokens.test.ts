import { describe, it, expect } from 'vitest'
import {
  estimateTokens,
  assertSourceLength,
  assertSourceNonEmpty,
  SourceTooLongError,
  SourceRequiredError,
} from '../../src/lib/guards/tokens'

// Inline mock for SOURCE_TOKEN_LIMIT since task 3 constants may not exist
const MOCK_SOURCE_TOKEN_LIMIT = 8000

describe('estimateTokens', () => {
  it('should return 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('should count each CJK character as 1 token', () => {
    // 4 CJK chars
    expect(estimateTokens('月落乌啼')).toBe(4)
  })

  it('should count non-CJK chars as chars/4 (rounded up)', () => {
    // 10 ascii chars → 10/4 = 2.5 → 3
    expect(estimateTokens('hello world')).toBe(3)
  })

  it('should handle mixed CJK and ASCII text', () => {
    // "翻译服务" = 4 CJK chars, "ABC" = 3 non-CJK chars → ceil(3/4) = 1
    // Total = 4 + 1 = 5
    expect(estimateTokens('翻译服务ABC')).toBe(5)
  })

  it('should handle CJK Extension A characters', () => {
    // CJK Extension A range: U+3400-U+4DBF
    expect(estimateTokens('㐀㐁㐂')).toBe(3)
  })

  it('should handle CJK Compatibility Ideographs', () => {
    // CJK Compatibility range: U+F900-U+FAFF
    expect(estimateTokens('豈更車')).toBe(3)
  })

  it('should return integer for any input', () => {
    const result = estimateTokens('test with various chars 测试')
    expect(Number.isInteger(result)).toBe(true)
  })

  it('should estimate whitespace-heavy text correctly', () => {
    // "     " = 5 spaces → ceil(5/4) = 2
    expect(estimateTokens('     ')).toBe(2)
  })
})

describe('assertSourceLength', () => {
  it('should not throw for text under the limit', () => {
    expect(() => assertSourceLength('short text', MOCK_SOURCE_TOKEN_LIMIT)).not.toThrow()
  })

  it('should throw SourceTooLongError for text over the limit', () => {
    // CJK: each char = 1 token, need > MOCK_SOURCE_TOKEN_LIMIT
    const longText = '测'.repeat(MOCK_SOURCE_TOKEN_LIMIT + 1)
    expect(() => assertSourceLength(longText, MOCK_SOURCE_TOKEN_LIMIT)).toThrow(SourceTooLongError)
  })

  it('should throw with code source_too_long', () => {
    const longText = 'a'.repeat(MOCK_SOURCE_TOKEN_LIMIT * 4 + 1)
    try {
      assertSourceLength(longText, MOCK_SOURCE_TOKEN_LIMIT)
      expect.unreachable('should have thrown')
    } catch (e) {
      if (e instanceof SourceTooLongError) {
        expect(e.code).toBe('source_too_long')
        expect(e.limit).toBe(MOCK_SOURCE_TOKEN_LIMIT)
        expect(typeof e.estimated).toBe('number')
      } else {
        throw e
      }
    }
  })

  it('should not throw when estimated tokens exactly equal limit', () => {
    const text = '测'.repeat(MOCK_SOURCE_TOKEN_LIMIT) // exactly at limit
    expect(() => assertSourceLength(text, MOCK_SOURCE_TOKEN_LIMIT)).not.toThrow()
  })
})

describe('assertSourceNonEmpty', () => {
  it('should not throw for non-empty text', () => {
    expect(() => assertSourceNonEmpty('some text')).not.toThrow()
  })

  it('should throw SourceRequiredError for empty string', () => {
    expect(() => assertSourceNonEmpty('')).toThrow(SourceRequiredError)
  })

  it('should throw SourceRequiredError for whitespace-only string', () => {
    expect(() => assertSourceNonEmpty('   ')).toThrow(SourceRequiredError)
    expect(() => assertSourceNonEmpty('\t\n  ')).toThrow(SourceRequiredError)
  })

  it('should throw with code source_required', () => {
    try {
      assertSourceNonEmpty('')
      expect.unreachable('should have thrown')
    } catch (e) {
      if (e instanceof SourceRequiredError) {
        expect(e.code).toBe('source_required')
      } else {
        throw e
      }
    }
  })
})
