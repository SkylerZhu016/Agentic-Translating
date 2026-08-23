import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LocaleProvider, useI18n } from '@/src/i18n'
import { resolveHydrationLocale } from '@/src/i18n/LocaleProvider'

function LocaleProbe() {
  const { locale, t, formatNumber } = useI18n()
  return (
    <output>
      {locale}|{t('common.itemCount', { count: 2 })}|{formatNumber(1234)}
    </output>
  )
}

describe('LocaleProvider', () => {
  it('keeps the server locale through hydration before applying the client preference', () => {
    expect(resolveHydrationLocale('zh-CN', 'en', false)).toBe('zh-CN')
    expect(resolveHydrationLocale('zh-CN', 'en', true)).toBe('en')
  })

  it('provides the requested initial locale, translator, and bound formatters', () => {
    const markup = renderToStaticMarkup(
      <LocaleProvider initialLocale="en">
        <LocaleProbe />
      </LocaleProvider>,
    )

    expect(markup).toContain('en|2 items|1,234')
  })

  it('uses Chinese as the deterministic server-rendered default', () => {
    const markup = renderToStaticMarkup(
      <LocaleProvider>
        <LocaleProbe />
      </LocaleProvider>,
    )

    expect(markup).toContain('zh-CN|共 2 项|1,234')
  })

  it('requires consumers to be nested under the provider', () => {
    expect(() => renderToStaticMarkup(<LocaleProbe />))
      .toThrow('useI18n must be used inside LocaleProvider')
  })
})
