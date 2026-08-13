'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge, Button, Card, Input, Modal, Spinner, Textarea } from '@/src/components/ui'
import { useDirection } from '@/src/components/direction/DirectionProvider'
import type {
  AgentArchetype,
  AgentCategory,
  AgentDirectionVariant,
  BuiltinDirection,
} from '@/src/lib/contracts/vnext'
import type { ModelBinding } from '@/src/lib/contracts/vnext'
import type { NotifyFn } from './shared'
import { ModelPicker } from './ModelPicker'

interface EndpointSummary {
  id: number
  name: string
  base_url: string
  context_window?: number | null
}

interface IndependentTestResult {
  raw?: string
  body: string
  annotation: string | null
}

function IndependentTestOutput({ result }: { result: IndependentTestResult }) {
  return (
    <div className="mt-3 space-y-2 rounded-sm border border-line bg-paper px-3 py-3">
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-ink-4">
          正文
        </p>
        <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap text-xs leading-5 text-ink-2">
          {result.body}
        </pre>
      </div>
      {result.annotation && (
        <details className="border-t border-line pt-2">
          <summary className="cursor-pointer text-xs text-ink-3">
            查看注释（不会传给下游）
          </summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs leading-5 text-ink-2">
            {result.annotation}
          </pre>
        </details>
      )}
    </div>
  )
}

function VariantEditor({
  variant,
  builtin,
  endpoints,
  defaultBinding,
  notify,
  onChanged,
}: {
  variant: AgentDirectionVariant
  builtin: boolean
  endpoints: EndpointSummary[]
  defaultBinding: ModelBinding
  notify: NotifyFn
  onChanged: () => Promise<void>
}) {
  const [name, setName] = useState(variant.catalogName)
  const [description, setDescription] = useState(variant.catalogDescription)
  const [prompt, setPrompt] = useState(variant.rolePrompt)
  const [enabled, setEnabled] = useState(variant.enabled)
  const [endpointId, setEndpointId] = useState(
    variant.endpointOverrideId?.toString() ?? '',
  )
  const [model, setModel] = useState(variant.modelOverride ?? '')
  const [source, setSource] = useState('')
  const [taskBrief, setTaskBrief] = useState('')
  const [additionalInstruction, setAdditionalInstruction] = useState('')
  const [result, setResult] = useState<IndependentTestResult | null>(null)
  const [testError, setTestError] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    setName(variant.catalogName)
    setDescription(variant.catalogDescription)
    setPrompt(variant.rolePrompt)
    setEnabled(variant.enabled)
    setEndpointId(variant.endpointOverrideId?.toString() ?? '')
    setModel(variant.modelOverride ?? '')
  }, [variant])

  async function save() {
    setSaving(true)
    try {
      const response = await fetch(
        `/api/agent-catalog/${encodeURIComponent(variant.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(builtin
              ? {}
              : {
                  catalogName: name.trim(),
                  catalogDescription: description.trim(),
                  rolePrompt: prompt.trim(),
                }),
            enabled,
            endpointOverrideId: endpointId ? Number(endpointId) : null,
            modelOverride: model.trim() || null,
          }),
        },
      )
      if (!response.ok) throw new Error('Agent 配置保存失败')
      notify('Agent 配置已保存', { tone: 'inverted' })
      await onChanged()
    } catch (error) {
      notify('保存失败', {
        message: error instanceof Error ? error.message : '请重试',
      })
    } finally {
      setSaving(false)
    }
  }

  async function testAgent() {
    const effectiveEndpointId = endpointId
      ? Number(endpointId)
      : defaultBinding.endpointId
    const effectiveModel = model.trim() || defaultBinding.model.trim()
    if (!source.trim() || !effectiveEndpointId || !effectiveModel) {
      notify('测试需要原文、端点和模型')
      return
    }
    setTesting(true)
    setResult(null)
    setTestError('')
    try {
      const response = await fetch(
        `/api/agent-catalog/${encodeURIComponent(variant.id)}/test`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceText: source,
            taskBrief,
            additionalInstruction,
            endpointId: effectiveEndpointId,
            model: effectiveModel,
          }),
        },
      )
      const payload = await response.json() as {
        raw?: string
        body?: string
        annotation?: string | null
        error?: string
        diagnosticId?: string
      }
      if (!response.ok) {
        const diagnostic = payload.diagnosticId
          ? `（诊断 ID：${payload.diagnosticId}）`
          : ''
        throw new Error(`${payload.error ?? '测试调用失败'}${diagnostic}`)
      }
      setResult({
        raw: payload.raw,
        body: payload.body ?? '',
        annotation: payload.annotation ?? null,
      })
    } catch (error) {
      setTestError(error instanceof Error ? error.message : '测试调用失败')
    } finally {
      setTesting(false)
    }
  }

  return (
    <details className="mt-3 rounded-sm border border-line bg-paper/55">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-ink-2">
        独立模型、启停与测试
        <span className="ml-2 font-normal text-ink-4">
          {variant.modelOverride
            ? `当前：${variant.modelOverride}`
            : `当前：跟随默认${defaultBinding.model ? `（${defaultBinding.model}）` : ''}`}
        </span>
      </summary>
      <div className="space-y-3 border-t border-line px-3 py-3">
        <label className="flex items-center gap-2 text-xs text-ink-2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="accent-ink"
          />
          在当前方向启用
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <select
            value={endpointId}
            onChange={(event) => {
              setEndpointId(event.target.value)
              setModel('')
            }}
            className="h-9 rounded-sm border border-line-2 bg-paper-raise px-2 text-sm"
            aria-label={`${variant.catalogName} 端点覆盖`}
          >
            <option value="">跟随工作流默认端点</option>
            {endpoints.map((endpoint) => (
              <option key={endpoint.id} value={endpoint.id}>
                {endpoint.name}
              </option>
            ))}
          </select>
          <ModelPicker
            endpointId={
              endpointId ? Number(endpointId) : defaultBinding.endpointId
            }
            value={model}
            onChange={setModel}
            emptyLabel={
              defaultBinding.model
                ? `跟随默认：${defaultBinding.model}`
                : '跟随工作流默认模型'
            }
            ariaLabel={`${variant.catalogName} 独立模型`}
          />
        </div>
        {!builtin && (
          <>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-label="自定义 Agent 名称"
            />
            <Textarea
              rows={2}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              aria-label="自定义 Agent 用途说明"
            />
            <Textarea
              rows={6}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              aria-label="自定义 Agent 角色提示词"
            />
          </>
        )}
        <Button size="sm" disabled={saving} onClick={() => void save()}>
          {saving && <Spinner size="sm" />}保存配置
        </Button>
        <div className="space-y-2 border-t border-line pt-3">
          <div>
            <p className="text-xs font-medium text-ink">独立文本测试</p>
            <p className="mt-1 text-xs leading-5 text-ink-4">
              只调用当前 Agent，不创建会话，也不进入正式实验结果。
            </p>
          </div>
          <Textarea
            rows={3}
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder="输入用于校准这个角色的独立原文"
            aria-label={`${variant.catalogName} 独立测试原文`}
          />
          <Textarea
            rows={2}
            value={taskBrief}
            onChange={(event) => setTaskBrief(event.target.value)}
            placeholder="可选：本次测试的翻译要求"
            aria-label={`${variant.catalogName} 独立测试任务要求`}
          />
          <Textarea
            rows={2}
            value={additionalInstruction}
            onChange={(event) => setAdditionalInstruction(event.target.value)}
            placeholder="可选：只对这个 Agent 生效的补充要求"
            aria-label={`${variant.catalogName} 独立测试补充要求`}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={testing}
            onClick={() => void testAgent()}
          >
            {testing && <Spinner size="sm" />}运行独立测试
          </Button>
          {testError && (
            <p className="rounded-sm border border-cinnabar/30 bg-cinnabar/5 px-3 py-2 text-xs text-cinnabar">
              {testError}
            </p>
          )}
          {result && <IndependentTestOutput result={result} />}
        </div>
      </div>
    </details>
  )
}

export function AgentLibraryPanel({ notify }: { notify: NotifyFn }) {
  const { direction } = useDirection()
  const [archetypes, setArchetypes] = useState<AgentArchetype[]>([])
  const [variants, setVariants] = useState<AgentDirectionVariant[]>([])
  const [endpoints, setEndpoints] = useState<EndpointSummary[]>([])
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [prompt, setPrompt] = useState('')
  const [both, setBoth] = useState(false)
  const [otherDescription, setOtherDescription] = useState('')
  const [otherPrompt, setOtherPrompt] = useState('')
  const [category, setCategory] = useState<AgentCategory>('expression')
  const [previewSource, setPreviewSource] = useState('')
  const [previewTaskBrief, setPreviewTaskBrief] = useState('')
  const [previewInstruction, setPreviewInstruction] = useState('')
  const [previewEndpointId, setPreviewEndpointId] = useState('')
  const [previewModel, setPreviewModel] = useState('')
  const [previewResult, setPreviewResult] =
    useState<IndependentTestResult | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [previewTesting, setPreviewTesting] = useState(false)
  const [profile, setProfile] = useState<{
    defaultWorker: ModelBinding
    mainAgent: ModelBinding
    reviewAgent: ModelBinding
    filterAgent: ModelBinding
    orchestrateAgent: ModelBinding
    assembleAgent: ModelBinding
    editingAgent: ModelBinding
  }>({
    defaultWorker: { endpointId: null, model: '' },
    mainAgent: { endpointId: null, model: '' },
    reviewAgent: { endpointId: null, model: '' },
    filterAgent: { endpointId: null, model: '' },
    orchestrateAgent: { endpointId: null, model: '' },
    assembleAgent: { endpointId: null, model: '' },
    editingAgent: { endpointId: null, model: '' },
  })
  const [profileSaving, setProfileSaving] = useState(false)
  const [testingRole, setTestingRole] = useState<string | null>(null)
  const [roleTestStatus, setRoleTestStatus] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    const [response, endpointResponse, profileResponse] = await Promise.all([
      fetch(`/api/agent-catalog?direction=${direction}&includeDisabled=1`),
      fetch('/api/endpoints'),
      fetch(`/api/model-profiles/${direction}`),
    ])
    if (!response.ok) return
    const payload = await response.json() as {
      archetypes: AgentArchetype[]
      variants: AgentDirectionVariant[]
    }
    setArchetypes(payload.archetypes)
    setVariants(payload.variants)
    if (endpointResponse.ok) {
      setEndpoints(await endpointResponse.json())
    }
    if (profileResponse.ok) {
      const value = await profileResponse.json()
      if (value) setProfile(value)
    }
  }, [direction])

  async function saveProfile() {
    setProfileSaving(true)
    try {
      const response = await fetch(`/api/model-profiles/${direction}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profile),
      })
      if (!response.ok) throw new Error('默认模型分工保存失败')
      setProfile(await response.json())
      notify('默认模型分工已保存', { tone: 'inverted' })
    } catch (error) {
      notify('保存失败', {
        message: error instanceof Error ? error.message : '请重试',
      })
    } finally {
      setProfileSaving(false)
    }
  }

  async function testProfileBinding(
    key: keyof typeof profile,
    label: string,
  ) {
    const binding = profile[key]
    if (!binding.endpointId || !binding.model.trim()) {
      setRoleTestStatus((current) => ({
        ...current,
        [key]: '请先选择端点和模型。',
      }))
      return
    }
    setTestingRole(key)
    setRoleTestStatus((current) => ({ ...current, [key]: '正在发送最小请求…' }))
    try {
      const response = await fetch(`/api/endpoints/${binding.endpointId}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: binding.model }),
      })
      const payload = await response.json().catch(() => null) as {
        latencyMs?: number
        error?: string
        diagnosticId?: string
      } | null
      if (!response.ok) {
        throw new Error(
          `${payload?.error ?? '连接测试失败'}${
            payload?.diagnosticId ? `（诊断 ID：${payload.diagnosticId}）` : ''
          }`,
        )
      }
      setRoleTestStatus((current) => ({
        ...current,
        [key]: `连接成功 · ${payload?.latencyMs ?? 0} ms`,
      }))
    } catch (error) {
      setRoleTestStatus((current) => ({
        ...current,
        [key]: error instanceof Error ? error.message : `${label}连接测试失败`,
      }))
    } finally {
      setTestingRole(null)
    }
  }

  useEffect(() => {
    void load()
  }, [load])

  const archetypeMap = useMemo(
    () => new Map(archetypes.map((archetype) => [archetype.id, archetype])),
    [archetypes],
  )
  const visible = variants.filter((variant) => {
    const query = search.trim().toLowerCase()
    return (
      !query ||
      variant.catalogName.toLowerCase().includes(query) ||
      variant.catalogDescription.toLowerCase().includes(query)
    )
  })

  async function clone(id: string) {
    const response = await fetch(`/api/agent-catalog/${encodeURIComponent(id)}/clone`, {
      method: 'POST',
    })
    if (!response.ok) {
      notify('复制失败')
      return
    }
    notify('已复制为自定义 Agent', { tone: 'inverted' })
    await load()
  }

  async function remove(archetypeId: string) {
    const response = await fetch(`/api/agent-catalog/${encodeURIComponent(archetypeId)}`, {
      method: 'DELETE',
    })
    if (!response.ok) {
      notify('删除失败')
      return
    }
    notify('自定义 Agent 已删除', { tone: 'inverted' })
    await load()
  }

  async function create() {
    if (!name.trim() || !description.trim() || !prompt.trim()) {
      notify('请填写名称、用途说明和提示词')
      return
    }
    if (both && (!otherDescription.trim() || !otherPrompt.trim())) {
      notify('双向 Agent 必须分别填写两个方向的说明与提示词')
      return
    }
    setSaving(true)
    const otherDirection: BuiltinDirection =
      direction === 'en_to_zh' ? 'zh_to_en' : 'en_to_zh'
    const variantFor = (
      value: BuiltinDirection,
      detail: string,
      rolePrompt: string,
    ) => ({
      direction: value,
      catalogName: name.trim(),
      catalogDescription: detail.trim(),
      rolePrompt: rolePrompt.trim(),
      promptLanguage: value === 'en_to_zh' ? 'zh' : 'en',
      enabled: true,
      endpointOverrideId: null,
      modelOverride: null,
    })
    try {
      const response = await fetch('/api/agent-catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayNameZh: name.trim(),
          category,
          tags: [],
          variants: [
            variantFor(direction, description, prompt),
            ...(both
              ? [variantFor(otherDirection, otherDescription, otherPrompt)]
              : []),
          ],
        }),
      })
      if (!response.ok) throw new Error('保存失败')
      setOpen(false)
      setName('')
      setDescription('')
      setPrompt('')
      setOtherDescription('')
      setOtherPrompt('')
      setBoth(false)
      setPreviewSource('')
      setPreviewTaskBrief('')
      setPreviewInstruction('')
      setPreviewEndpointId('')
      setPreviewModel('')
      setPreviewResult(null)
      setPreviewError('')
      notify('自定义 Agent 已创建', { tone: 'inverted' })
      await load()
    } catch (error) {
      notify('保存失败', {
        message: error instanceof Error ? error.message : '请重试',
      })
    } finally {
      setSaving(false)
    }
  }

  async function previewCustomAgent() {
    const effectiveEndpointId = previewEndpointId
      ? Number(previewEndpointId)
      : profile.defaultWorker.endpointId
    const effectiveModel =
      previewModel.trim() || profile.defaultWorker.model.trim()
    if (!prompt.trim()) {
      notify('请先填写当前方向的角色提示词')
      return
    }
    if (!previewSource.trim() || !effectiveEndpointId || !effectiveModel) {
      notify('独立测试需要原文、端点和模型')
      return
    }

    setPreviewTesting(true)
    setPreviewResult(null)
    setPreviewError('')
    try {
      const response = await fetch('/api/agent-catalog/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          direction,
          promptLanguage: direction === 'en_to_zh' ? 'zh' : 'en',
          rolePrompt: prompt,
          sourceText: previewSource,
          taskBrief: previewTaskBrief,
          additionalInstruction: previewInstruction,
          endpointId: effectiveEndpointId,
          model: effectiveModel,
        }),
      })
      const payload = await response.json() as {
        raw?: string
        body?: string
        annotation?: string | null
        error?: string
        diagnosticId?: string
      }
      if (!response.ok) {
        const diagnostic = payload.diagnosticId
          ? `（诊断 ID：${payload.diagnosticId}）`
          : ''
        throw new Error(`${payload.error ?? '独立测试失败'}${diagnostic}`)
      }
      setPreviewResult({
        raw: payload.raw,
        body: payload.body ?? '',
        annotation: payload.annotation ?? null,
      })
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : '独立测试失败')
    } finally {
      setPreviewTesting(false)
    }
  }

  return (
    <Card
      overline="Agent Library"
      title={`Agent 库 · ${direction === 'en_to_zh' ? '英译中' : '中译英'}`}
      actions={
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          新建自定义 Agent
        </Button>
      }
    >
      <details className="mb-4 rounded-sm border border-line bg-paper/55" open>
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-ink-2">
          默认模型分工
        </summary>
        <div className="space-y-3 border-t border-line px-3 py-3">
          {([
            ['defaultWorker', '默认翻译 Agent', '无单独覆盖时使用'],
            ['mainAgent', '主 Agent', '理解任务与选择候选 Agent'],
            ['reviewAgent', '审查', '核对忠实度、误读、漏译与约束'],
            ['filterAgent', '筛选', '比较候选并保留可用方案'],
            ['orchestrateAgent', '编排', '平衡候选并审查用词、句法与连贯性'],
            ['assembleAgent', '组装', '依据审议结果形成正式译文'],
            ['editingAgent', '编辑 Agent', '最终版本对话修改'],
          ] as const).map(([key, label, hint]) => (
            <div
              key={key}
              className="grid min-w-0 gap-3 border-b border-line/70 pb-3 last:border-b-0 last:pb-0 md:grid-cols-[minmax(8rem,0.55fr)_minmax(0,1.8fr)] md:items-start"
            >
              <div>
                <p className="text-xs font-medium text-ink">{label}</p>
                <p className="text-xs text-ink-4">{hint}</p>
              </div>
              <div className="grid min-w-0 gap-2 xl:grid-cols-[minmax(7rem,0.7fr)_minmax(0,1.7fr)_4rem] xl:items-start">
                <select
                  value={profile[key].endpointId?.toString() ?? ''}
                  aria-label={`${label}端点`}
                  onChange={(event) =>
                    setProfile((current) => ({
                      ...current,
                      [key]: {
                        endpointId: event.target.value
                          ? Number(event.target.value)
                          : null,
                        model: '',
                        contextWindow:
                          endpoints.find(
                            (endpoint) => endpoint.id === Number(event.target.value),
                          )?.context_window ?? null,
                      },
                    }))
                  }
                  className="h-9 min-w-0 w-full rounded-sm border border-line-2 bg-paper-raise px-2 text-sm"
                >
                  <option value="">未配置</option>
                  {endpoints.map((endpoint) => (
                    <option key={endpoint.id} value={endpoint.id}>
                      {endpoint.name}
                    </option>
                  ))}
                </select>
                <ModelPicker
                  endpointId={profile[key].endpointId}
                  value={profile[key].model}
                  onChange={(model) =>
                    setProfile((current) => ({
                      ...current,
                      [key]: { ...current[key], model },
                    }))
                  }
                  emptyLabel="选择模型"
                  ariaLabel={`${label}模型`}
                />
                <div className="min-h-[3.25rem] min-w-0">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="w-full"
                    disabled={testingRole != null}
                    onClick={() => void testProfileBinding(key, label)}
                  >
                    {testingRole === key && <Spinner size="sm" />}
                    测试
                  </Button>
                  <p
                    className={`mt-1 min-h-4 break-words text-[10px] leading-4 ${
                      roleTestStatus[key]?.startsWith('连接成功')
                        ? 'text-ink-4'
                        : 'text-cinnabar'
                    }`}
                  >
                    {roleTestStatus[key] ?? ''}
                  </p>
                </div>
              </div>
            </div>
          ))}
          <Button
            size="sm"
            variant="outline"
            disabled={profileSaving}
            onClick={() => void saveProfile()}
          >
            {profileSaving && <Spinner size="sm" />}保存默认分工
          </Button>
        </div>
      </details>
      <Input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="搜索名称或用途……"
        aria-label="搜索 Agent"
      />
      <ul className="mt-3 divide-y divide-line">
        {visible.map((variant) => {
          const archetype = archetypeMap.get(variant.archetypeId)
          return (
            <li key={variant.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-ink">{variant.catalogName}</p>
                    <Badge variant={archetype?.isBuiltin ? 'solid' : 'outline'}>
                      {archetype?.isBuiltin ? '内置' : '自定义'}
                    </Badge>
                    <Badge variant="subtle">{archetype?.category ?? 'custom'}</Badge>
                    <Badge variant={variant.modelOverride ? 'outline' : 'subtle'}>
                      {variant.modelOverride
                        ? `独立：${variant.modelOverride}`
                        : '跟随默认模型'}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-ink-3">
                    {variant.catalogDescription}
                  </p>
                  {archetype?.isBuiltin && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-ink-3">
                        查看完整提示词（只读）
                      </summary>
                      <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-sm border border-line bg-paper px-3 py-2 text-xs leading-5 text-ink-2">
                        {variant.rolePrompt}
                      </pre>
                    </details>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="sm" onClick={() => void clone(variant.id)}>
                    复制
                  </Button>
                  {!archetype?.isBuiltin && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void remove(variant.archetypeId)}
                    >
                      删除
                    </Button>
                  )}
                </div>
              </div>
              <VariantEditor
                variant={variant}
                builtin={Boolean(archetype?.isBuiltin)}
                endpoints={endpoints}
                defaultBinding={profile.defaultWorker}
                notify={notify}
                onChanged={load}
              />
            </li>
          )
        })}
      </ul>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="新建自定义 Agent"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button size="sm" disabled={saving} onClick={() => void create()}>
              {saving && <Spinner size="sm" />}保存
            </Button>
          </>
        }
        className="max-w-2xl"
      >
        <div className="space-y-4">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Agent 名称"
          />
          <label className="flex items-center justify-between gap-3 text-sm text-ink-2">
            分类
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value as AgentCategory)}
              className="rounded-sm border border-line-2 bg-paper-raise px-2 py-1.5"
            >
              <option value="foundation">基础</option>
              <option value="expression">表达</option>
              <option value="domain">领域</option>
              <option value="creative">创作</option>
              <option value="adversarial">异议</option>
            </select>
          </label>
          <Textarea
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="当前方向的用途说明"
          />
          <Textarea
            rows={7}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={
              direction === 'en_to_zh'
                ? '当前方向角色提示词（中文）'
                : 'Role prompt for this direction (English)'
            }
          />
          <details className="rounded-sm border border-line bg-paper/55" open>
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-ink-2">
              用独立文本试跑未保存的提示词
            </summary>
            <div className="space-y-2 border-t border-line px-3 py-3">
              <p className="text-xs leading-5 text-ink-4">
                只校准当前角色，不创建 Agent、会话或实验记录。不同角色不需要得出相同译文。
              </p>
              <Textarea
                rows={4}
                value={previewSource}
                onChange={(event) => setPreviewSource(event.target.value)}
                placeholder="独立测试原文"
                aria-label="新建 Agent 独立测试原文"
              />
              <Textarea
                rows={2}
                value={previewTaskBrief}
                onChange={(event) => setPreviewTaskBrief(event.target.value)}
                placeholder="可选：本次测试的翻译要求"
                aria-label="新建 Agent 独立测试任务要求"
              />
              <Textarea
                rows={2}
                value={previewInstruction}
                onChange={(event) => setPreviewInstruction(event.target.value)}
                placeholder="可选：只对这个 Agent 生效的补充要求"
                aria-label="新建 Agent 独立测试补充要求"
              />
              <div className="grid gap-2 sm:grid-cols-2">
                <select
                  value={previewEndpointId}
                  onChange={(event) => {
                    setPreviewEndpointId(event.target.value)
                    setPreviewModel('')
                  }}
                  className="h-9 rounded-sm border border-line-2 bg-paper-raise px-2 text-sm"
                  aria-label="新建 Agent 独立测试端点"
                >
                  <option value="">跟随默认翻译 Agent 端点</option>
                  {endpoints.map((endpoint) => (
                    <option key={endpoint.id} value={endpoint.id}>
                      {endpoint.name}
                    </option>
                  ))}
                </select>
                <ModelPicker
                  endpointId={
                    previewEndpointId
                      ? Number(previewEndpointId)
                      : profile.defaultWorker.endpointId
                  }
                  value={previewModel}
                  onChange={setPreviewModel}
                  emptyLabel={
                    profile.defaultWorker.model
                      ? `跟随默认：${profile.defaultWorker.model}`
                      : '选择测试模型'
                  }
                  ariaLabel="新建 Agent 独立测试模型"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={previewTesting}
                onClick={() => void previewCustomAgent()}
              >
                {previewTesting && <Spinner size="sm" />}运行独立测试
              </Button>
              {previewError && (
                <p className="rounded-sm border border-cinnabar/30 bg-cinnabar/5 px-3 py-2 text-xs text-cinnabar">
                  {previewError}
                </p>
              )}
              {previewResult && (
                <IndependentTestOutput result={previewResult} />
              )}
            </div>
          </details>
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input
              type="checkbox"
              checked={both}
              onChange={(event) => setBoth(event.target.checked)}
              className="accent-ink"
            />
            同时支持反方向（必须单独填写，不自动翻译）
          </label>
          {both && (
            <>
              <Textarea
                rows={2}
                value={otherDescription}
                onChange={(event) => setOtherDescription(event.target.value)}
                placeholder="反方向用途说明"
              />
              <Textarea
                rows={7}
                value={otherPrompt}
                onChange={(event) => setOtherPrompt(event.target.value)}
                placeholder={
                  direction === 'en_to_zh'
                    ? 'Role prompt for Chinese-to-English (English)'
                    : '英译中角色提示词（中文）'
                }
              />
            </>
          )}
        </div>
      </Modal>
    </Card>
  )
}
