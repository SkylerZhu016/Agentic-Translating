'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

// ---------------------------------------------------------------------------
// TopNav — 顶栏：方印标识 + 产品名 + 主导航（工作台 / 配置 / 历史）
// ---------------------------------------------------------------------------

const NAV_ITEMS = [
  { href: '/', label: '工作台', exact: true },
  { href: '/config', label: '配置', exact: false },
  { href: '/history', label: '历史', exact: false },
] as const

export function TopNav() {
  const pathname = usePathname()

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-paper/85 backdrop-blur-sm">
      <div className="mx-auto flex h-topbar max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        {/* 标识 */}
        <Link href="/" className="group flex min-w-0 items-center gap-2.5">
          <span className="seal-mark shrink-0">译</span>
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate font-serif text-[0.9375rem] font-semibold tracking-wide text-ink">
              Agentic Translating
            </span>
            <span className="hidden text-xs tracking-[0.18em] text-ink-3 md:inline">
              · 智能体翻译工作台
            </span>
          </span>
        </Link>

        {/* 导航 */}
        <nav aria-label="主导航" className="flex shrink-0 items-center gap-1 sm:gap-2">
          {NAV_ITEMS.map((item) => {
            const active = item.exact ? pathname === item.href : pathname.startsWith(item.href)
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={[
                  'relative rounded-xs px-2.5 py-1.5 text-sm transition-colors duration-150 sm:px-3',
                  active
                    ? 'font-medium text-ink after:absolute after:inset-x-2.5 after:-bottom-[13px] after:h-0.5 after:bg-ink sm:after:inset-x-3'
                    : 'text-ink-3 hover:text-ink',
                ].join(' ')}
              >
                {item.label}
              </Link>
            )
          })}
        </nav>
      </div>
    </header>
  )
}
