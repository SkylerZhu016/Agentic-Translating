'use client'

// ---------------------------------------------------------------------------
// 配置页编排器 —— 并行加载四组配置，分发刷新回调与 toast
// 加载期渲染骨架屏；失败可重试
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from 'react'
import { Button, Card } from '@/src/components/ui'
import { PageHeader } from '@/src/components/shell/PageHeader'
import {
  configApi,
  isApiError,
  type Agent,
  type CoordinatorConfig,
  type Endpoint,
  type PromptTemplate,
} from './api'
import { AgentPanel } from './AgentPanel'
import { CoordinatorPanel } from './CoordinatorPanel'
import { EndpointPanel } from './EndpointPanel'
import { PromptPanel } from './PromptPanel'
import { Skeleton, ToastStack, useToasts } from './shared'
import { DirectionSettingsCard } from './DirectionSettingsCard'
import { AgentLibraryPanel } from './AgentLibraryPanel'
import { WorkflowPresetPanel } from './WorkflowPresetPanel'

export function ConfigPanels() {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [endpoints, setEndpoints] = useState<Endpoint[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [coordinator, setCoordinator] = useState<CoordinatorConfig | null>(null)
  const [prompts, setPrompts] = useState<PromptTemplate[]>([])
  const { toasts, push, dismiss } = useToasts()

  const loadAll = useCallback(async () => {
    setLoadError(null)
    try {
      const [ep, ag, co, pr] = await Promise.all([
        configApi.listEndpoints(),
        configApi.listAgents(),
        configApi.getCoordinator(),
        configApi.listPrompts(),
      ])
      setEndpoints(ep)
      setAgents(ag)
      setCoordinator(co)
      setPrompts(pr)
    } catch (e) {
      setLoadError(isApiError(e) ? e.message : '网络错误，无法加载配置')
    } finally {
      setLoading(false)
    }
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

  const refreshAgents = useCallback(async () => {
    setAgents(await configApi.listAgents())
  }, [])

  const refreshPrompts = useCallback(async () => {
    setPrompts(await configApi.listPrompts())
  }, [])

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <PageHeader
        overline="Settings"
        title="配置"
        description="管理 OpenAI 兼容端点、翻译 Agent 阵容与统筹模型。配置保存在本机，不上传。"
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
      ) : loadError != null ? (
        <div className="mx-auto grid max-w-3xl grid-cols-1 gap-5">
          <Card title="加载失败">
            <p className="text-sm leading-6 text-ink-2">{loadError}</p>
            <Button size="sm" className="mt-3" onClick={() => void loadAll()}>
              重试
            </Button>
          </Card>
        </div>
      ) : (
        <div className="mx-auto grid max-w-3xl grid-cols-1 gap-5">
          <DirectionSettingsCard notify={push} />
          <AgentLibraryPanel notify={push} />
          <WorkflowPresetPanel endpoints={endpoints} notify={push} />
          <EndpointPanel
            endpoints={endpoints}
            agents={agents}
            notify={push}
            onChanged={refreshEndpoints}
          />
          <AgentPanel
            agents={agents}
            endpoints={endpoints}
            notify={push}
            onChanged={refreshAgents}
          />
          <CoordinatorPanel coordinator={coordinator} endpoints={endpoints} notify={push} />
          <PromptPanel prompts={prompts} notify={push} onChanged={refreshPrompts} />
        </div>
      )}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}
