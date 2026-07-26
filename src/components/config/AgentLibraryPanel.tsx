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

interface EndpointSummary {
  id: number
  name: string
  base_url: string
}

function VariantEditor({
  variant,
  builtin,
  endpoints,
  notify,
  onChanged,
}: {
  variant: AgentDirectionVariant
  builtin: boolean
  endpoints: EndpointSummary[]
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
  const [result, setResult] = useState('')
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
    if (!source.trim() || !endpointId || !model.trim()) {
      notify('测试需要原文、端点和模型')
      return
    }
    setTesting(true)
    setResult('')
    try {
      const response = await fetch(
        `/api/agent-catalog/${encodeURIComponent(variant.id)}/test`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceText: source,
            taskBrief: '仅用于 Agent 配置测试，不创建会话。',
            endpointId: Number(endpointId),
            model: model.trim(),
          }),
        },
      )
      const payload = await response.json() as {
        body?: string
        annotation?: string | null
        error?: string
      }
      if (!response.ok) throw new Error(payload.error ?? '测试调用失败')
      setResult(
        `${payload.body ?? ''}${
          payload.annotation ? `\n\n---\n${payload.annotation}` : ''
        }`,
      )
    } catch (error) {
      setResult(error instanceof Error ? error.message : '测试调用失败')
    } finally {
      setTesting(false)
    }
  }

  return (
    <details className="mt-3 rounded-sm border border-line bg-paper/55">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-ink-2">
        配置、启停与测试
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
            onChange={(event) => setEndpointId(event.target.value)}
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
          <Input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="模型覆盖（留空则跟随工作流）"
            aria-label={`${variant.catalogName} 模型覆盖`}
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
        <div className="border-t border-line pt-3">
          <Textarea
            rows={3}
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder="输入一小段原文进行测试；测试不会创建会话。"
          />
          <Button
            className="mt-2"
            variant="outline"
            size="sm"
            disabled={testing}
            onClick={() => void testAgent()}
          >
            {testing && <Spinner size="sm" />}测试调用
          </Button>
          {result && (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-sm border border-line bg-paper px-3 py-2 text-xs leading-5 text-ink-2">
              {result}
            </pre>
          )}
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
  const [profile, setProfile] = useState<{
    defaultWorker: ModelBinding
    mainAgent: ModelBinding
    editingAgent: ModelBinding
  }>({
    defaultWorker: { endpointId: null, model: '' },
    mainAgent: { endpointId: null, model: '' },
    editingAgent: { endpointId: null, model: '' },
  })
  const [profileSaving, setProfileSaving] = useState(false)

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
            ['mainAgent', '主 Agent / 四阶段', '组队、成稿与统筹'],
            ['editingAgent', '编辑 Agent', '最终版本对话修改'],
          ] as const).map(([key, label, hint]) => (
            <div key={key} className="grid gap-2 sm:grid-cols-[1fr_1fr_1.2fr] sm:items-center">
              <div>
                <p className="text-xs font-medium text-ink">{label}</p>
                <p className="text-xs text-ink-4">{hint}</p>
              </div>
              <select
                value={profile[key].endpointId?.toString() ?? ''}
                onChange={(event) =>
                  setProfile((current) => ({
                    ...current,
                    [key]: {
                      ...current[key],
                      endpointId: event.target.value
                        ? Number(event.target.value)
                        : null,
                    },
                  }))
                }
                className="h-9 rounded-sm border border-line-2 bg-paper-raise px-2 text-sm"
              >
                <option value="">未配置</option>
                {endpoints.map((endpoint) => (
                  <option key={endpoint.id} value={endpoint.id}>
                    {endpoint.name}
                  </option>
                ))}
              </select>
              <Input
                value={profile[key].model}
                onChange={(event) =>
                  setProfile((current) => ({
                    ...current,
                    [key]: { ...current[key], model: event.target.value },
                  }))
                }
                placeholder="模型名称"
              />
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
