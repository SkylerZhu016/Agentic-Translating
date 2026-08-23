'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { usePathname } from 'next/navigation'
import {
  formatCurrency as formatCurrencyValue,
  formatDate as formatDateValue,
  formatDuration as formatDurationValue,
  formatNumber as formatNumberValue,
} from './formatters'
import {
  normalizeLocale,
  readStoredLocale,
  resolveLocale,
  UI_LOCALE_SETTING_KEY,
  writeStoredLocale,
} from './locale'
import { translate } from './translate'
import type { AppLocale, Translator } from './types'

interface LocaleContextValue {
  locale: AppLocale
  setLocale: (locale: AppLocale) => void
  t: Translator
  formatDate: (
    value: Date | number | string,
    options?: Intl.DateTimeFormatOptions,
  ) => string
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string
  formatCurrency: (
    value: number,
    currency?: string,
    options?: Omit<Intl.NumberFormatOptions, 'style' | 'currency'>,
  ) => string
  formatDuration: (milliseconds: number, options?: { maxParts?: number }) => string
}

const LocaleContext = createContext<LocaleContextValue | null>(null)
const LocaleHydrationContext = createContext<(() => void) | null>(null)

export function resolveHydrationLocale(
  initialLocale: AppLocale,
  currentLocale: AppLocale,
  hydrated: boolean,
) {
  return hydrated ? currentLocale : initialLocale
}

async function readLocaleSetting() {
  try {
    const response = await fetch('/api/settings')
    if (!response.ok) return null
    const settings = await response.json() as Array<{ key: string; value: string }>
    return settings.find((entry) => entry.key === UI_LOCALE_SETTING_KEY)?.value ?? null
  } catch {
    return null
  }
}

async function saveLocaleSetting(locale: AppLocale) {
  try {
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: UI_LOCALE_SETTING_KEY, value: locale }),
    })
  } catch {
    // Browser storage still preserves the preference when the local API is unavailable.
  }
}

function setDocumentLocale(locale: AppLocale, pathname: string) {
  if (typeof document === 'undefined') return
  document.documentElement.lang = locale
  document.title = pathname.startsWith('/config')
    ? translate(locale, 'metadata.route.config')
    : pathname.startsWith('/history')
      ? translate(locale, 'metadata.route.history')
      : translate(locale, 'metadata.route.workspace')
  const description = document.querySelector<HTMLMetaElement>('meta[name="description"]')
  if (description) description.content = translate(locale, 'metadata.description')
}

function getBrowserStorage() {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function LocaleProvider({
  children,
  initialLocale = 'zh-CN',
}: {
  children: ReactNode
  initialLocale?: AppLocale
}) {
  const pathname = usePathname()
  const [locale, setLocaleState] = useState<AppLocale>(initialLocale)
  const [hydrated, setHydrated] = useState(false)
  const renderedLocale = resolveHydrationLocale(initialLocale, locale, hydrated)

  const applyLocale = useCallback((nextLocale: AppLocale) => {
    setLocaleState(nextLocale)
  }, [])

  const commitHydration = useCallback(() => {
    setHydrated(true)
  }, [])

  useEffect(() => {
    setDocumentLocale(renderedLocale, pathname)
    void window.agenticDesktop?.setLocale(renderedLocale)
  }, [pathname, renderedLocale])

  useEffect(() => {
    let active = true
    const storage = getBrowserStorage()
    const localLocale = readStoredLocale(storage)
    const systemLocale = window.navigator.language
    const immediateLocale = resolveLocale(localLocale, systemLocale)
    applyLocale(immediateLocale)

    void readLocaleSetting().then((settingLocale) => {
      if (!active) return
      const resolvedLocale = normalizeLocale(settingLocale)
        ?? localLocale
        ?? resolveLocale(null, systemLocale)
      applyLocale(resolvedLocale)
      writeStoredLocale(storage, resolvedLocale)
      if (settingLocale == null) void saveLocaleSetting(resolvedLocale)
    })

    return () => {
      active = false
    }
  }, [applyLocale])

  const setLocale = useCallback((nextLocale: AppLocale) => {
    applyLocale(nextLocale)
    writeStoredLocale(getBrowserStorage(), nextLocale)
    void saveLocaleSetting(nextLocale)
  }, [applyLocale])

  const t = useCallback(
    ((key, ...args) => translate(renderedLocale, key, ...args)) as Translator,
    [renderedLocale],
  )
  const formatDate = useCallback(
    (value: Date | number | string, options?: Intl.DateTimeFormatOptions) =>
      formatDateValue(value, renderedLocale, options),
    [renderedLocale],
  )
  const formatNumber = useCallback(
    (value: number, options?: Intl.NumberFormatOptions) =>
      formatNumberValue(value, renderedLocale, options),
    [renderedLocale],
  )
  const formatCurrency = useCallback(
    (
      value: number,
      currency?: string,
      options?: Omit<Intl.NumberFormatOptions, 'style' | 'currency'>,
    ) => formatCurrencyValue(value, renderedLocale, currency, options),
    [renderedLocale],
  )
  const formatDuration = useCallback(
    (milliseconds: number, options?: { maxParts?: number }) =>
      formatDurationValue(milliseconds, renderedLocale, options),
    [renderedLocale],
  )

  const context = useMemo<LocaleContextValue>(() => ({
    locale: renderedLocale,
    setLocale,
    t,
    formatDate,
    formatNumber,
    formatCurrency,
    formatDuration,
  }), [
    formatCurrency,
    formatDate,
    formatDuration,
    formatNumber,
    renderedLocale,
    setLocale,
    t,
  ])

  return (
    <LocaleHydrationContext.Provider value={commitHydration}>
      <LocaleContext.Provider value={context}>{children}</LocaleContext.Provider>
    </LocaleHydrationContext.Provider>
  )
}

export function useI18n() {
  const context = useContext(LocaleContext)
  if (!context) throw new Error('useI18n must be used inside LocaleProvider')
  return context
}

/**
 * Releases the deterministic server locale only after the app shell itself has
 * hydrated. LocaleProvider sits outside Suspense, so committing from the
 * provider's own effect can otherwise race a deferred TopNav hydration.
 */
export function useLocaleHydrationCommit() {
  const commitHydration = useContext(LocaleHydrationContext)
  if (!commitHydration) {
    throw new Error('useLocaleHydrationCommit must be used inside LocaleProvider')
  }

  useEffect(() => {
    commitHydration()
  }, [commitHydration])
}
