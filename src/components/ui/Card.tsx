import type { HTMLAttributes, ReactNode } from 'react'

// ---------------------------------------------------------------------------
// Card — 抬升纸面卡片：可选书眉（overline）+ 标题 + 操作位
// ---------------------------------------------------------------------------

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** 书眉小标签（如 "SOURCE"），位于标题上方 */
  overline?: string
  /** 卡片标题（衬线） */
  title?: ReactNode
  /** 标题行右侧操作区 */
  actions?: ReactNode
  /** body 内边距开关，默认 true */
  padded?: boolean
  /** 透传为 data-testid（C6 约定） */
  testId?: string
}

export function Card({
  overline,
  title,
  actions,
  padded = true,
  testId,
  className = '',
  children,
  ...rest
}: CardProps) {
  const hasHeader = overline != null || title != null || actions != null
  return (
    <section
      data-testid={testId}
      className={[
        'min-w-0 break-words rounded-md border border-line bg-paper-raise shadow-card',
        className,
      ].join(' ')}
      {...rest}
    >
      {hasHeader && (
        <header className="flex min-w-0 flex-col items-stretch gap-3 border-b border-line px-5 pb-3 pt-4 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
          <div className="min-w-0 max-w-full">
            {overline != null && <p className="overline-label">{overline}</p>}
            {title != null && (
              <h2 className="mt-1 break-words font-serif text-base font-medium text-ink">{title}</h2>
            )}
          </div>
          {actions != null && (
            <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 sm:shrink-0">
              {actions}
            </div>
          )}
        </header>
      )}
      <div className={padded ? 'min-w-0 px-5 py-4' : 'min-w-0'}>{children}</div>
    </section>
  )
}
