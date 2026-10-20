'use client'

import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Button, Card, Spinner } from '@/src/components/ui'
import { PageHeader } from '@/src/components/shell/PageHeader'
import {
  CoordinatorPanel,
  SessionWorkspaceProvider,
  useSessionFull,
} from '@/src/components/coordinator'
import { EditorSection } from '@/src/components/editor/EditorSection'
import { TranslatePanel } from './translate-panel'
import { useI18n } from '@/src/i18n/LocaleProvider'

type WorkspaceTab = 'source' | 'workflow' | 'editor'

const WORKSPACE_TABS = [
  { id: 'source', label: 'workbench.tabs.source' },
  { id: 'workflow', label: 'workbench.tabs.workflow' },
  { id: 'editor', label: 'workbench.tabs.editor' },
] as const

function WorkspaceContent() {
  const { t } = useI18n()
  const searchParams = useSearchParams()
  const routeSessionId = searchParams.get('session')
  const { data } = useSessionFull()
  const [translateReady, setTranslateReady] = useState(false)
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('source')
  const selectionMade = useRef(false)
  const initializedSession = useRef<string | null>(null)
  const tabButtons = useRef<Array<HTMLButtonElement | null>>([])
  const latestRun = data?.runs?.[data.runs.length - 1]
  const running = latestRun?.status === 'queued' || latestRun?.status === 'running' ||
    data?.session.state === 'translating' || data?.session.state === 'coordinating'
  const complete = Boolean(data?.finalVersion)
  const needsAttention = !running &&
    (latestRun?.status === 'failed' || latestRun?.status === 'interrupted')
  const status = running
    ? 'workbench.status.running'
    : needsAttention
      ? 'workbench.status.attention'
      : complete
        ? 'workbench.status.complete'
        : translateReady
          ? 'workbench.status.review'
          : 'workbench.status.ready'

  useEffect(() => {
    initializedSession.current = null
    selectionMade.current = false
    setActiveTab('source')
  }, [routeSessionId])

  // Restored translations open at their result. Live completion keeps the
  // current reading position and keyboard focus under the user's control.
  useEffect(() => {
    if (!data || data.session.id !== routeSessionId ||
      initializedSession.current === routeSessionId) return
    initializedSession.current = routeSessionId
    if (!selectionMade.current && data.finalVersion) setActiveTab('editor')
  }, [data, routeSessionId])

  const selectTab = (tab: WorkspaceTab) => {
    selectionMade.current = true
    setActiveTab(tab)
  }

  return (
    <div className="workspace-shell mx-auto max-w-[1440px] px-4 py-5 sm:px-6">
      <PageHeader
        overline={t('workbench.overline')}
        title={t('workbench.title')}
        description={t('workbench.description')}
      />

      <div className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          aria-label={t('workbench.tabs.label')}
          className="workspace-step-tabs flex min-w-0 max-w-full flex-wrap gap-1 rounded-lg border border-line bg-paper-raise p-1"
        >
          {WORKSPACE_TABS.map((tab, index) => {
            const selected = activeTab === tab.id
            const done = tab.id === 'source' ? translateReady : complete
            return (
              <button
                key={tab.id}
                ref={(element) => { tabButtons.current[index] = element }}
                id={`workspace-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`workspace-panel-${tab.id}`}
                tabIndex={selected ? 0 : -1}
                data-testid={`workspace-tab-${tab.id}`}
                onClick={() => selectTab(tab.id)}
                onKeyDown={(event) => {
                  const next = event.key === 'ArrowRight' ? (index + 1) % WORKSPACE_TABS.length
                    : event.key === 'ArrowLeft' ? (index + WORKSPACE_TABS.length - 1) % WORKSPACE_TABS.length
                      : event.key === 'Home' ? 0
                        : event.key === 'End' ? WORKSPACE_TABS.length - 1 : null
                  if (next == null) return
                  event.preventDefault()
                  selectTab(WORKSPACE_TABS[next].id)
                  tabButtons.current[next]?.focus()
                }}
                className={[
                  'workspace-step-tab inline-flex min-h-10 items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors sm:px-4',
                  selected ? 'bg-pine text-paper-raise shadow-sm' : 'text-ink-3 hover:bg-paper-sink hover:text-ink',
                ].join(' ')}
              >
                <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[0.6875rem] ${selected ? 'bg-white/15' : done ? 'bg-pine/10 text-pine' : 'bg-paper-sink text-ink-4'}`}>
                  {done ? '✓' : index + 1}
                </span>
                {t(tab.label)}
              </button>
            )
          })}
        </div>
        <div className="flex items-center gap-3">
          <span role="status" className={`inline-flex items-center gap-2 text-xs ${needsAttention ? 'text-cinnabar' : complete ? 'text-pine' : 'text-ink-3'}`}>
            {running ? <Spinner size="sm" /> : <span className={`h-1.5 w-1.5 rounded-full ${complete ? 'bg-pine' : needsAttention ? 'bg-cinnabar' : 'bg-ink-4/50'}`} aria-hidden />}
            {t(status)}
          </span>
          {complete && activeTab !== 'editor' && (
            <Button size="sm" variant="outline" onClick={() => selectTab('editor')}>
              {t('workbench.openEditor')} <span aria-hidden>→</span>
            </Button>
          )}
        </div>
      </div>

      {/* Keep views mounted to preserve drafts and streams. Hidden panels are
          also removed from keyboard navigation and the accessibility tree. */}
      <div role="tabpanel" id="workspace-panel-source" aria-labelledby="workspace-tab-source" hidden={activeTab !== 'source'}>
        <TranslatePanel onAllCompleteChange={setTranslateReady} />
      </div>
      <div role="tabpanel" id="workspace-panel-workflow" aria-labelledby="workspace-tab-workflow" hidden={activeTab !== 'workflow'}>
        <Card
          overline={t('workbench.coordination.overline')}
          title={t('workbench.coordination.title')}
          className="max-w-5xl"
        >
          <CoordinatorPanel />
        </Card>
      </div>
      <div role="tabpanel" id="workspace-panel-editor" aria-labelledby="workspace-tab-editor" hidden={activeTab !== 'editor'}>
        <EditorSection />
      </div>
    </div>
  )
}

export function Workbench() {
  return (
    <SessionWorkspaceProvider>
      <WorkspaceContent />
    </SessionWorkspaceProvider>
  )
}
