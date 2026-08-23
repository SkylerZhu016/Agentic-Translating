import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '@/src/i18n'
import { TopNav } from '@/src/components/shell/TopNav'

vi.mock('next/navigation', () => ({
  usePathname: () => '/config',
}))

vi.mock('@/src/components/direction/DirectionProvider', () => ({
  useDirection: () => ({
    direction: 'en_to_zh',
    requestDirection: vi.fn(),
  }),
}))

describe('TopNav responsive markup', () => {
  it('keeps complete accessible names for the compact mobile labels', () => {
    const nav = createElement(TopNav)
    const markup = renderToStaticMarkup(
      createElement(LocaleProvider, { initialLocale: 'en', children: nav }),
    )

    expect(markup).toContain('aria-label="Workspace"')
    expect(markup).toContain('aria-label="Settings"')
    expect(markup).toContain('aria-label="History"')
  })
})
