'use client'

import { useCallback, useEffect, useState } from 'react'
import { Badge, Button, Card, Input, Modal, Spinner, Textarea } from '@/src/components/ui'
import { useDirection } from '@/src/components/direction/DirectionProvider'
import type {
  AgentDirectionVariant,
  ReviewMode,
  TeamPolicy,
  WorkflowPreset,
  WorkflowPresetRevision,
} from '@/src/lib/contracts/vnext'
import type { Endpoint } from './api'
import type { NotifyFn } from './shared'

export function WorkflowPresetPanel({
  endpoints,
  notify,
}: {
  endpoints: Endpoint[]
  notify: NotifyFn
}) {
  const { direction } = useDirection()
  const [presets, setPresets] = useState<WorkflowPreset[]>([])
  const [variants, setVariants] = useState<AgentDirectionVariant[]>([])
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [taskBrief, setTaskBrief] = useState('')
  const [model, setModel] = useState('')
  const [endpointId, setEndpointId] = useState<number | null>(null)
  const [teamPolicy, setTeamPolicy] = useState<TeamPolicy>('fixed')
  const [reviewMode, setReviewMode] = useState<ReviewMode>('main_editor')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [details, setDetails] = useState<{
    preset: WorkflowPreset
    revisions: WorkflowPresetRevision[]
  } | null>(null)

  const load = useCallback(async () => {
    const [presetResponse, catalogueResponse] = await Promise.all([
      fetch(`/api/workflow-presets?direction=${direction}`),
      fetch(`/api/agent-catalog?direction=${direction}`),
    ])
    if (presetResponse.ok) setPresets(await presetResponse.json())
    if (catalogueResponse.ok) {
      const payload = await catalogueResponse.json() as {
        variants: AgentDirectionVariant[]
      }
      setVariants(payload.variants)
      setSelectedIds((current) =>
        current.length >= 2
          ? current
          : payload.variants.slice(0, 2).map((variant) => variant.id),
      )
    }
    setEndpointId((current) => current ?? endpoints[0]?.id ?? null)
  }, [direction, endpoints])

  useEffect(() => {
    void load()
  }, [load])

  async function create() {
    if (!name.trim() || !model.trim() || !endpointId || selectedIds.length < 2) {
      notify('请填写名称、模型、端点并至少选择两个 Agent')
      return
    }
    const snapshots = selectedIds
      .map((id) => variants.find((variant) => variant.id === id))
      .filter((variant): variant is AgentDirectionVariant => Boolean(variant))
    setSaving(true)
    try {
      const binding = {
        endpointId,
        model: model.trim(),
        contextWindow:
          endpoints.find((endpoint) => endpoint.id === endpointId)?.context_window ??
          null,
      }
      const response = await fetch('/api/workflow-presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          direction,
          contract: {
            sourceLang: direction === 'en_to_zh' ? '英文' : '中文',
            targetLang: direction === 'en_to_zh' ? '中文' : '英文',
            taskBriefTemplate: taskBrief,
            teamPolicy,
            reviewMode,
            agentVariantIds: selectedIds,
            agentVariantSnapshots: snapshots,
            defaultWorkerBinding: binding,
            agentBindingOverrides: {},
            mainAgentBinding: binding,
            editingAgentBinding: binding,
            promptBundleVersion: 1,
            maxAgentCalls: 5,
            batchConcurrency: 2,
            constraints: {},
          },
        }),
      })
      if (!response.ok) throw new Error('预设保存失败')
      setOpen(false)
      setName('')
      setDescription('')
      setTaskBrief('')
      notify('工作流预设 revision 1 已创建', { tone: 'inverted' })
      await load()
    } catch (error) {
      notify('保存失败', {
        message: error instanceof Error ? error.message : '请重试',
      })
    } finally {
      setSaving(false)
    }
  }

  async function inspect(preset: WorkflowPreset) {
    const response = await fetch(`/api/workflow-presets/${encodeURIComponent(preset.id)}`)
    if (response.ok) setDetails(await response.json())
  }

  async function restore(revisionNo: number) {
    if (!details) return
    const response = await fetch(
      `/api/workflow-presets/${encodeURIComponent(details.preset.id)}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revisionNo }),
      },
    )
    if (!response.ok) {
      notify('恢复失败')
      return
    }
    notify('旧 revision 已恢复为新的当前 revision', { tone: 'inverted' })
    await inspect(details.preset)
    await load()
  }

  async function remove(preset: WorkflowPreset) {
    const response = await fetch(`/api/workflow-presets/${encodeURIComponent(preset.id)}`, {
      method: 'DELETE',
    })
    if (!response.ok) return notify('删除失败')
    notify('预设已移入回收站', { tone: 'inverted' })
    await load()
  }

  return (
    <Card
      overline="Workflow Presets"
      title="可复用工作流预设"
      actions={
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          新建预设
        </Button>
      }
    >
      {presets.length === 0 ? (
        <p className="rounded-sm border border-dashed border-line-2 p-5 text-center text-sm text-ink-4">
          当前方向尚无用户预设。预设会冻结 Agent、提示词版本与模型绑定，适合批量任务。
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {presets.map((preset) => (
            <li key={preset.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium text-ink">{preset.name}</p>
                  <Badge variant="subtle">rev {preset.currentRevisionNo}</Badge>
                </div>
                <p className="mt-1 line-clamp-1 text-xs text-ink-3">
                  {preset.description || '无说明'}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => void inspect(preset)}>
                revisions
              </Button>
              <Button
                href={`/api/workflow-presets/${encodeURIComponent(preset.id)}/export`}
                variant="ghost"
                size="sm"
              >
                导出
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void remove(preset)}>
                删除
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="新建工作流预设"
        className="max-w-2xl"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>取消</Button>
            <Button size="sm" disabled={saving} onClick={() => void create()}>
              {saving && <Spinner size="sm" />}保存 revision 1
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="预设名称" />
          <Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="说明" />
          <Textarea
            rows={3}
            value={taskBrief}
            onChange={(event) => setTaskBrief(event.target.value)}
            placeholder="任务要求模板，可使用 {{file_name}} 与 {{relative_path}}"
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <select
              value={endpointId ?? ''}
              onChange={(event) => setEndpointId(Number(event.target.value) || null)}
              className="rounded-sm border border-line-2 bg-paper-raise px-2 py-2 text-sm"
            >
              <option value="">选择端点</option>
              {endpoints.map((endpoint) => (
                <option key={endpoint.id} value={endpoint.id}>{endpoint.name}</option>
              ))}
            </select>
            <Input value={model} onChange={(event) => setModel(event.target.value)} placeholder="模型名称" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-ink-3">
              编队策略
              <select
                value={teamPolicy}
                onChange={(event) => setTeamPolicy(event.target.value as TeamPolicy)}
                className="mt-1 block w-full rounded-sm border border-line-2 bg-paper-raise px-2 py-2 text-sm text-ink"
              >
                <option value="fixed">固定编队（默认）</option>
                <option value="dynamic">动态允许池</option>
              </select>
            </label>
            <label className="text-xs text-ink-3">
              审议方式
              <select
                value={reviewMode}
                onChange={(event) => setReviewMode(event.target.value as ReviewMode)}
                className="mt-1 block w-full rounded-sm border border-line-2 bg-paper-raise px-2 py-2 text-sm text-ink"
              >
                <option value="main_editor">主 Agent 编辑</option>
                <option value="four_stage">经典四阶段</option>
              </select>
            </label>
          </div>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {variants.map((variant) => (
              <label key={variant.id} className="flex items-center gap-2 rounded-xs border border-line px-2 py-1.5 text-xs">
                <input
                  type="checkbox"
                  className="accent-ink"
                  checked={selectedIds.includes(variant.id)}
                  onChange={(event) =>
                    setSelectedIds((current) =>
                      event.target.checked
                        ? [...current, variant.id]
                        : current.filter((id) => id !== variant.id),
                    )
                  }
                />
                {variant.catalogName}
              </label>
            ))}
          </div>
        </div>
      </Modal>

      <Modal
        open={details != null}
        onClose={() => setDetails(null)}
        title={details ? `${details.preset.name} · revisions` : ''}
      >
        <ol className="divide-y divide-line">
          {details?.revisions.map((revision) => (
            <li key={revision.id} className="flex items-center justify-between gap-3 py-2">
              <div>
                <p className="text-sm font-medium text-ink">revision {revision.revisionNo}</p>
                <p className="text-xs text-ink-4">{revision.createdAt}</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={revision.revisionNo === details.preset.currentRevisionNo}
                onClick={() => void restore(revision.revisionNo)}
              >
                恢复为新 revision
              </Button>
            </li>
          ))}
        </ol>
      </Modal>
    </Card>
  )
}
