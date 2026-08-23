import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LocaleProvider } from '@/src/i18n'
import { Card } from '@/src/components/ui/Card'
import { Modal } from '@/src/components/ui/Modal'

describe('responsive shared UI structure', () => {
  it('keeps a tall modal inside the viewport with an independently scrolling body', () => {
    const modal = createElement(
      Modal,
      {
        open: true,
        onClose: () => undefined,
        title: 'Edit endpoint',
        footer: createElement('button', null, 'Save'),
      },
      createElement(
        'form',
        null,
        createElement('input', { 'aria-label': 'Endpoint name' }),
      ),
    )
    const markup = renderToStaticMarkup(
      createElement(
        LocaleProvider,
        { initialLocale: 'en', children: modal },
      ),
    )

    expect(markup).toContain('role="dialog"')
    expect(markup).toContain('aria-modal="true"')
    expect(markup).toContain('max-h-[calc(100dvh-1rem)]')
    expect(markup).toContain('data-modal-scroll-region="true"')
    expect(markup).toContain('overflow-y-auto')
    expect(markup).toContain('shrink-0')
    expect(markup).toContain('aria-label="Close"')
  })

  it('lets card titles and actions wrap instead of collapsing the title', () => {
    const markup = renderToStaticMarkup(
      createElement(
        Card,
        {
          overline: 'Sessions',
          title: 'Translation history',
          actions: createElement('button', null, 'English to Chinese'),
        },
        'History content',
      ),
    )

    expect(markup).toContain('min-w-0')
    expect(markup).toContain('flex-col')
    expect(markup).toContain('flex-wrap')
    expect(markup).not.toContain('truncate')
  })
})
