import Link from 'next/link'
import { forwardRef, type ButtonHTMLAttributes, type MouseEventHandler } from 'react'

// ---------------------------------------------------------------------------
// Button — 墨色单色三变体（primary 实墨 / outline 描边 / ghost 幽灵）
// testId → data-testid 透传；亦可直接传 data-testid（rest 覆盖优先）
// 传 href 时渲染为链接（同款样式），用于 CTA 导航
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'outline' | 'ghost'
type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** 提供时渲染为 <Link>（忽略 button 原生属性） */
  href?: string
  /** 透传为 data-testid（C6 约定） */
  testId?: string
}

const variantClass: Record<ButtonVariant, string> = {
  primary: 'bg-ink text-paper hover:bg-ink-2 active:bg-ink',
  outline: 'border border-line-2 bg-paper-raise text-ink hover:bg-paper-sink',
  ghost: 'text-ink-2 hover:bg-paper-sink hover:text-ink',
}

const sizeClass: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[0.8125rem]',
  md: 'h-9 px-4 text-sm',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    href,
    testId,
    className = '',
    type = 'button',
    onClick,
    children,
    ...rest
  },
  ref,
) {
  const classNames = [
    'inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-sm font-medium transition-colors duration-150',
    'disabled:pointer-events-none disabled:opacity-45',
    variantClass[variant],
    sizeClass[size],
    className,
  ].join(' ')

  if (href != null) {
    return (
      <Link
        href={href}
        data-testid={testId}
        className={classNames}
        onClick={onClick as unknown as MouseEventHandler<HTMLAnchorElement>}
      >
        {children}
      </Link>
    )
  }

  return (
    <button
      ref={ref}
      type={type}
      data-testid={testId}
      className={classNames}
      onClick={onClick}
      {...rest}
    >
      {children}
    </button>
  )
})
