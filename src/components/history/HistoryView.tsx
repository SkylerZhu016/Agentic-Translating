'use client'

import { useCallback, useEffect, useState } from 'react'
import { Badge, Button, Card, Modal, Spinner } from '@/src/components/ui'
import { PageHeader } from '@/src/components/shell/PageHeader'
import { useDirection } from '@/src/components/direction/DirectionProvider'
import type { BuiltinDirection } from '@/src/lib/contracts/vnext'
import { BatchManager } from './BatchManager'

interface HistorySession {
  id: string
  source_text: string
  state: string
  direction?: BuiltinDirection
  task_brief?: string
  review_mode?: string
  created_at: string
  updated_at: string
  agent_invocation_count: number
  models: string[]
  latest_version: {
    version_no: number
    text: string
    source: string
  } | null
}

type Filter = BuiltinDirection | 'all'

function directionLabel(direction?: string) {
  return direction === 'zh_to_en' ? '中 → 英' : '英 → 中'
}

export function HistoryView() {
  const { direction } = useDirection()
  const [filter, setFilter] = useState<Filter>(direction)
  const [tab, setTab] = useState<'sessions' | 'batches'>('sessions')
  const [sessions, setSessions] = useState<HistorySession[]>([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState<HistorySession | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => setFilter(direction), [direction])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const query = filter === 'all' ? '' : `&direction=${filter}`
      const response = await fetch(`/api/sessions?limit=100${query}`, {
        cache: 'no-store',
      })
      if (!response.ok) throw new Error('无法读取历史会话')
      const payload = await response.json() as { sessions: HistorySession[] }
      setSessions(payload.sessions)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    void load()
  }, [load])

  async function confirmDelete() {
    if (!deleting) return
    const response = await fetch(`/api/sessions/${encodeURIComponent(deleting.id)}`, {
      method: 'DELETE',
    })
    if (!response.ok) {
      setError('删除失败，请稍后重试')
      return
    }
    setDeleting(null)
    await load()
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <PageHeader
        overline="History"
        title="历史"
        description="会话、候选来源、审议过程、工具事件与文本版本均可恢复和导出。"
      />
      <div className="mx-auto max-w-5xl">
        <Card
          overline="Sessions"
          title="历史会话"
          actions={
            <div className="inline-flex rounded-sm border border-line-2 bg-paper p-0.5">
              {([
                ['all', '全部'],
                ['en_to_zh', '英译中'],
                ['zh_to_en', '中译英'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setFilter(value)}
                  className={[
                    'rounded-xs px-2 py-1 text-xs',
                    filter === value
                      ? 'bg-ink text-paper'
                      : 'text-ink-3 hover:text-ink',
                  ].join(' ')}
                >
                  {label}
                </button>
              ))}
            </div>
          }
        >
          <div className="mb-4 flex gap-2 border-b border-line pb-3">
            <button type="button" onClick={() => setTab('sessions')}>
              <Badge variant={tab === 'sessions' ? 'solid' : 'subtle'}>单篇任务</Badge>
            </button>
            <button type="button" onClick={() => setTab('batches')}>
              <Badge variant={tab === 'batches' ? 'solid' : 'subtle'}>批量任务</Badge>
            </button>
          </div>
          {tab === 'batches' ? (
            <BatchManager />
          ) : loading ? (
            <div className="flex min-h-40 items-center justify-center"><Spinner /></div>
          ) : error ? (
            <div className="rounded-sm border border-cinnabar/30 bg-cinnabar/5 p-4 text-sm text-cinnabar">
              {error}
            </div>
          ) : sessions.length === 0 ? (
            <div className="rounded-sm border border-dashed border-line-2 bg-paper/60 px-4 py-12 text-center text-sm leading-6 text-ink-4">
              当前筛选下暂无历史会话。
            </div>
          ) : (
            <ol className="divide-y divide-line">
              {sessions.map((session) => (
                <li key={session.id} className="py-4 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{directionLabel(session.direction)}</Badge>
                        <Badge variant="subtle">{session.state}</Badge>
                        <span className="text-xs text-ink-4">
                          {session.updated_at}
                        </span>
                      </div>
                      <p className="mt-2 line-clamp-2 font-serif text-sm leading-6 text-ink">
                        {session.source_text}
                      </p>
                      {session.task_brief && (
                        <p className="mt-1 line-clamp-1 text-xs text-ink-3">
                          要求：{session.task_brief}
                        </p>
                      )}
                      <p className="mt-2 text-xs text-ink-4">
                        实际调用 {session.agent_invocation_count} 个 Agent
                        {session.models.length > 0
                          ? ` · ${session.models.join(' / ')}`
                          : ''}
                        {session.latest_version
                          ? ` · 最终 v${session.latest_version.version_no}`
                          : ''}
                      </p>
                    </div>
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <Button
                        href={`/?session=${encodeURIComponent(session.id)}`}
                        size="sm"
                        variant="outline"
                      >
                        查看 / 继续
                      </Button>
                      <Button
                        href={`/api/sessions/${encodeURIComponent(session.id)}/export?format=md`}
                        size="sm"
                        variant="ghost"
                      >
                        Markdown
                      </Button>
                      <Button
                        href={`/api/sessions/${encodeURIComponent(session.id)}/export?format=json`}
                        size="sm"
                        variant="ghost"
                      >
                        JSON
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDeleting(session)}
                      >
                        删除
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
      <Modal
        open={deleting != null}
        onClose={() => setDeleting(null)}
        title="删除历史会话？"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button size="sm" onClick={() => void confirmDelete()}>
              删除
            </Button>
          </>
        }
      >
        <p className="text-sm leading-6 text-ink-2">
          会话、候选输出、版本和审计事件将一并删除。此操作不可恢复。
        </p>
      </Modal>
    </div>
  )
}
