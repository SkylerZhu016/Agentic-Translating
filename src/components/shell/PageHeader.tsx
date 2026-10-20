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
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="overline-label mb-1">{overline}</p>
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {description != null && <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-3">{description}</p>}
      </div>
      {actions != null && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}
