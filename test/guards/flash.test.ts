import { describe, it, expect } from 'vitest'
import { detectFlashModel } from '../../src/lib/guards/flash'

describe('detectFlashModel', () => {
  // AC: flash 模型名检测
  it('should return true for gemini-1.5-flash', () => {
    expect(detectFlashModel('gemini-1.5-flash')).toBe(true)
  })

  it('should return true for flash-2.0', () => {
    expect(detectFlashModel('flash-2.0')).toBe(true)
  })

  it('should return true for GPT-4_FLASH', () => {
    expect(detectFlashModel('GPT-4_FLASH')).toBe(true)
  })

  it('should return false for reflash-model (word boundary)', () => {
    expect(detectFlashModel('reflash-model')).toBe(false)
  })

  it('should return false for gpt-4o', () => {
    expect(detectFlashModel('gpt-4o')).toBe(false)
  })

  // Edge cases - case sensitivity
  it('should be case insensitive for FLASH prefix', () => {
    expect(detectFlashModel('FLASH-2.0')).toBe(true)
  })

  it('should be case insensitive for Flash suffix', () => {
    expect(detectFlashModel('gemini-Flash')).toBe(true)
  })

  it('should be case insensitive for mixed case', () => {
    expect(detectFlashModel('Flash-2o')).toBe(true)
  })

  // Edge cases - word boundary
  it('should return false when flash is part of a word with letters before', () => {
    expect(detectFlashModel('reflash')).toBe(false)
  })

  it('should return false when flash is part of a word with letters after', () => {
    expect(detectFlashModel('flashy-model')).toBe(false)
  })

  it('should return true when flash is at the start of the string', () => {
    expect(detectFlashModel('flash-1.5')).toBe(true)
  })

  it('should return true when flash is at the end of the string', () => {
    expect(detectFlashModel('gemini-flash')).toBe(true)
  })

  it('should return true when flash is surrounded by non-letters', () => {
    expect(detectFlashModel('GPT_4_FLASH_2')).toBe(true)
  })

  it('should return true when flash is the entire string', () => {
    expect(detectFlashModel('flash')).toBe(true)
    expect(detectFlashModel('FLASH')).toBe(true)
  })

  // Edge cases - numeric boundaries
  it('should return true when flash is adjacent to numbers', () => {
    expect(detectFlashModel('flash2')).toBe(true)
    expect(detectFlashModel('2flash')).toBe(true)
  })

  // Edge cases - special characters as boundaries
  it('should return true when flash is separated by hyphens or underscores', () => {
    expect(detectFlashModel('some-flash-model')).toBe(true)
    expect(detectFlashModel('some_flash_model')).toBe(true)
  })
})
