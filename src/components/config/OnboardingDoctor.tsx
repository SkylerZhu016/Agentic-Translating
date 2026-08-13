'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge, Button, Card, Spinner } from '@/src/components/ui'
import { useDirection } from '@/src/components/direction/DirectionProvider'
import type {
  AgentDirectionVariant,
  DirectionPromptBundle,
  ModelBinding,
  ReviewMode,
  TeamPolicy,
} from '@/src/lib/contracts/vnext'
import type { Endpoint } from './api'
import { ModelPicker } from './ModelPicker'
import type { NotifyFn } from './shared'

interface CapabilityResult {
  supported: boolean
  error: string | null
}

interface EndpointCapabilityProfile {
  endpointId: number
  checkedAt: string
  expiresAt: string
  models: {
    supported: boolean
    count: number | null
    error: string | null
  }
  chat: CapabilityResult
  streaming: CapabilityResult
  usage: CapabilityResult
  tools: CapabilityResult
  reasoningContent: CapabilityResult
  firstByteMs: number | null
  testedModel: string
  diagnosticId: string
}

interface OnboardingState {
  schemaVersion: 1
  completedAt: string | null
  dismissedAt: string | null
  lastDoctorRunAt: string | null
  selectedEndpointId: number | null
  generatedPresetRevisionIds: string[]
}

interface OnboardingStatus {
  state: OnboardingState
  hasRunnableConfig: boolean
  recommendedAction: 'start' | 'check_existing' | 'none'
}

type WorkflowLevel = 'quick' | 'balanced' | 'deep'

const LEVEL_META: Record<
  WorkflowLevel,
  {
    label: string
    description: string
    archetypes: string[] | 'all'
    teamPolicy: TeamPolicy
    reviewMode: ReviewMode
    maxAgentCalls: number
  }
> = {
  quick: {
    label: '快速',
    description: '两个互补候选，适合先判断文本是否需要深度审议。',
    archetypes: ['semantic-fidelity', 'target-naturalness'],
    teamPolicy: 'fixed',
    reviewMode: 'main_editor',
    maxAgentCalls: 2,
  },
  balanced: {
    label: '均衡',
    description: '动态选择最多五个角色，兼顾质量、速度与费用。',
    archetypes: [
      'semantic-fidelity',
      'target-naturalness',
      'voice-register',
      'terminology',
      'long-context',
      'literary-prose',
      'poetry-form',
    ],
    teamPolicy: 'dynamic',
    reviewMode: 'main_editor',
    maxAgentCalls: 5,
  },
  deep: {
    label: '深度',
    description: '开放全部角色并使用经典四阶段，适合高难文本。',
    archetypes: 'all',
    teamPolicy: 'dynamic',
    reviewMode: 'four_stage',
    maxAgentCalls: 10,
  },
}

const CAPABILITY_LABELS: Array<{
  key: 'models' | 'chat' | 'streaming' | 'usage' | 'tools'
  label: string
}> = [
  { key: 'models', label: '模型列表' },
  { key: 'chat', label: '普通响应' },
  { key: 'streaming', label: '流式响应' },
  { key: 'usage', label: 'Token 用量' },
  { key: 'tools', label: '工具调用' },
]

function endpointLocation(endpoint: Endpoint | undefined): string {
  if (!endpoint) return '未知'
  try {
    const host = new URL(endpoint.base_url).hostname.toLowerCase()
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      return '本机端点'
    }
    return `远程端点 · ${host}`
  } catch {
    return '地址待核验'
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as
    | (T & { error?: string })
    | null
  if (!response.ok) {
    throw new Error(body?.error ?? `请求失败（HTTP ${response.status}）`)
  }
  return body as T
}

export function OnboardingDoctor({
  endpoints,
  notify,
}: {
  endpoints: Endpoint[]
  notify: NotifyFn
}) {
  const { direction } = useDirection()
  const [status, setStatus] = useState<OnboardingStatus | null>(null)
  const [endpointId, setEndpointId] = useState<number | null>(null)
  const [model, setModel] = useState('')
  const [profile, setProfile] = useState<EndpointCapabilityProfile | null>(null)
  const [level, setLevel] = useState<WorkflowLevel>('balanced')
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)
  const [creating, setCreating] = useState(false)
  const [expanded, setExpanded] = useState(true)

  const selectedEndpoint = endpoints.find((item) => item.id === endpointId)

  const loadStatus = useCallback(async () => {
    setLoading(true)
    try {
      const next = await readJson<OnboardingStatus>(
        await fetch('/api/onboarding/status', { cache: 'no-store' }),
      )
      setStatus(next)
      setEndpointId((current) =>
        current ??
        next.state.selectedEndpointId ??
        endpoints[0]?.id ??
        null,
      )
      if (next.recommendedAction === 'none') setExpanded(false)
    } catch (error) {
      notify('兼容性医生暂不可用', {
        message: error instanceof Error ? error.message : '请稍后重试',
      })
    } finally {
      setLoading(false)
    }
  }, [endpoints, notify])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  useEffect(() => {
    setModel('')
    setProfile(null)
    if (!endpointId) return
    void fetch(`/api/endpoints/${endpointId}/capabilities`, {
      cache: 'no-store',
    }).then(async (response) => {
      if (!response.ok) return
      const existing = await response.json() as EndpointCapabilityProfile
      setProfile(existing)
      if (existing.testedModel) setModel(existing.testedModel)
    })
  }, [endpointId])

  // A provider that only returns JSON can still run through the existing
  // transport fallback.  Streaming is therefore an experience signal, not a
  // hard gate that would incorrectly reject an otherwise usable endpoint.
  const capabilityReady = Boolean(profile?.chat.supported)
  const modeWarning = useMemo(() => {
    if (!profile) return null
    const warnings: string[] = []
    if (!profile.streaming.supported) {
      warnings.push(
        '该端点可以完成普通请求，但没有通过真实流式响应测试。运行时仍可使用，首屏反馈和长任务进度可能较慢。',
      )
    }
    if (!profile.tools.supported) {
      warnings.push(
        '该端点未通过工具调用测试。经典四阶段仍可使用；主 Agent 证据化编辑可能不可用。',
      )
    }
    if (!profile.usage.supported) {
      warnings.push(
        '该端点没有返回标准 usage；只有具备可靠估算依据时才会显示本地估算，否则 token 与费用会保持未知。',
      )
    }
    return warnings.length > 0 ? warnings.join(' ') : null
  }, [profile])

  async function runDoctor() {
    if (!endpointId) return
    setChecking(true)
    setProfile(null)
    try {
      const checked = await readJson<EndpointCapabilityProfile>(
        await fetch(`/api/endpoints/${endpointId}/capability-check`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(model.trim() ? { model: model.trim() } : {}),
        }),
      )
      setProfile(checked)
      if (!model && checked.testedModel) setModel(checked.testedModel)
      const nextStatus = await readJson<OnboardingStatus>(
        await fetch('/api/onboarding/status', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lastDoctorRunAt: checked.checkedAt,
            selectedEndpointId: endpointId,
          }),
        }),
      )
      setStatus(nextStatus)
      notify('兼容性检查已完成', { tone: 'inverted' })
    } catch (error) {
      notify('兼容性检查失败', {
        message: error instanceof Error ? error.message : '请重试',
      })
    } finally {
      setChecking(false)
    }
  }

  async function generateWorkflow() {
    if (!endpointId || !model.trim() || !capabilityReady) return
    setCreating(true)
    try {
      const [catalogue, bundle] = await Promise.all([
        readJson<{ variants: AgentDirectionVariant[] }>(
          await fetch(`/api/agent-catalog?direction=${direction}`),
        ),
        readJson<DirectionPromptBundle>(
          await fetch(`/api/direction-prompt-bundles?direction=${direction}`),
        ),
      ])
      const meta = LEVEL_META[level]
      const variants = catalogue.variants.filter(
        (variant) =>
          variant.enabled &&
          (meta.archetypes === 'all' ||
            meta.archetypes.includes(variant.archetypeId)),
      )
      if (variants.length < 2) {
        throw new Error('当前方向没有足够的可用 Agent，至少需要两个不同角色。')
      }
      const binding: ModelBinding = {
        endpointId,
        model: model.trim(),
        contextWindow: selectedEndpoint?.context_window ?? null,
      }
      const effectiveReviewMode: ReviewMode =
        meta.reviewMode === 'main_editor' && !profile?.tools.supported
          ? 'four_stage'
          : meta.reviewMode
      const contract = {
        sourceLang: direction === 'en_to_zh' ? '英文' : '中文',
        targetLang: direction === 'en_to_zh' ? '中文' : '英文',
        taskBriefTemplate: '',
        teamPolicy: meta.teamPolicy,
        reviewMode: effectiveReviewMode,
        candidateAnnotationMode: 'body_only' as const,
        agentVariantIds: variants.map((variant) => variant.id),
        agentVariantSnapshots: variants,
        defaultWorkerBinding: binding,
        agentBindingOverrides: {},
        mainAgentBinding: binding,
        reviewAgentBinding: binding,
        filterAgentBinding: binding,
        orchestrateAgentBinding: binding,
        assembleAgentBinding: binding,
        editingAgentBinding: binding,
        contextAnalysisBindings: [binding],
        promptBundleVersion: bundle.version,
        maxAgentCalls: meta.maxAgentCalls,
        batchConcurrency: 2,
        constraints: {},
      }
      const presetResponse = await readJson<{
        revision: { id: string }
      }>(
        await fetch('/api/workflow-presets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: `我的${meta.label}工作流`,
            description: `由兼容性医生根据 ${selectedEndpoint?.name ?? '当前端点'} 生成，可继续编辑和创建 revision。`,
            direction,
            contract,
          }),
        }),
      )
      await readJson(
        await fetch(`/api/model-profiles/${direction}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            defaultWorker: binding,
            mainAgent: binding,
            reviewAgent: binding,
            filterAgent: binding,
            orchestrateAgent: binding,
            assembleAgent: binding,
            editingAgent: binding,
          }),
        }),
      )
      const completedAt = new Date().toISOString()
      const generatedPresetRevisionIds = Array.from(
        new Set([
          ...(status?.state.generatedPresetRevisionIds ?? []),
          presetResponse.revision.id,
        ]),
      )
      const next = await readJson<OnboardingStatus>(
        await fetch('/api/onboarding/status', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            completedAt,
            dismissedAt: null,
            selectedEndpointId: endpointId,
            generatedPresetRevisionIds,
          }),
        }),
      )
      setStatus(next)
      setExpanded(false)
      notify(`${meta.label}工作流已创建`, {
        tone: 'inverted',
        message: '它属于你的普通预设，可随时修改、复制或创建新 revision。',
      })
    } catch (error) {
      notify('创建工作流失败', {
        message: error instanceof Error ? error.message : '请重试',
      })
    } finally {
      setCreating(false)
    }
  }

  async function dismiss() {
    try {
      const next = await readJson<OnboardingStatus>(
        await fetch('/api/onboarding/status', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dismissedAt: new Date().toISOString() }),
        }),
      )
      setStatus(next)
      setExpanded(false)
    } catch (error) {
      notify('暂时无法保存设置', {
        message: error instanceof Error ? error.message : '请重试',
      })
    }
  }

  return (
    <Card
      id="compatibility-doctor"
      overline="First Run"
      title="首次运行与兼容性医生"
      actions={
        status?.state.completedAt || status?.state.dismissedAt ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? '收起' : '重新检查'}
          </Button>
        ) : undefined
      }
    >
      {loading ? (
        <div className="flex min-h-24 items-center justify-center text-ink-3">
          <Spinner />
        </div>
      ) : !expanded ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-ink">
              {status?.state.completedAt ? '首次工作流已经就绪' : '已跳过首次引导'}
            </p>
            <p className="mt-1 text-xs leading-5 text-ink-3">
              {profile
                ? `${profile.testedModel || '当前模型'} · ${endpointLocation(selectedEndpoint)}`
                : '可以随时重新检查端点能力。'}
            </p>
          </div>
          <Badge variant="outline">
            {status?.hasRunnableConfig ? '配置可运行' : '仍需配置'}
          </Badge>
        </div>
      ) : (
        <div className="space-y-5">
          <section>
            <div className="mb-2 flex items-center gap-2">
              <Badge variant="solid">1</Badge>
              <p className="text-sm font-medium text-ink">选择模型端点</p>
            </div>
            {endpoints.length === 0 ? (
              <div className="rounded-sm border border-dashed border-line-2 bg-paper/60 px-4 py-4">
                <p className="text-sm leading-6 text-ink-3">
                  先在下方添加一个本地、云端或 OpenAI 兼容端点。保存后回到这里继续检查。
                </p>
                <Button
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    document
                      .getElementById('endpoint-management')
                      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }
                >
                  前往添加端点
                </Button>
              </div>
            ) : (
              <div className="grid gap-2 sm:grid-cols-[minmax(10rem,0.8fr)_minmax(16rem,1.2fr)]">
                <select
                  value={endpointId ?? ''}
                  aria-label="兼容性检查端点"
                  onChange={(event) =>
                    setEndpointId(Number(event.target.value) || null)
                  }
                  className="h-9 rounded-sm border border-line-2 bg-paper-raise px-2 text-sm text-ink"
                >
                  <option value="">选择端点</option>
                  {endpoints.map((endpoint) => (
                    <option key={endpoint.id} value={endpoint.id}>
                      {endpoint.name}
                    </option>
                  ))}
                </select>
                <ModelPicker
                  endpointId={endpointId}
                  value={model}
                  onChange={(nextModel) => {
                    setModel(nextModel)
                    if (nextModel !== profile?.testedModel) setProfile(null)
                  }}
                  emptyLabel="选择用于兼容性检查的模型"
                  ariaLabel="兼容性检查模型"
                />
              </div>
            )}
            {selectedEndpoint && (
              <p className="mt-2 text-xs leading-5 text-ink-4">
                {endpointLocation(selectedEndpoint)}。配置与历史保存在本机；运行远程模型时，任务内容会发送至该端点。
              </p>
            )}
          </section>

          <section className="border-t border-line pt-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Badge variant="solid">2</Badge>
                <p className="text-sm font-medium text-ink">分项检查兼容能力</p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={checking || !endpointId}
                onClick={() => void runDoctor()}
              >
                {checking && <Spinner size="sm" />}
                {profile ? '重新检查' : '开始检查'}
              </Button>
            </div>
            {profile ? (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  {CAPABILITY_LABELS.map(({ key, label }) => {
                    const result = profile[key]
                    return (
                      <div
                        key={key}
                        className="rounded-sm border border-line bg-paper/55 px-2 py-2 text-center"
                        title={result.error ?? undefined}
                      >
                        <p className="text-xs text-ink-3">{label}</p>
                        <p
                          className={`mt-1 text-xs font-medium ${
                            result.supported ? 'text-pine' : 'text-cinnabar'
                          }`}
                        >
                          {result.supported ? '可用' : '未通过'}
                        </p>
                      </div>
                    )
                  })}
                </div>
                <p className="text-xs leading-5 text-ink-4">
                  测试模型：{profile.testedModel || '未能自动选择'}
                  {profile.firstByteMs != null
                    ? ` · 首包约 ${profile.firstByteMs} ms`
                    : ''}
                  {' · '}诊断 ID：{profile.diagnosticId}
                </p>
                {modeWarning && (
                  <p className="rounded-sm border border-amber/35 bg-amber/5 px-3 py-2 text-xs leading-5 text-ink-2">
                    {modeWarning}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-xs leading-5 text-ink-4">
                检查会使用很小的输出预算，分别验证各项能力；某一项失败不会抹掉其他结果。
              </p>
            )}
          </section>

          <section className="border-t border-line pt-4">
            <div className="mb-2 flex items-center gap-2">
              <Badge variant="solid">3</Badge>
              <p className="text-sm font-medium text-ink">创建你的第一份工作流</p>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {(Object.keys(LEVEL_META) as WorkflowLevel[]).map((item) => {
                const meta = LEVEL_META[item]
                const selected = level === item
                return (
                  <button
                    key={item}
                    type="button"
                    disabled={!capabilityReady}
                    onClick={() => setLevel(item)}
                    className={[
                      'rounded-sm border px-3 py-3 text-left transition-colors',
                      selected
                        ? 'border-ink bg-paper-sink'
                        : 'border-line bg-paper/55 hover:border-line-2',
                      !capabilityReady ? 'cursor-not-allowed opacity-55' : '',
                    ].join(' ')}
                  >
                    <span className="block text-sm font-medium text-ink">
                      {meta.label}
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-ink-3">
                      {meta.description}
                    </span>
                  </button>
                )
              })}
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs leading-5 text-ink-4">
                生成后属于你的普通预设；可以继续修改、复制、软删除和创建 revision。
              </p>
              <div className="flex gap-2">
                {!status?.state.completedAt && !status?.state.dismissedAt && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={creating || checking}
                    onClick={() => void dismiss()}
                  >
                    暂时跳过
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={
                    creating ||
                    !capabilityReady ||
                    !endpointId ||
                    !model.trim()
                  }
                  onClick={() => void generateWorkflow()}
                >
                  {creating && <Spinner size="sm" />}
                  创建{LEVEL_META[level].label}工作流
                </Button>
              </div>
            </div>
          </section>
        </div>
      )}
    </Card>
  )
}
