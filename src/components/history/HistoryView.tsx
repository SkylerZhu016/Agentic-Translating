'use client'

import { useCallback, useEffect, useState } from 'react'
import { Badge, Button, Card, Modal, Spinner } from '@/src/components/ui'
import { PageHeader } from '@/src/components/shell/PageHeader'
import { useDirection } from '@/src/components/direction/DirectionProvider'
import { useI18n, type MessageKey, type Translator } from '@/src/i18n'
import type { BuiltinDirection } from '@/src/lib/contracts/vnext'
import { BatchManager } from './BatchManager'
import { UsageOverviewCard } from './UsageOverviewCard'

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

const SESSION_STATE_KEYS = {
  draft: 'history.state.draft',
  translating: 'history.state.translating',
  translated: 'history.state.translated',
  coordinating: 'history.state.coordinating',
  assembled: 'history.state.assembled',
  refining: 'history.state.refining',
  done: 'history.state.done',
} as const satisfies Record<string, MessageKey>

function directionLabel(t: Translator, direction?: string) {
  return direction === 'zh_to_en' ? t('direction.zhToEn') : t('direction.enToZh')
}

export function HistoryView() {
  const { direction } = useDirection()
  const { t, formatDate, formatNumber } = useI18n()
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
      if (!response.ok) throw new Error(t('history.error.read'))
      const payload = await response.json() as { sessions: HistorySession[] }
      setSessions(payload.sessions)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('history.error.load'))
    } finally {
      setLoading(false)
    }
  }, [filter, t])

  useEffect(() => {
    void load()
  }, [load])

  async function confirmDelete() {
    if (!deleting) return
    const response = await fetch(`/api/sessions/${encodeURIComponent(deleting.id)}`, {
      method: 'DELETE',
    })
    if (!response.ok) {
      setError(t('history.error.delete'))
      return
    }
    setDeleting(null)
    await load()
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <PageHeader
        overline={t('history.overline')}
        title={t('history.title')}
        description={t('history.description')}
      />
      <div className="mx-auto max-w-5xl space-y-4">
        <UsageOverviewCard />
        <Card
          overline={t('history.sessions.overline')}
          title={t('history.sessions.title')}
          actions={
            <div className="inline-flex rounded-sm border border-line-2 bg-paper p-0.5">
              {([
                ['all', t('history.filter.all')],
                ['en_to_zh', t('history.filter.enToZh')],
                ['zh_to_en', t('history.filter.zhToEn')],
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
              <Badge variant={tab === 'sessions' ? 'solid' : 'subtle'}>{t('history.tab.sessions')}</Badge>
            </button>
            <button type="button" onClick={() => setTab('batches')}>
              <Badge variant={tab === 'batches' ? 'solid' : 'subtle'}>{t('history.tab.batches')}</Badge>
            </button>
          </div>
          {tab === 'batches' ? (
            <BatchManager />
          ) : loading ? (
            <div className="flex min-h-40 items-center justify-center"><Spinner /></div>
          ) : error ? (
            <div role="alert" className="rounded-sm border border-cinnabar/30 bg-cinnabar/5 p-4 text-sm text-cinnabar">
              {error}
            </div>
          ) : sessions.length === 0 ? (
            <div className="rounded-sm border border-dashed border-line-2 bg-paper/60 px-4 py-12 text-center text-sm leading-6 text-ink-4">
              {t('history.empty')}
            </div>
          ) : (
            <ol className="divide-y divide-line">
              {sessions.map((session) => (
                <li key={session.id} className="py-4 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{directionLabel(t, session.direction)}</Badge>
                        <Badge variant="subtle">
                          {session.state in SESSION_STATE_KEYS
                            ? t(SESSION_STATE_KEYS[session.state as keyof typeof SESSION_STATE_KEYS])
                            : session.state}
                        </Badge>
                        <span className="text-xs text-ink-4">
                          {formatDate(session.updated_at, { dateStyle: 'medium', timeStyle: 'short' })}
                        </span>
                      </div>
                      <p className="mt-2 line-clamp-2 font-serif text-sm leading-6 text-ink">
                        {session.source_text}
                      </p>
                      {session.task_brief && (
                        <p className="mt-1 line-clamp-1 text-xs text-ink-3">
                          {t('history.requirements', { brief: session.task_brief })}
                        </p>
                      )}
                      <p className="mt-2 text-xs text-ink-4">
                        {t('history.calls', { count: formatNumber(session.agent_invocation_count) })}
                        {session.models.length > 0
                          ? ` · ${session.models.join(' / ')}`
                          : ''}
                        {session.latest_version
                          ? ` · ${t('history.finalVersion', { version: formatNumber(session.latest_version.version_no) })}`
                          : ''}
                      </p>
                    </div>
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <Button
                        href={`/?session=${encodeURIComponent(session.id)}`}
                        size="sm"
                        variant="outline"
                      >
                        {t('history.view')}
                      </Button>
                      <Button
                        href={`/api/sessions/${encodeURIComponent(session.id)}/export?format=md`}
                        size="sm"
                        variant="ghost"
                      >
                        {t('history.export.markdown')}
                      </Button>
                      <Button
                        href={`/api/sessions/${encodeURIComponent(session.id)}/export?format=json`}
                        size="sm"
                        variant="ghost"
                      >
                        {t('history.export.json')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDeleting(session)}
                      >
                        {t('history.delete')}
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
        title={t('history.delete.title')}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setDeleting(null)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={() => void confirmDelete()}>
              {t('history.delete')}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-6 text-ink-2">
          {t('history.delete.description')}
        </p>
      </Modal>
    </div>
  )
}
