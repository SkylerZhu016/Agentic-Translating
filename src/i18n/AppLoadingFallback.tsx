'use client'

import { useI18n } from './LocaleProvider'

export function AppLoadingFallback() {
  const { t } = useI18n()

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 text-sm text-ink-3">
      {t('app.loading')}
    </main>
  )
}
