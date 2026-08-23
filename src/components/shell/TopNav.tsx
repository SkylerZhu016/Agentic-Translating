'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useDirection } from '@/src/components/direction/DirectionProvider'
import {
  useI18n,
  useLocaleHydrationCommit,
} from '@/src/i18n/LocaleProvider'
import { TID } from '@/src/lib/testids'

// ---------------------------------------------------------------------------
// TopNav — 顶栏：方印标识 + 产品名 + 主导航（工作台 / 配置 / 历史）
// ---------------------------------------------------------------------------

const NAV_ITEMS = [
  { href: '/', labelKey: 'nav.workspace', shortLabelKey: 'nav.workspaceShort', exact: true },
  { href: '/config', labelKey: 'nav.config', shortLabelKey: 'nav.configShort', exact: false },
  { href: '/history', labelKey: 'nav.history', shortLabelKey: 'nav.historyShort', exact: false },
] as const

export function TopNav() {
  const pathname = usePathname()
  const { direction, requestDirection } = useDirection()
  const { locale, setLocale, t } = useI18n()
  useLocaleHydrationCommit()

  return (
    <header className="top-nav-shell sticky top-0 z-40 border-b border-line bg-paper/85 backdrop-blur-sm">
      <div className="top-nav-inner mx-auto flex min-h-topbar max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2 sm:h-topbar sm:flex-nowrap sm:px-6 sm:py-0">
        {/* 标识 */}
        <Link href="/" className="group flex min-w-0 items-center gap-2.5">
          <span className="seal-mark shrink-0">{t('brand.seal')}</span>
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="hidden truncate font-serif text-[0.9375rem] font-semibold tracking-wide text-ink lg:inline">
              Agentic Translating
            </span>
            <span className="hidden text-xs tracking-[0.18em] text-ink-3 lg:inline">
              · {t('brand.subtitle')}
            </span>
          </span>
        </Link>

        {/* 导航 */}
        <div className="top-nav-controls flex w-full shrink-0 items-center justify-between gap-1 sm:w-auto sm:justify-normal sm:gap-2">
          <nav aria-label={t('nav.primaryLabel')} className="top-nav-links flex items-center gap-1 sm:gap-2">
            {NAV_ITEMS.map((item) => {
              const active = item.exact ? pathname === item.href : pathname.startsWith(item.href)
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-label={t(item.labelKey)}
                  aria-current={active ? 'page' : undefined}
                  className={[
                    'top-nav-link relative rounded-xs px-1 py-1.5 text-sm transition-colors duration-150 sm:px-3',
                    active
                      ? 'font-medium text-ink after:absolute after:inset-x-2.5 after:-bottom-[13px] after:h-0.5 after:bg-ink sm:after:inset-x-3'
                      : 'text-ink-3 hover:text-ink',
                  ].join(' ')}
                >
                  <span className="top-nav-wide-label hidden sm:inline">{t(item.labelKey)}</span>
                  <span className="top-nav-compact-label sm:hidden">{t(item.shortLabelKey)}</span>
                </Link>
              )
            })}
          </nav>
          <div
            className="inline-flex rounded-sm border border-line-2 bg-paper p-0.5"
            role="group"
            aria-label={t('direction.switchLabel')}
          >
            {([
              ['en_to_zh', 'direction.enToZh', 'direction.enToZhShort'],
              ['zh_to_en', 'direction.zhToEn', 'direction.zhToEnShort'],
            ] as const).map(([value, desktopLabel, mobileLabel]) => (
              <button
                key={value}
                type="button"
                data-testid={
                  value === 'en_to_zh'
                    ? TID.direction.enToZhButton
                    : TID.direction.zhToEnButton
                }
                aria-pressed={direction === value}
                onClick={() => requestDirection(value)}
                className={[
                  'rounded-xs px-2 py-1 text-xs leading-4 transition-colors',
                  direction === value
                    ? 'bg-ink text-paper'
                    : 'text-ink-3 hover:text-ink',
                ].join(' ')}
              >
                <span className="top-nav-wide-label hidden sm:inline">{t(desktopLabel)}</span>
                <span className="top-nav-compact-label sm:hidden">{t(mobileLabel)}</span>
              </button>
            ))}
          </div>
          <div
            className="inline-flex rounded-sm border border-line-2 bg-paper p-0.5"
            role="group"
            aria-label={t('locale.switchLabel')}
          >
            {([
              ['zh-CN', 'locale.zhCNShort', 'locale.zhCN'],
              ['en', 'locale.enShort', 'locale.en'],
            ] as const).map(([value, shortLabelKey, labelKey]) => (
              <button
                key={value}
                type="button"
                lang={value}
                data-testid={`locale-${value}`}
                aria-label={t(labelKey)}
                aria-pressed={locale === value}
                onClick={() => setLocale(value)}
                className={[
                  'rounded-xs px-1.5 py-1 text-xs leading-4 transition-colors',
                  locale === value
                    ? 'bg-ink text-paper'
                    : 'text-ink-3 hover:text-ink',
                ].join(' ')}
              >
                {t(shortLabelKey)}
              </button>
            ))}
          </div>
        </div>
      </div>
    </header>
  )
}
