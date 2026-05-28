import type { Metadata } from 'next'
import { Card } from '@/src/components/ui'
import { PageHeader } from '@/src/components/shell/PageHeader'

export const metadata: Metadata = { title: '历史' }

export default function HistoryPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <PageHeader
        overline="History"
        title="历史"
        description="每次翻译任务完成后，原文、各 Agent 译文与最终版本将在此留存快照，可回溯可恢复。"
      />

      <div className="max-w-3xl">
        <Card overline="Sessions" title="历史会话">
          <div className="rounded-sm border border-dashed border-line-2 bg-paper/60 px-4 py-12 text-center text-sm leading-6 text-ink-4">
            暂无历史会话。完成一次翻译后将自动留存。
          </div>
        </Card>
      </div>
    </div>
  )
}
