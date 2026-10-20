'use client'

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Card, Spinner } from '@/src/components/ui'
import { PageHeader } from '@/src/components/shell/PageHeader'
import { configApi, type Agent, type Endpoint } from './api'
import { ToastStack, useToasts } from './shared'
import { useI18n, type MessageKey } from '@/src/i18n'

function PanelLoading() {
  return <div className="flex min-h-32 items-center justify-center"><Spinner /></div>
}

// Large editors and their data are loaded only when their section is opened.
const EndpointPanel = dynamic(() => import('./EndpointPanel').then((module) => module.EndpointPanel), { loading: PanelLoading })
const DirectionSettingsCard = dynamic(() => import('./DirectionSettingsCard').then((module) => module.DirectionSettingsCard), { loading: PanelLoading })
const AgentLibraryPanel = dynamic(() => import('./AgentLibraryPanel').then((module) => module.AgentLibraryPanel), { loading: PanelLoading })
const WorkflowPresetPanel = dynamic(() => import('./WorkflowPresetPanel').then((module) => module.WorkflowPresetPanel), { loading: PanelLoading })
const PromptBundlePanel = dynamic(() => import('./PromptBundlePanel').then((module) => module.PromptBundlePanel), { loading: PanelLoading })
const OnboardingDoctor = dynamic(() => import('./OnboardingDoctor').then((module) => module.OnboardingDoctor), { loading: PanelLoading })
const ProjectMemoryPanel = dynamic(() => import('./ProjectMemoryPanel').then((module) => module.ProjectMemoryPanel), { loading: PanelLoading })
const AppearancePanel = dynamic(() => import('./AppearancePanel').then((module) => module.AppearancePanel), { loading: PanelLoading })

const SECTIONS = [
  ['setup', 'config.nav.setup', 'compatibility-doctor'],
  ['models', 'config.nav.models', 'endpoint-management'],
  ['workflows', 'config.nav.workflows', 'workflow-presets'],
  ['projects', 'config.nav.projects', 'project-memory'],
  ['agents', 'config.nav.agents', 'agent-library'],
  ['prompts', 'config.nav.prompts', 'prompt-bundles'],
  ['preferences', 'config.nav.preferences', 'preferences'],
  ['appearance', 'config.nav.appearance', 'appearance'],
] as const satisfies ReadonlyArray<readonly [string, MessageKey, string]>

type Section = (typeof SECTIONS)[number][0]

export function ConfigPanels() {
  const { t } = useI18n()
  const [section, setSection] = useState<Section>('setup')
  const [visited, setVisited] = useState<Section[]>([])
  const [loading, setLoading] = useState(true)
  const [endpointsLoaded, setEndpointsLoaded] = useState(false)
  const [agentsLoaded, setAgentsLoaded] = useState(false)
  const [endpointError, setEndpointError] = useState<string | null>(null)
  const [endpoints, setEndpoints] = useState<Endpoint[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const loadController = useRef<AbortController | null>(null)
  const { toasts, push, dismiss } = useToasts()
  const needsEndpoints = section === 'setup' || section === 'models' || section === 'workflows'

  const openSection = useCallback((next: Section) => {
    setSection(next)
    setVisited((current) => current.includes(next) ? current : [...current, next])
    const anchor = SECTIONS.find(([value]) => value === next)?.[2]
    window.history.replaceState(null, '', `#${anchor}`)
  }, [])

  useEffect(() => {
    const syncHash = () => {
      const match = SECTIONS.find(([, , anchor]) => `#${anchor}` === window.location.hash)
      const next = match?.[0] ?? 'setup'
      setSection(next)
      setVisited((current) => current.includes(next) ? current : [...current, next])
    }
    syncHash()
    window.addEventListener('hashchange', syncHash)
    return () => window.removeEventListener('hashchange', syncHash)
  }, [])

  const loadConnections = useCallback(async () => {
    loadController.current?.abort()
    const controller = new AbortController()
    loadController.current = controller
    setLoading(true)
    setEndpointError(null)
    try {
      const [ep, ag] = await Promise.all([
        configApi.listEndpoints(controller.signal),
        section === 'models' ? configApi.listAgents(controller.signal) : Promise.resolve([]),
      ])
      if (controller.signal.aborted) return
      setEndpoints(ep)
      setEndpointsLoaded(true)
      if (section === 'models') {
        setAgents(ag)
        setAgentsLoaded(true)
      }
    } catch {
      if (!controller.signal.aborted) setEndpointError(t('config.endpointRegion.loadError'))
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [section, t])

  useEffect(() => {
    if (needsEndpoints && (!endpointsLoaded || (section === 'models' && !agentsLoaded))) void loadConnections()
  }, [loadConnections, needsEndpoints, endpointsLoaded, agentsLoaded, section])

  // A saved endpoint must finish refreshing even when the user opens another section.
  useEffect(() => () => loadController.current?.abort(), [])

  return (
    <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
      <PageHeader overline={t('config.overline')} title={t('config.title')} description={t('config.description')} />
      <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[12.5rem_minmax(0,1fr)]">
        <aside className="min-w-0 lg:sticky lg:top-5">
          <nav aria-label={t('config.navigation')} className="flex flex-wrap gap-1 rounded-md border border-line bg-paper-raise p-2 lg:flex-col">
            {SECTIONS.map(([value, label]) => (
              <button key={value} type="button" aria-current={section === value ? 'page' : undefined} onClick={() => openSection(value)} className={[
                'flex items-center justify-between rounded-sm px-3 py-2.5 text-left text-sm font-medium transition-colors',
                section === value ? 'bg-ink text-paper' : 'text-ink-3 hover:bg-paper-sink hover:text-ink',
              ].join(' ')}>
                {t(label)}
                {section === value && <span aria-hidden className="ml-3 hidden lg:inline">→</span>}
              </button>
            ))}
          </nav>
          <p className="mt-3 hidden px-3 text-xs leading-5 text-ink-4 lg:block">{t('config.nav.hint')}</p>
        </aside>
        <div className="min-w-0 space-y-4" aria-busy={needsEndpoints && loading}>
          {needsEndpoints && loading && (!endpointsLoaded || (section === 'models' && !agentsLoaded)) && <PanelLoading />}
          {needsEndpoints && endpointError && (
            <Card title={t('config.endpointRegion.unavailable')}>
              <p role="alert" className="text-sm leading-6 text-cinnabar">{endpointError}</p>
              <Button size="sm" variant="outline" className="mt-3" onClick={() => void loadConnections()}>{t('config.endpointRegion.retry')}</Button>
            </Card>
          )}
          {visited.includes('setup') && endpointsLoaded && <div hidden={section !== 'setup'}><OnboardingDoctor endpoints={endpoints} notify={push} onManageEndpoints={() => openSection('models')} /></div>}
          {visited.includes('models') && endpointsLoaded && agentsLoaded && <div hidden={section !== 'models'} id="endpoint-management"><EndpointPanel endpoints={endpoints} agents={agents} notify={push} onChanged={loadConnections} /></div>}
          {visited.includes('workflows') && endpointsLoaded && <div hidden={section !== 'workflows'}><WorkflowPresetPanel endpoints={endpoints} notify={push} /></div>}
          {visited.includes('projects') && <div hidden={section !== 'projects'}><ProjectMemoryPanel notify={push} /></div>}
          {visited.includes('agents') && <div hidden={section !== 'agents'}><AgentLibraryPanel notify={push} /></div>}
          {visited.includes('prompts') && <div hidden={section !== 'prompts'}><PromptBundlePanel notify={push} /></div>}
          {visited.includes('preferences') && <div hidden={section !== 'preferences'}><DirectionSettingsCard notify={push} /></div>}
          {visited.includes('appearance') && <div hidden={section !== 'appearance'}><AppearancePanel /></div>}
        </div>
      </div>
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}
