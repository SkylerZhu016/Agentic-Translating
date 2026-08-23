import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DirectionSettingsCard } from '@/src/components/config/DirectionSettingsCard'
import { LocaleProvider } from '@/src/i18n'

vi.mock('next/navigation', () => ({
  usePathname: () => '/config',
}))

describe('DirectionSettingsCard responsive actions', () => {
  it('gives the description its own mobile row without expanding the card', () => {
    const card = createElement(DirectionSettingsCard, { notify: vi.fn() })
    const markup = renderToStaticMarkup(
      createElement(LocaleProvider, { initialLocale: 'en', children: card }),
    )

    expect(markup).toContain('data-testid="direction-settings-actions"')
    expect(markup).toContain('w-full min-w-0 max-w-full flex-wrap')
    expect(markup).toContain('w-full min-w-0 max-w-xl')
    expect(markup).toContain('sm:w-auto sm:flex-1')
    expect(markup).toContain('Restore direction-switch prompt')
  })
})
