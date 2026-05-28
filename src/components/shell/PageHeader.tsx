import type { ReactNode } from 'react'

// ---------------------------------------------------------------------------
// PageHeader — 页眉：英文书眉 + 衬线中文标题 + 说明
// ---------------------------------------------------------------------------

export interface PageHeaderProps {
  overline: string
  title: string
  description?: string
  actions?: ReactNode
}

export function PageHeader({ overline, title, description, actions }: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="overline-label">{overline}</p>
        <h1 className="mt-1.5 font-serif text-2xl font-semibold tracking-wide text-ink">{title}</h1>
        {description != null && <p className="mt-1.5 max-w-2xl text-sm leading-6 text-ink-3">{description}</p>}
      </div>
      {actions != null && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}
