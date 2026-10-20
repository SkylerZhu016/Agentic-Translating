'use client'

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Badge, Button, Card, Input, Modal, Spinner } from '@/src/components/ui'
import { PageHeader } from '@/src/components/shell/PageHeader'
import { useDirection } from '@/src/components/direction/DirectionProvider'
import { useI18n, type MessageKey, type Translator } from '@/src/i18n'
import type { BuiltinDirection, TranslationDirection } from '@/src/lib/contracts/vnext'

function PanelLoading() {
  return <div className="flex min-h-32 items-center justify-center"><Spinner /></div>
}
const BatchManager = dynamic(() => import('./BatchManager').then((module) => module.BatchManager), { loading: PanelLoading })
const UsageOverviewCard = dynamic(() => import('./UsageOverviewCard').then((module) => module.UsageOverviewCard), { loading: PanelLoading })

interface HistorySession {
  id: string
  source_text: string
  state: string
  direction?: TranslationDirection
  task_brief?: string
  review_mode?: string
  created_at: string
  updated_at: string
  agent_invocation_count: number
  models: string[]
  latest_version: { version_no: number; text: string; source: string } | null
}

type Filter = BuiltinDirection | 'all'
type Tab = 'sessions' | 'batches' | 'usage'
const PAGE_SIZE = 40
const SESSION_STATE_KEYS = {
  draft: 'history.state.draft', translating: 'history.state.translating',
  translated: 'history.state.translated', coordinating: 'history.state.coordinating',
  assembled: 'history.state.assembled', refining: 'history.state.refining', done: 'history.state.done',
} as const satisfies Record<string, MessageKey>

function directionLabel(t: Translator, direction?: string) {
  if (direction === 'custom') return t('project.direction.custom')
  return direction === 'zh_to_en' ? t('direction.zhToEn') : t('direction.enToZh')
}

export function HistoryView() {
  const { direction } = useDirection()
  const { t, formatDate, formatNumber } = useI18n()
  const [filter, setFilter] = useState<Filter>(direction)
  const [tab, setTab] = useState<Tab>('sessions')
  const [sessions, setSessions] = useState<HistorySession[]>([])
  const [total, setTotal] = useState(0)
  const [nextOffset, setNextOffset] = useState(0)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [deleting, setDeleting] = useState<HistorySession | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  useEffect(() => setFilter(direction), [direction])

  const load = useCallback(async (offset = 0) => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setLoading(offset === 0)
    setLoadingMore(offset > 0)
    setError(null)
    try {
      const query = filter === 'all' ? '' : `&direction=${filter}`
      const response = await fetch(`/api/sessions?order=created&limit=${PAGE_SIZE}&offset=${offset}${query}`, {
        cache: 'no-store', signal: controller.signal,
      })
      if (!response.ok) throw new Error(t('history.error.read'))
      const payload = await response.json() as { sessions: HistorySession[]; total: number }
      if (controller.signal.aborted) return
      setSessions((current) => offset === 0 ? payload.sessions : [
        ...current, ...payload.sessions.filter((item) => !current.some((existing) => existing.id === item.id)),
      ])
      setTotal(payload.total)
      // Creation order remains stable while background sessions are updated.
      // Count server rows separately from the deduplicated visible collection.
      setNextOffset(offset + payload.sessions.length)
    } catch (loadError) {
      if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : t('history.error.load'))
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [filter, t])

  useEffect(() => {
    if (tab === 'sessions') {
      setSessions([])
      setTotal(0)
      setNextOffset(0)
      void load()
    }
    return () => controllerRef.current?.abort()
  }, [load, tab])

  const visibleSessions = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    if (!query) return sessions
    return sessions.filter((session) => [session.source_text, session.task_brief ?? '', ...session.models]
      .some((value) => value.toLocaleLowerCase().includes(query)))
  }, [search, sessions])

  async function confirmDelete() {
    if (!deleting || deleteBusy) return
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(deleting.id)}`, { method: 'DELETE' })
      if (!response.ok) throw new Error(t('history.error.delete'))
      if (!mountedRef.current) return
      setDeleting(null)
      await load()
    } catch (deleteFailure) {
      if (mountedRef.current) setDeleteError(deleteFailure instanceof Error ? deleteFailure.message : t('history.error.delete'))
    } finally {
      if (mountedRef.current) setDeleteBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
      <PageHeader overline={t('history.overline')} title={t('history.title')} description={t('history.description')} />
      <div className="space-y-4">
        <nav className="flex w-fit max-w-full flex-wrap gap-1 rounded-md border border-line bg-paper-raise p-1" aria-label={t('history.title')}>
          {([
            ['sessions', 'history.tab.sessions'], ['batches', 'history.tab.batches'], ['usage', 'history.tab.usage'],
          ] as const).map(([value, label]) => (
            <button key={value} type="button" aria-pressed={tab === value} onClick={() => setTab(value)} className={[
              'rounded-sm px-4 py-2 text-sm font-medium transition-colors',
              tab === value ? 'bg-ink text-paper' : 'text-ink-3 hover:bg-paper-sink hover:text-ink',
            ].join(' ')}>{t(label)}</button>
          ))}
        </nav>
        {tab === 'usage' ? <UsageOverviewCard /> : tab === 'batches' ? (
          <Card title={t('history.tab.batches')}><BatchManager /></Card>
        ) : (
          <Card title={t('history.sessions.title')} actions={
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="subtle">{t('common.itemCount', { count: formatNumber(total) })}</Badge>
              <Button variant="outline" size="sm" disabled={loading || loadingMore} onClick={() => void load()}>{t('common.refresh')}</Button>
            </div>
          }>
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <div className="min-w-48 flex-1">
                <Input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('history.search')} aria-label={t('history.search')} />
              </div>
              <div className="inline-flex rounded-sm border border-line bg-paper p-0.5">
                {([
                  ['all', t('history.filter.all')], ['en_to_zh', t('history.filter.enToZh')], ['zh_to_en', t('history.filter.zhToEn')],
                ] as const).map(([value, label]) => (
                  <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)} className={[
                    'rounded-xs px-3 py-1.5 text-xs font-medium', filter === value ? 'bg-ink text-paper' : 'text-ink-3 hover:text-ink',
                  ].join(' ')}>{label}</button>
                ))}
              </div>
            </div>
            <p className="mb-3 text-xs text-ink-4">{t('history.order.created')}</p>
            {search.trim() && <p className="mb-3 text-xs text-ink-4">{t('history.search.scope', { count: formatNumber(sessions.length) })}</p>}
            {error && <div role="alert" className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-sm border border-cinnabar/30 bg-cinnabar/5 p-3 text-sm text-cinnabar">
              <p>{error}</p><Button size="sm" variant="outline" onClick={() => void load()}>{t('common.retry')}</Button>
            </div>}
            {loading ? <PanelLoading /> : !error && visibleSessions.length === 0 ? (
              <div className="rounded-sm border border-dashed border-line-2 bg-paper/60 px-4 py-10 text-center text-sm leading-6 text-ink-4">
                {search.trim() ? t('history.search.empty') : t('history.empty')}
              </div>
            ) : (
              <ol className="divide-y divide-line">
                {visibleSessions.map((session) => (
                  <li key={session.id} className="py-4 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 basis-80">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline">{directionLabel(t, session.direction)}</Badge>
                          <Badge variant={session.state === 'done' ? 'solid' : 'subtle'}>{session.state in SESSION_STATE_KEYS ? t(SESSION_STATE_KEYS[session.state as keyof typeof SESSION_STATE_KEYS]) : session.state}</Badge>
                          <span className="text-xs text-ink-4">{formatDate(session.updated_at, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                        </div>
                        <p className="mt-2 line-clamp-2 text-sm leading-6 text-ink">{session.source_text}</p>
                        {session.task_brief && <p className="mt-1 line-clamp-1 text-xs text-ink-3">{t('history.requirements', { brief: session.task_brief })}</p>}
                        <p className="mt-2 text-xs leading-5 text-ink-4">
                          {t('history.calls', { count: formatNumber(session.agent_invocation_count) })}
                          {session.models.length > 0 ? ` · ${session.models.join(' / ')}` : ''}
                          {session.latest_version ? ` · ${t('history.finalVersion', { version: formatNumber(session.latest_version.version_no) })}` : ''}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Button href={`/?session=${encodeURIComponent(session.id)}`} size="sm" variant="outline">{t('history.view')}</Button>
                        <Button href={`/api/sessions/${encodeURIComponent(session.id)}/export?format=md`} size="sm" variant="ghost">{t('history.export.markdown')}</Button>
                        <Button href={`/api/sessions/${encodeURIComponent(session.id)}/export?format=json`} size="sm" variant="ghost">{t('history.export.json')}</Button>
                        <Button size="sm" variant="ghost" onClick={() => { setDeleteError(null); setDeleting(session) }}>{t('history.delete')}</Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {!loading && nextOffset < total && <div className="mt-4 border-t border-line pt-4 text-center">
              <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void load(nextOffset)}>{loadingMore && <Spinner size="sm" />}{t('history.loadMore')}</Button>
            </div>}
          </Card>
        )}
      </div>
      <Modal open={deleting != null} onClose={() => { if (!deleteBusy) setDeleting(null) }} title={t('history.delete.title')} footer={<>
        <Button variant="ghost" size="sm" disabled={deleteBusy} onClick={() => setDeleting(null)}>{t('common.cancel')}</Button>
        <Button size="sm" disabled={deleteBusy} onClick={() => void confirmDelete()}>{deleteBusy && <Spinner size="sm" />}{deleteBusy ? t('history.delete.busy') : t('history.delete')}</Button>
      </>}>
        <p className="text-sm leading-6 text-ink-2">{t('history.delete.description')}</p>
        {deleting && <p className="mt-3 line-clamp-3 rounded-sm bg-paper-sink p-3 text-sm leading-6 text-ink-3">{deleting.source_text}</p>}
        {deleteError && <p role="alert" className="mt-3 text-sm text-cinnabar">{deleteError}</p>}
      </Modal>
    </div>
  )
}
