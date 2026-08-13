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

export function ConfigPanels() {
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
    else setEndpointError('端点列表加载失败；其他配置区域仍可使用。')
    if (agentResult.status === 'fulfilled') setAgents(agentResult.value)
    setLoading(false)
  }, [])

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
        overline="Settings"
        title="配置"
        description="管理模型端点、Agent 阵容与工作流。配置和历史保存在本机；使用远程模型时，任务内容会发送至所选端点。"
      />

      {loading ? (
        <div className="mx-auto grid max-w-3xl grid-cols-1 gap-5" aria-label="加载中">
          {(['端点', '翻译 Agent', '统筹', '提示词'] as const).map((t) => (
            <Card key={t} title={t}>
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
            <Card title="端点区域暂不可用">
              <p className="text-sm leading-6 text-ink-2">{endpointError}</p>
              <Button size="sm" className="mt-3" onClick={() => void loadAll()}>
                重试端点加载
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
