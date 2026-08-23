import { describe, expect, it } from 'vitest'
import {
  normalizeLocale,
  readStoredLocale,
  resolveLocale,
  UI_LOCALE_SETTING_KEY,
  writeStoredLocale,
  type LocaleStorage,
} from '@/src/i18n'

function memoryStorage(initial?: string): LocaleStorage {
  const values = new Map<string, string>()
  if (initial) values.set(UI_LOCALE_SETTING_KEY, initial)
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
}

describe('locale preference', () => {
  it('normalizes supported browser locale variants', () => {
    expect(normalizeLocale('zh-Hans-CN')).toBe('zh-CN')
    expect(normalizeLocale('en-US')).toBe('en')
    expect(normalizeLocale('fr-FR')).toBeNull()
  })

  it('prefers persisted locale and detects the system locale on first use', () => {
    expect(resolveLocale('en', 'zh-CN')).toBe('en')
    expect(resolveLocale(null, 'en-SG')).toBe('en')
    expect(resolveLocale(null, 'fr-FR')).toBe('zh-CN')
  })

  it('round-trips the ui_locale preference through browser storage', () => {
    const storage = memoryStorage()
    expect(writeStoredLocale(storage, 'en')).toBe(true)
    expect(readStoredLocale(storage)).toBe('en')
  })

  it('fails safely when storage access is unavailable', () => {
    const storage: LocaleStorage = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
    }
    expect(readStoredLocale(storage)).toBeNull()
    expect(writeStoredLocale(storage, 'zh-CN')).toBe(false)
  })
})
