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
        'rounded-md border border-line bg-paper-raise shadow-card',
        className,
      ].join(' ')}
      {...rest}
    >
      {hasHeader && (
        <header className="flex items-end justify-between gap-4 border-b border-line px-5 pb-3 pt-4">
          <div className="min-w-0">
            {overline != null && <p className="overline-label">{overline}</p>}
            {title != null && (
              <h2 className="mt-1 truncate font-serif text-base font-medium text-ink">{title}</h2>
            )}
          </div>
          {actions != null && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'px-5 py-4' : undefined}>{children}</div>
    </section>
  )
}
