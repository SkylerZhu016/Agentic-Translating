import type { AppLocale } from './types'

export const UI_LOCALE_SETTING_KEY = 'ui_locale'

export interface LocaleStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export function normalizeLocale(value: string | null | undefined): AppLocale | null {
  if (!value) return null
  const normalized = value.trim().replace('_', '-').toLowerCase()
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-CN'
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en'
  return null
}

export function resolveLocale(
  persistedLocale?: string | null,
  systemLocale?: string | null,
): AppLocale {
  return normalizeLocale(persistedLocale) ?? normalizeLocale(systemLocale) ?? 'zh-CN'
}

export function readStoredLocale(storage: LocaleStorage | null | undefined) {
  if (!storage) return null
  try {
    return normalizeLocale(storage.getItem(UI_LOCALE_SETTING_KEY))
  } catch {
    return null
  }
}

export function writeStoredLocale(
  storage: LocaleStorage | null | undefined,
  locale: AppLocale,
) {
  if (!storage) return false
  try {
    storage.setItem(UI_LOCALE_SETTING_KEY, locale)
    return true
  } catch {
    return false
  }
}
