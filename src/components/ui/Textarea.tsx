import { forwardRef, type TextareaHTMLAttributes } from 'react'

// ---------------------------------------------------------------------------
// Textarea — 纸面多行输入（与 Input 同一描边语言）
// ---------------------------------------------------------------------------

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** 透传为 data-testid（C6 约定） */
  testId?: string
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { testId, className = '', rows = 6, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      data-testid={testId}
      className={[
        'w-full resize-y rounded-sm border border-line bg-paper-raise px-3 py-2 text-sm leading-relaxed text-ink transition-colors duration-150',
        'placeholder:text-ink-4 hover:border-line-2 focus:border-ink focus:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      ].join(' ')}
      {...rest}
    />
  )
})
