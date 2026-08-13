'use client'

// ---------------------------------------------------------------------------
// 端点管理面板 —— 列表 / 预设表单（Modal）/ 删除确认（两段式）
// 删除闭环：确认 → DELETE → 409(安全引用摘要) → 原子解绑并删除
// 活跃配置只清除端点绑定；Agent、提示词、模型与冻结历史均保留。
// ---------------------------------------------------------------------------

import { useState } from 'react'
import { Badge, Button, Card, Input, Modal, Spinner } from '@/src/components/ui'
import type { EndpointReferenceSummary } from '@/src/lib/contracts/endpoint-references'
import { TID } from '@/src/lib/testids'
import {
  configApi,
  isApiError,
  type Agent,
  type Endpoint,
  type EndpointDeleteConflict,
} from './api'
import { Field, type NotifyFn } from './shared'
import {
  DEFAULT_CHAT_COMPLETIONS_PATH,
  resolveChatCompletionsUrl,
  splitEndpointAddress,
} from '@/src/lib/llm/endpoint-url'
import { ModelPicker } from './ModelPicker'

const ENDPOINT_PRESETS = [
  { name: 'OpenAI', base_url: 'https://api.openai.com', path: '/v1/chat/completions' },
  { name: 'Gemini', base_url: 'https://generativelanguage.googleapis.com', path: '/v1beta/openai/chat/completions' },
  { name: 'DeepSeek', base_url: 'https://api.deepseek.com', path: '/v1/chat/completions' },
  { name: 'OpenRouter', base_url: 'https://openrouter.ai', path: '/api/v1/chat/completions' },
  { name: 'Ollama', base_url: 'http://localhost:11434', path: '/v1/chat/completions' },
] as const

export interface EndpointPanelProps {
  endpoints: Endpoint[]
  /** Kept while the surrounding configuration page migrates off legacy data. */
  agents: Agent[]
  notify: NotifyFn
  onChanged: () => Promise<void>
}

interface FormErrors {
  name?: string
  base_url?: string
}

const EMPTY_REFERENCE_SUMMARY: EndpointReferenceSummary = {
  active: {
    legacyAgents: 0,
    vnextAgentOverrides: 0,
    coordinatorBindings: 0,
    legacyPresetAgents: 0,
    legacyPresetCoordinatorBindings: 0,
    modelProfileBindings: 0,
    onboardingSelection: 0,
    capabilityProfiles: 0,
  },
  historical: {
    sessions: 0,
    workflowPresetRevisions: 0,
    batchJobs: 0,
    agentInvocations: 0,
    llmCalls: 0,
  },
  totalActive: 0,
  totalHistorical: 0,
}

export interface EndpointReferenceDisplayItem {
  key: string
  label: string
  count: number
}

export interface EndpointReferenceDisplayGroup {
  title: string
  items: EndpointReferenceDisplayItem[]
}

/** Converts the API's numeric-only summary into the labels used by the modal. */
export function endpointReferenceDisplayGroups(
  summary: EndpointReferenceSummary,
): EndpointReferenceDisplayGroup[] {
  const active: EndpointReferenceDisplayItem[] = [
    { key: 'legacyAgents', label: '旧版翻译 Agent', count: summary.active.legacyAgents },
    { key: 'vnextAgentOverrides', label: 'vNext Agent 单独覆盖', count: summary.active.vnextAgentOverrides },
    { key: 'coordinatorBindings', label: '当前统筹与对话绑定', count: summary.active.coordinatorBindings },
    { key: 'legacyPresetAgents', label: '旧版预设 Agent', count: summary.active.legacyPresetAgents },
    {
      key: 'legacyPresetCoordinatorBindings',
      label: '旧版预设统筹绑定',
      count: summary.active.legacyPresetCoordinatorBindings,
    },
    { key: 'modelProfileBindings', label: '默认模型分工', count: summary.active.modelProfileBindings },
    { key: 'onboardingSelection', label: '首次运行向导选择', count: summary.active.onboardingSelection },
    { key: 'capabilityProfiles', label: '兼容性检查缓存', count: summary.active.capabilityProfiles },
  ].filter((item) => item.count > 0)
  const historical: EndpointReferenceDisplayItem[] = [
    { key: 'sessions', label: '历史会话', count: summary.historical.sessions },
    {
      key: 'workflowPresetRevisions',
      label: '工作流预设 revision',
      count: summary.historical.workflowPresetRevisions,
    },
    { key: 'batchJobs', label: '批量任务快照', count: summary.historical.batchJobs },
    { key: 'agentInvocations', label: 'Agent 调用记录', count: summary.historical.agentInvocations },
    { key: 'llmCalls', label: '模型调用账本', count: summary.historical.llmCalls },
  ].filter((item) => item.count > 0)

  return [
    { title: '当前配置引用', items: active },
    { title: '历史记录引用', items: historical },
  ].filter((group) => group.items.length > 0)
}

export function EndpointPanel({ endpoints, notify, onChanged }: EndpointPanelProps) {
  // ── 表单（Modal）状态 ──
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Endpoint | null>(null)
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [chatPath, setChatPath] = useState(DEFAULT_CHAT_COMPLETIONS_PATH)
  const [apiKey, setApiKey] = useState('')
  const [contextWindow, setContextWindow] = useState('')
  const [testModel, setTestModel] = useState('')
  const [testStatus, setTestStatus] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [errors, setErrors] = useState<FormErrors>({})
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  // ── 删除确认状态 ──
  const [deleteTarget, setDeleteTarget] = useState<Endpoint | null>(null)
  const [deleteRefs, setDeleteRefs] = useState<EndpointReferenceSummary | null>(null)
  const [deleting, setDeleting] = useState(false)

  function openCreate() {
    setEditing(null)
    setName('')
    setBaseUrl('')
    setChatPath(DEFAULT_CHAT_COMPLETIONS_PATH)
    setApiKey('')
    setContextWindow('')
    setTestModel('')
    setTestStatus('')
    setShowKey(false)
    setErrors({})
    setFormOpen(true)
  }

  function openEdit(ep: Endpoint) {
    setEditing(ep)
    setName(ep.name)
    setBaseUrl(ep.base_url)
    setChatPath(ep.chat_completions_path)
    setApiKey('')
    setContextWindow(ep.context_window?.toString() ?? '')
    setTestModel('')
    setTestStatus('')
    setShowKey(false)
    setErrors({})
    setFormOpen(true)
  }

  function applyPreset(preset: (typeof ENDPOINT_PRESETS)[number]) {
    setName(preset.name)
    setBaseUrl(preset.base_url)
    setChatPath(preset.path)
    setErrors((prev) => ({ ...prev, name: undefined, base_url: undefined }))
  }

  async function save() {
    const next: FormErrors = {}
    if (name.trim().length === 0) next.name = '请输入名称'
    const url = baseUrl.trim()
    if (url.length === 0) {
      next.base_url = '请输入 Base URL'
    } else {
      try {
        new URL(url)
      } catch {
        next.base_url = '请输入合法的 URL，如 http://localhost:11434/v1'
      }
    }
    setErrors(next)
    if (next.name != null || next.base_url != null) return // 校验失败，不发请求

    setSaving(true)
    try {
      if (editing) {
        await configApi.updateEndpoint(editing.id, {
          name: name.trim(),
          base_url: url,
          chat_completions_path: chatPath,
          api_key: apiKey,
          context_window: contextWindow ? Number(contextWindow) : null,
        })
        notify('端点已更新', { tone: 'inverted' })
      } else {
        await configApi.createEndpoint({
          name: name.trim(),
          base_url: url,
          chat_completions_path: chatPath,
          api_key: apiKey,
          context_window: contextWindow ? Number(contextWindow) : null,
        })
        notify('端点已添加', { tone: 'inverted' })
      }
      setFormOpen(false)
      await onChanged()
    } catch (e) {
      notify('保存失败', { message: isApiError(e) ? e.message : '网络错误，请重试' })
    } finally {
      setSaving(false)
    }
  }

  async function testEndpoint() {
    if (!editing || !testModel.trim()) return
    setTesting(true)
    setTestStatus('')
    try {
      const response = await fetch(`/api/endpoints/${editing.id}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: testModel.trim() }),
      })
      const payload = await response.json() as {
        latencyMs?: number
        error?: string
        diagnosticId?: string
      }
      if (!response.ok) {
        throw new Error(
          `${payload.error ?? '测试失败'}${
            payload.diagnosticId ? `（诊断 ID：${payload.diagnosticId}）` : ''
          }`,
        )
      }
      setTestStatus(`连接成功 · ${payload.latencyMs ?? 0} ms`)
    } catch (error) {
      setTestStatus(error instanceof Error ? error.message : '测试失败')
    } finally {
      setTesting(false)
    }
  }

  function requestDelete(ep: Endpoint) {
    setDeleteTarget(ep)
    setDeleteRefs(null)
  }

  function closeDelete() {
    setDeleteTarget(null)
    setDeleteRefs(null)
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await configApi.deleteEndpoint(deleteTarget.id)
      notify(`端点「${deleteTarget.name}」已删除`, { tone: 'inverted' })
      closeDelete()
      await onChanged()
    } catch (e) {
      if (isApiError(e) && e.status === 409) {
        const payload = e.payload as EndpointDeleteConflict | null
        if (payload?.references) {
          setDeleteRefs(payload.references)
        } else {
          // Compatibility with an older server that only returned session IDs.
          const sessionCount = Array.isArray(payload?.usedBySessions)
            ? payload.usedBySessions.length
            : 0
          setDeleteRefs({
            ...EMPTY_REFERENCE_SUMMARY,
            historical: {
              ...EMPTY_REFERENCE_SUMMARY.historical,
              sessions: sessionCount,
            },
            totalHistorical: sessionCount,
          })
        }
      } else {
        notify('删除失败', { message: isApiError(e) ? e.message : '网络错误，请重试' })
      }
    } finally {
      setDeleting(false)
    }
  }

  async function forceDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await configApi.deleteEndpoint(deleteTarget.id, { force: true })
      notify(`端点「${deleteTarget.name}」已删除`, { tone: 'inverted' })
      closeDelete()
      await onChanged()
    } catch (e) {
      notify('删除失败', { message: isApiError(e) ? e.message : '网络错误，请重试' })
    } finally {
      setDeleting(false)
    }
  }

  const referenceGroups = deleteRefs ? endpointReferenceDisplayGroups(deleteRefs) : []

  return (
    <Card
      overline="Endpoints"
      title="端点"
      actions={
        endpoints.length > 0 ? (
          <Button variant="outline" size="sm" testId={TID.endpoint.addButton} onClick={openCreate}>
            添加端点
          </Button>
        ) : undefined
      }
    >
      {endpoints.length === 0 ? (
        <div className="rounded-sm border border-dashed border-line-2 bg-paper/60 px-4 py-8 text-center">
          <p className="text-sm leading-6 text-ink-3">
            尚未添加端点。端点是 OpenAI 兼容的模型服务地址（Base URL + API Key）。
          </p>
          <Button
            variant="outline"
            size="sm"
            testId={TID.endpoint.addButton}
            onClick={openCreate}
            className="mt-3"
          >
            添加端点
          </Button>
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {endpoints.map((ep) => {
            return (
              <li
                key={ep.id}
                data-testid={TID.endpoint.listItem}
                className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium text-ink">{ep.name}</p>
                    <Badge variant={ep.has_api_key ? 'outline' : 'subtle'}>
                      {ep.has_api_key ? '已设置 Key' : '未设置 Key'}
                    </Badge>
                  </div>
                  <p className="mt-0.5 break-all font-mono text-xs leading-5 text-ink-3">
                    {ep.base_url}
                    {ep.chat_completions_path}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => openEdit(ep)}>
                  编辑
                </Button>
                <Button variant="ghost" size="sm" onClick={() => requestDelete(ep)}>
                  删除
                </Button>
              </li>
            )
          })}
        </ul>
      )}

      {/* 创建 / 编辑表单 */}
      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? '编辑端点' : '添加端点'}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setFormOpen(false)}>
              取消
            </Button>
            <Button
              size="sm"
              testId={TID.endpoint.saveButton}
              onClick={() => void save()}
              disabled={saving}
            >
              {saving && <Spinner size="sm" />}
              保存
            </Button>
          </>
        }
      >
        <form
          data-testid={TID.endpoint.form}
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
          className="space-y-4"
        >
          {editing == null && (
            <div>
              <span className="mb-1.5 block text-xs font-medium text-ink-2">预设</span>
              <div className="flex flex-wrap gap-1.5">
                {ENDPOINT_PRESETS.map((p) => (
                  <Button
                    key={p.name}
                    variant="outline"
                    size="sm"
                    onClick={() => applyPreset(p)}
                  >
                    {p.name}
                  </Button>
                ))}
              </div>
              <p className="mt-1 text-xs leading-5 text-ink-4">
                点击自动填入 Base URL 占位，可按需修改。
              </p>
            </div>
          )}

          <Field label="名称" error={errors.name}>
            <Input
              testId={TID.endpoint.nameInput}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如 OpenAI 主账号"
            />
          </Field>

          <Field label="Base URL" error={errors.base_url}>
            <Input
              testId={TID.endpoint.baseUrlInput}
              value={baseUrl}
              onChange={(e) => {
                const value = e.target.value
                try {
                  const split = splitEndpointAddress(value)
                  if (value.includes('/chat/completions')) {
                    setBaseUrl(split.baseUrl)
                    setChatPath(split.chatCompletionsPath)
                    return
                  }
                } catch {
                  // Keep the partial form value while the user is typing.
                }
                setBaseUrl(value)
              }}
              placeholder="https://api.openai.com"
              className="font-mono"
            />
          </Field>

          <Field
            label="请求路径"
            hint={
              baseUrl
                ? `最终请求地址：${resolveChatCompletionsUrl({
                    baseUrl,
                    chatCompletionsPath: chatPath,
                  })}`
                : '默认 /v1/chat/completions；也可直接粘贴完整 Chat Completions URL。'
            }
          >
            <Input
              value={chatPath}
              onChange={(event) => setChatPath(event.target.value)}
              placeholder="/v1/chat/completions"
              className="font-mono"
            />
          </Field>
          {editing && (
            <div className="rounded-sm border border-line bg-paper/55 px-3 py-3">
              <p className="text-xs font-medium text-ink-2">模型列表与连接测试</p>
              <p className="mb-2 mt-1 text-xs leading-5 text-ink-4">
                通过服务端读取此端点的 /models；API Key 不会进入浏览器。
              </p>
              <div className="space-y-2">
                <ModelPicker
                  endpointId={editing.id}
                  value={testModel}
                  onChange={setTestModel}
                  emptyLabel="选择用于测试的模型"
                  ariaLabel="端点测试模型"
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={testing || !testModel.trim()}
                  onClick={() => void testEndpoint()}
                >
                  {testing && <Spinner size="sm" />}测试
                </Button>
              </div>
              {testStatus && (
                <p className="mt-2 text-xs leading-5 text-ink-3">{testStatus}</p>
              )}
            </div>
          )}

          <Field
            label="上下文上限"
            hint="可选。填写模型上下文窗口 token 数；超限时会明确报错，不静默裁剪。"
          >
            <Input
              type="number"
              min={1}
              value={contextWindow}
              onChange={(event) => setContextWindow(event.target.value)}
              placeholder="例如 128000"
            />
          </Field>

          <Field
            label="API Key"
            hint={
              editing?.has_api_key
                ? '已安全保存。留空表示保留现有 Key；输入新值才会替换。'
                : '本地加密保存且不会返回浏览器。可留空（如本机 Ollama）。'
            }
          >
            <div className="relative">
              <Input
                testId={TID.endpoint.keyInput}
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-…"
                autoComplete="off"
                className="pr-14 font-mono"
              />
              <button
                type="button"
                aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-1 top-1/2 h-7 -translate-y-1/2 rounded-sm px-2 text-xs text-ink-3 transition-colors hover:bg-paper-sink hover:text-ink"
              >
                {showKey ? '隐藏' : '显示'}
              </button>
            </div>
          </Field>
          {/* 隐藏提交钮：回车即保存 */}
          <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
        </form>
      </Modal>

      {/* 删除确认（两段式：影响检查 → 原子解绑并删除） */}
      <Modal
        open={deleteTarget != null}
        onClose={closeDelete}
        title={deleteRefs == null ? '删除端点' : '确认解绑并删除'}
        footer={
          deleteRefs == null ? (
            <>
              <Button variant="ghost" size="sm" onClick={closeDelete}>
                取消
              </Button>
              <Button size="sm" onClick={() => void confirmDelete()} disabled={deleting}>
                {deleting && <Spinner size="sm" />}
                检查引用并删除
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={closeDelete}>
                取消
              </Button>
              <Button
                size="sm"
                onClick={() => void forceDelete()}
                disabled={deleting}
              >
                {deleting && <Spinner size="sm" />}
                解绑所有引用并删除
              </Button>
            </>
          )
        }
      >
        {deleteTarget != null && deleteRefs == null && (
          <div className="text-sm leading-6 text-ink-2">
            <p>
              确定删除端点「{deleteTarget.name}」吗？系统会先检查全部引用；没有引用时直接删除，
              有引用时会展示影响范围并再次确认。
            </p>
          </div>
        )}
        {deleteTarget != null && deleteRefs != null && (
          <div className="space-y-4 text-sm leading-6 text-ink-2">
            <p>
              检测到 {deleteRefs.totalActive} 处当前配置引用和 {deleteRefs.totalHistorical}{' '}
              处历史记录引用。确认后，系统会在同一事务中解除当前绑定并删除端点。
            </p>
            <div className="space-y-3 rounded-sm border border-line bg-paper/55 px-3 py-3">
              {referenceGroups.map((group) => (
                <div key={group.title}>
                  <p className="text-xs font-medium text-ink-3">{group.title}</p>
                  <ul className="mt-1.5 space-y-1">
                    {group.items.map((item) => (
                      <li key={item.key} className="flex items-center justify-between gap-4">
                        <span>{item.label}</span>
                        <Badge variant="subtle">{item.count}</Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <p className="text-xs leading-5 text-ink-3">
              Agent、提示词、模型名称、预设内容和冻结历史都会保留；当前配置中的端点引用会置空，
              之后可重新绑定。兼容性检查缓存会随端点移除，历史会话、调用记录和模型调用账本不会被改写。
            </p>
            <p className="text-xs leading-5 text-ink-4">
              端点地址与本地保存的凭据将被删除。此操作不可撤销。
            </p>
          </div>
        )}
      </Modal>
    </Card>
  )
}
