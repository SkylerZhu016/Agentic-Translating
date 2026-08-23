import { describe, expect, it } from 'vitest'
import {
  formatCurrency,
  formatDate,
  formatDuration,
  formatNumber,
} from '@/src/i18n'

describe('locale-aware formatters', () => {
  it('formats dates in the selected locale', () => {
    const value = new Date('2026-08-21T00:00:00.000Z')
    const options: Intl.DateTimeFormatOptions = {
      dateStyle: 'long',
      timeZone: 'UTC',
    }
    expect(formatDate(value, 'zh-CN', options)).toContain('2026')
    expect(formatDate(value, 'en', options)).toContain('August')
  })

  it('formats numbers and currencies with Intl', () => {
    expect(formatNumber(1234.5, 'en')).toBe('1,234.5')
    expect(formatCurrency(12.5, 'en', 'USD')).toContain('$12.50')
    expect(formatCurrency(12.5, 'zh-CN', 'CNY')).toContain('12.50')
  })

  it('formats durations with localized units and a bounded number of parts', () => {
    expect(formatDuration(3_661_000, 'en', { maxParts: 2 })).toMatch(/1 hr.*1 min/)
    expect(formatDuration(3_661_000, 'zh-CN', { maxParts: 2 })).toMatch(/1.*时.*1.*分/)
    expect(formatDuration(250, 'en')).toMatch(/250.*ms/)
  })

  it('rejects invalid date and duration values', () => {
    expect(() => formatDate('invalid', 'en')).toThrow(RangeError)
    expect(() => formatDuration(Number.NaN, 'en')).toThrow(RangeError)
  })
})
