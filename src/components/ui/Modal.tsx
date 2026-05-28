'use client'

import { useEffect, type HTMLAttributes, type ReactNode } from 'react'
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
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="presentation">
      {/* 墨罩 */}
      <div
        className="absolute inset-0 animate-fade bg-ink/35"
        aria-hidden
        onClick={onClose}
      />
      {/* 弹层 */}
      <div
        role="dialog"
        aria-modal="true"
        data-testid={testId}
        className={[
          'relative w-full max-w-lg animate-rise rounded-lg border border-line bg-paper-raise shadow-modal',
          className,
        ].join(' ')}
        {...rest}
      >
        {(title != null || onClose != null) && (
          <header className="flex items-center justify-between gap-4 border-b border-line px-5 py-3.5">
            {title != null ? (
              <h2 className="font-serif text-base font-medium text-ink">{title}</h2>
            ) : (
              <span />
            )}
            <Button variant="ghost" size="sm" aria-label="关闭" onClick={onClose} className="-mr-2 px-2">
              ✕
            </Button>
          </header>
        )}
        <div className="px-5 py-4">{children}</div>
        {footer != null && (
          <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  )
}
