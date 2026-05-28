import { forwardRef, type InputHTMLAttributes } from 'react'

// ---------------------------------------------------------------------------
// Input — 纸面单行输入（发丝描边，聚焦转墨色）
// ---------------------------------------------------------------------------

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** 透传为 data-testid（C6 约定） */
  testId?: string
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { testId, className = '', ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      data-testid={testId}
      className={[
        'h-9 w-full rounded-sm border border-line bg-paper-raise px-3 text-sm text-ink transition-colors duration-150',
        'placeholder:text-ink-4 hover:border-line-2 focus:border-ink focus:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      ].join(' ')}
      {...rest}
    />
  )
})
