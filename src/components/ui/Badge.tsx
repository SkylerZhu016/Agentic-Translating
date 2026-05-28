import type { HTMLAttributes, ReactNode } from 'react'

// ---------------------------------------------------------------------------
// Badge — 单色状态章（solid 实墨 / outline 描边 / subtle 纸灰）
// 近直角小章，印刷批注感；状态语义由文案与变体组合承担（单色主题）
// ---------------------------------------------------------------------------

type BadgeVariant = 'solid' | 'outline' | 'subtle'

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant
  /** 透传为 data-testid（C6 约定） */
  testId?: string
  children: ReactNode
}

const variantClass: Record<BadgeVariant, string> = {
  solid: 'bg-ink text-paper',
  outline: 'border border-line-2 text-ink-2',
  subtle: 'bg-paper-sink text-ink-2',
}

export function Badge({ variant = 'subtle', testId, className = '', children, ...rest }: BadgeProps) {
  return (
    <span
      data-testid={testId}
      className={[
        'inline-flex items-center gap-1 rounded-xs px-1.5 py-0.5 text-[0.6875rem] font-medium leading-4 tracking-wide',
        variantClass[variant],
        className,
      ].join(' ')}
      {...rest}
    >
      {children}
    </span>
  )
}
