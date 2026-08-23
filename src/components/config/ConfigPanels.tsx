'use client'

// ---------------------------------------------------------------------------
// 配置页编排器 —— 并行加载四组配置，分发刷新回调与 toast
// 加载期渲染骨架屏；失败可重试
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from 'react'
import { Button, Card } from '@/src/components/ui'
import { PageHeader } from '@/src/components/shell/PageHeader'
import { configApi, type Agent, type Endpoint } from './api'
import { EndpointPanel } from './EndpointPanel'
import { Skeleton, ToastStack, useToasts } from './shared'
import { DirectionSettingsCard } from './DirectionSettingsCard'
import { AgentLibraryPanel } from './AgentLibraryPanel'
import { WorkflowPresetPanel } from './WorkflowPresetPanel'
import { PromptBundlePanel } from './PromptBundlePanel'
import { OnboardingDoctor } from './OnboardingDoctor'
import { ProjectMemoryPanel } from './ProjectMemoryPanel'
import { useI18n } from '@/src/i18n'

export function ConfigPanels() {
  const { t } = useI18n()
  const [loading, setLoading] = useState(true)
  const [endpointError, setEndpointError] = useState<string | null>(null)
  const [endpoints, setEndpoints] = useState<Endpoint[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const { toasts, push, dismiss } = useToasts()

  const loadAll = useCallback(async () => {
    setEndpointError(null)
    const [epResult, agentResult] = await Promise.allSettled([
        configApi.listEndpoints(),
        configApi.listAgents(),
    ])
    if (epResult.status === 'fulfilled') setEndpoints(epResult.value)
    else setEndpointError(t('config.endpointRegion.loadError'))
    if (agentResult.status === 'fulfilled') setAgents(agentResult.value)
    setLoading(false)
  }, [t])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  /** 端点增删改后：端点列表 + Agent 列表一并刷新（Agent 引用端点） */
  const refreshEndpoints = useCallback(async () => {
    const [ep, ag] = await Promise.all([configApi.listEndpoints(), configApi.listAgents()])
    setEndpoints(ep)
    setAgents(ag)
  }, [])

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <PageHeader
        overline={t('config.overline')}
        title={t('config.title')}
        description={t('config.description')}
      />

      {loading ? (
        <div className="mx-auto grid max-w-3xl grid-cols-1 gap-5" aria-label={t('config.loading')}>
          {([
            t('config.section.endpoints'),
            t('config.section.agents'),
            t('config.section.coordinator'),
            t('config.section.prompts'),
          ] as const).map((title) => (
            <Card key={title} title={title}>
              <div className="space-y-3">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-2/3" />
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <div className="mx-auto grid max-w-3xl grid-cols-1 gap-5">
          <OnboardingDoctor endpoints={endpoints} notify={push} />
          <DirectionSettingsCard notify={push} />
          <ProjectMemoryPanel notify={push} />
          <AgentLibraryPanel notify={push} />
          <WorkflowPresetPanel endpoints={endpoints} notify={push} />
          {endpointError && (
            <Card title={t('config.endpointRegion.unavailable')}>
              <p className="text-sm leading-6 text-ink-2">{endpointError}</p>
              <Button size="sm" className="mt-3" onClick={() => void loadAll()}>
                {t('config.endpointRegion.retry')}
              </Button>
            </Card>
          )}
          <div id="endpoint-management" className="scroll-mt-5">
            <EndpointPanel
              endpoints={endpoints}
              agents={agents}
              notify={push}
              onChanged={refreshEndpoints}
            />
          </div>
          <PromptBundlePanel notify={push} />
        </div>
      )}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}
