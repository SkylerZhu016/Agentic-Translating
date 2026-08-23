'use client'

import { useEffect, useId, useRef, type HTMLAttributes, type ReactNode } from 'react'
import { useI18n } from '@/src/i18n/LocaleProvider'
import { Button } from './Button'

// ---------------------------------------------------------------------------
// Modal — 墨罩 + 纸面弹层（Esc / 点罩关闭）
// ---------------------------------------------------------------------------

export interface ModalProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  open: boolean
  onClose: () => void
  title?: ReactNode
  /** 底部操作区 */
  footer?: ReactNode
  /** 透传为 data-testid（C6 约定），挂在弹层面板上 */
  testId?: string
}

export function Modal({
  open,
  onClose,
  title,
  footer,
  testId,
  className = '',
  children,
  ...rest
}: ModalProps) {
  const { t } = useI18n()
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!open) return
    const opener = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const panel = panelRef.current
    const focusable = (root: ParentNode | null = panel) => Array.from(
      root?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((element) => (
      !element.hasAttribute('hidden')
      && element.getAttribute('aria-hidden') !== 'true'
      && element.getClientRects().length > 0
    ))

    let mounted = true
    queueMicrotask(() => {
      if (!mounted) return
      const initialTarget = panel?.querySelector<HTMLElement>('[data-modal-autofocus]')
        ?? focusable(contentRef.current)[0]
        ?? panel
      initialTarget?.focus({ preventScroll: true })
    })
    const previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const elements = focusable()
      if (elements.length === 0) {
        e.preventDefault()
        panel?.focus()
        return
      }
      const first = elements[0]
      const last = elements[elements.length - 1]
      if (!panel?.contains(document.activeElement)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      mounted = false
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousBodyOverflow
      opener?.focus()
    }
  }, [open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4" role="presentation">
      {/* 墨罩 */}
      <div
        className="absolute inset-0 animate-fade bg-ink/35"
        aria-hidden
        onClick={onClose}
      />
      {/* 弹层 */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title != null ? titleId : undefined}
        tabIndex={-1}
        data-testid={testId}
        className={[
          'relative flex max-h-[calc(100dvh-1rem)] min-h-0 w-full max-w-lg flex-col overflow-hidden rounded-lg border border-line bg-paper-raise shadow-modal sm:max-h-[calc(100dvh-2rem)] sm:animate-rise',
          className,
        ].join(' ')}
        {...rest}
      >
        {(title != null || onClose != null) && (
          <header className="flex shrink-0 items-center justify-between gap-4 border-b border-line bg-paper-raise px-5 py-3.5">
            {title != null ? (
              <h2 id={titleId} className="font-serif text-base font-medium text-ink">{title}</h2>
            ) : (
              <span />
            )}
            <Button variant="ghost" size="sm" aria-label={t('ui.modal.close')} onClick={onClose} className="-mr-2 px-2">
              ✕
            </Button>
          </header>
        )}
        <div
          ref={contentRef}
          data-modal-scroll-region
          className="min-h-0 min-w-0 overflow-y-auto overscroll-contain px-5 py-4"
        >
          {children}
        </div>
        {footer != null && (
          <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line bg-paper-raise px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  )
}
