'use client'

import type { HTMLAttributes } from 'react'
import { useI18n } from '@/src/i18n/LocaleProvider'

// ---------------------------------------------------------------------------
// Spinner — 墨弧加载指示（currentColor，随上下文着色）
// ---------------------------------------------------------------------------

type SpinnerSize = 'sm' | 'md' | 'lg'

export interface SpinnerProps extends HTMLAttributes<SVGSVGElement> {
  size?: SpinnerSize
  /** 透传为 data-testid（C6 约定） */
  testId?: string
}

const sizeClass: Record<SpinnerSize, string> = {
  sm: 'h-3.5 w-3.5',
  md: 'h-4.5 w-4.5',
  lg: 'h-6 w-6',
}

export function Spinner({ size = 'md', testId, className = '', ...rest }: SpinnerProps) {
  const { t } = useI18n()
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      role="status"
      aria-label={t('ui.spinner.loading')}
      data-testid={testId}
      className={['animate-spin text-current', sizeClass[size], className].join(' ')}
      {...rest}
    >
      <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2.5" />
      <path
        d="M21.5 12a9.5 9.5 0 0 0-9.5-9.5"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  )
}
