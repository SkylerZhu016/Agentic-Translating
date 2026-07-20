'use client'

// ---------------------------------------------------------------------------
// 预设管理面板 —— 列表 / 新建（Modal）/ 编辑（Modal）/ 加载确认 / 删除确认
// 加载闭环：确认 → POST /load → 警告 → orphan modal → force 加载
// 内置预设：删除按钮禁用；自定义预设可完整操作
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react'
import { Badge, Button, Card, Input, Modal, Spinner } from '@/src/components/ui'
import type { ConfigPresetRow } from '@/src/lib/contracts/types'
import { configApi, isApiError, type Endpoint, type LoadPresetResult } from './api'
import { Field, Select, Skeleton, type NotifyFn } from './shared'

export interface PresetPanelProps {
  endpoints: Endpoint[]
  notify: NotifyFn
  onPresetLoaded: () => Promise<void>
}

export function PresetPanel({ endpoints, notify, onPresetLoaded }: PresetPanelProps) {
  const [presets, setPresets] = useState<ConfigPresetRow[]>([])
  const [loading, setLoading] = useState(true)

  // ── 新建表单 ──
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const [createMode, setCreateMode] = useState<'empty' | 'copy' | 'current'>('empty')
  const [copyFromId, setCopyFromId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)

  // ── 编辑表单 ──
  const [editTarget, setEditTarget] = useState<ConfigPresetRow | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)

  // ── 删除确认 ──
  const [deleteTarget, setDeleteTarget] = useState<ConfigPresetRow | null>(null)
  const [deleting, setDeleting] = useState(false)

  // ── 加载闭环 ──
  const [loadTarget, setLoadTarget] = useState<ConfigPresetRow | null>(null)
  const [loadWarnings, setLoadWarnings] = useState<LoadPresetResult['warnings'] | null>(null)
  const [loadingPreset, setLoadingPreset] = useState(false)

  async function loadPresets() {
    setLoading(true)
    try {
      const list = await configApi.listPresets()
      setPresets(list)
    } catch (e) {
      notify('加载预设失败', { message: isApiError(e) ? e.message : '网络错误，请重试' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadPresets()
  }, [])

  // ── 新建 ──
  function openCreate() {
    setCreateName('')
    setCreateDescription('')
    setCreateMode('empty')
    setCopyFromId(null)
    setCreateOpen(true)
  }

  async function confirmCreate() {
    if (createName.trim().length === 0) {
      notify('请输入预设名称')
      return
    }
    if (createMode === 'copy' && copyFromId == null) {
      notify('请选择要复制的预设')
      return
    }
    setCreating(true)
    try {
      await configApi.createPreset({
        name: createName.trim(),
        description: createDescription.trim() || undefined,
        ...(createMode === 'copy' && copyFromId != null ? { fromPresetId: copyFromId } : {}),
        ...(createMode === 'current' ? { fromCurrentConfig: true } : {}),
      })
      notify('预设已创建', { tone: 'inverted' })
      setCreateOpen(false)
      await loadPresets()
    } catch (e) {
      notify('创建失败', { message: isApiError(e) ? e.message : '网络错误，请重试' })
    } finally {
      setCreating(false)
    }
  }

  // ── 编辑 ──
  function openEdit(preset: ConfigPresetRow) {
    setEditTarget(preset)
    setEditName(preset.name)
    setEditDescription(preset.description ?? '')
    setSavingEdit(false)
  }

  async function confirmEdit() {
    if (!editTarget) return
    if (editName.trim().length === 0) {
      notify('请输入预设名称')
      return
    }
    setSavingEdit(true)
    try {
      await configApi.updatePreset(editTarget.id, {
        name: editName.trim(),
        description: editDescription.trim() || undefined,
      })
      notify('预设已更新', { tone: 'inverted' })
      setEditTarget(null)
      await loadPresets()
    } catch (e) {
      notify('更新失败', { message: isApiError(e) ? e.message : '网络错误，请重试' })
    } finally {
      setSavingEdit(false)
    }
  }

  // ── 删除 ──
  function requestDelete(preset: ConfigPresetRow) {
    setDeleteTarget(preset)
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await configApi.deletePreset(deleteTarget.id)
      notify(`预设「${deleteTarget.name}」已删除`, { tone: 'inverted' })
      setDeleteTarget(null)
      await loadPresets()
    } catch (e) {
      notify('删除失败', { message: isApiError(e) ? e.message : '网络错误，请重试' })
      setDeleteTarget(null)
    } finally {
      setDeleting(false)
    }
  }

  // ── 加载 ──
  function requestLoad(preset: ConfigPresetRow) {
    setLoadTarget(preset)
    setLoadWarnings(null)
  }

  async function confirmLoad() {
    if (!loadTarget) return
    setLoadingPreset(true)
    try {
      const result = await configApi.loadPreset(loadTarget.id)
      if (result.warnings && result.warnings.length > 0) {
        setLoadWarnings(result.warnings)
      } else {
        notify(`预设「${loadTarget.name}」已加载`, { tone: 'inverted' })
        setLoadTarget(null)
        await onPresetLoaded()
      }
    } catch (e) {
      notify('加载失败', { message: isApiError(e) ? e.message : '网络错误，请重试' })
      setLoadTarget(null)
    } finally {
      setLoadingPreset(false)
    }
  }

  async function forceLoad() {
    if (!loadTarget) return
    setLoadingPreset(true)
    try {
      const result = await configApi.loadPreset(loadTarget.id, true)
      if (!result.applied) {
        notify('强制加载失败', { message: '服务器未应用预设，请重试' })
        setLoadTarget(null)
        setLoadWarnings(null)
        return
      }
      notify(`预设「${loadTarget.name}」已强制加载`, { tone: 'inverted' })
      setLoadTarget(null)
      setLoadWarnings(null)
      await onPresetLoaded()
    } catch (e) {
      notify('加载失败', { message: isApiError(e) ? e.message : '网络错误，请重试' })
      setLoadTarget(null)
      setLoadWarnings(null)
    } finally {
      setLoadingPreset(false)
    }
  }

  // ── 复制 ──
  async function copyPreset(preset: ConfigPresetRow) {
    try {
      await configApi.createPreset({
        name: `${preset.name} 副本`,
        fromPresetId: preset.id,
      })
      notify('预设已复制', { tone: 'inverted' })
      await loadPresets()
    } catch (e) {
      notify('复制失败', { message: isApiError(e) ? e.message : '网络错误，请重试' })
    }
  }

  return (
    <Card
      overline="Presets"
      title="自定义预设"
      actions={
        <Button variant="outline" size="sm" onClick={openCreate}>
          新建预设
        </Button>
      }
    >
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-2/3" />
        </div>
      ) : presets.length === 0 ? (
        <div className="rounded-sm border border-dashed border-line-2 bg-paper/60 px-4 py-8 text-center">
          <p className="text-sm leading-6 text-ink-3">
            尚未添加预设。预设可保存当前全部配置，随时一键恢复。
          </p>
          <Button variant="outline" size="sm" onClick={openCreate} className="mt-3">
            新建预设
          </Button>
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {presets.map((preset) => (
            <li key={preset.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium text-ink">{preset.name}</p>
                  <Badge variant={preset.is_builtin ? 'solid' : 'outline'}>
                    {preset.is_builtin ? '内置' : '自定义'}
                  </Badge>
                </div>
                {preset.description && (
                  <p className="mt-0.5 text-xs leading-5 text-ink-3">{preset.description}</p>
                )}
              </div>
              <Button variant="ghost" size="sm" onClick={() => requestLoad(preset)}>
                加载
              </Button>
              <Button variant="ghost" size="sm" onClick={() => copyPreset(preset)}>
                复制
              </Button>
              <Button variant="ghost" size="sm" onClick={() => openEdit(preset)}>
                编辑
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => requestDelete(preset)}
                disabled={!!preset.is_builtin}
              >
                删除
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* 新建预设 */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="新建预设"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button size="sm" onClick={() => void confirmCreate()} disabled={creating}>
              {creating && <Spinner size="sm" />}
              创建
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void confirmCreate()
          }}
          className="space-y-4"
        >
          <Field label="名称">
            <Input
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder="如：五言诗歌翻译套装"
            />
          </Field>
          <Field label="描述" hint="可选">
            <Input
              value={createDescription}
              onChange={(e) => setCreateDescription(e.target.value)}
              placeholder="简要说明该预设的用途"
            />
          </Field>
          <Field label="创建方式">
            <Select
              value={createMode}
              onChange={(e) => setCreateMode(e.target.value as typeof createMode)}
            >
              <option value="empty">空预设</option>
              <option value="copy">复制自现有预设</option>
              <option value="current">另存为当前配置</option>
            </Select>
          </Field>
          {createMode === 'copy' && (
            <Field label="复制来源">
              <Select
                value={copyFromId ?? ''}
                onChange={(e) =>
                  setCopyFromId(e.target.value === '' ? null : Number(e.target.value))
                }
              >
                <option value="">请选择预设…</option>
                {presets.map((p) => (
                  <option key={p.id} value={String(p.id)}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
        </form>
      </Modal>

      {/* 编辑预设 */}
      <Modal
        open={editTarget != null}
        onClose={() => setEditTarget(null)}
        title="编辑预设"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setEditTarget(null)}>
              取消
            </Button>
            <Button size="sm" onClick={() => void confirmEdit()} disabled={savingEdit}>
              {savingEdit && <Spinner size="sm" />}
              保存
            </Button>
          </>
        }
      >
        {editTarget != null && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void confirmEdit()
            }}
            className="space-y-4"
          >
            <Field label="名称">
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="预设名称"
              />
            </Field>
            <Field label="描述" hint="可选">
              <Input
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder="预设描述"
              />
            </Field>
            <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
          </form>
        )}
      </Modal>

      {/* 删除确认 */}
      <Modal
        open={deleteTarget != null}
        onClose={() => setDeleteTarget(null)}
        title="删除预设"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button size="sm" onClick={() => void confirmDelete()} disabled={deleting}>
              {deleting && <Spinner size="sm" />}
              确认删除
            </Button>
          </>
        }
      >
        {deleteTarget != null && (
          <p className="text-sm leading-6 text-ink-2">
            确定删除预设「{deleteTarget.name}」吗？此操作不可撤销。
          </p>
        )}
      </Modal>

      {/* 加载确认 */}
      <Modal
        open={loadTarget != null && loadWarnings == null}
        onClose={() => setLoadTarget(null)}
        title="加载预设"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setLoadTarget(null)}>
              取消
            </Button>
            <Button size="sm" onClick={() => void confirmLoad()} disabled={loadingPreset}>
              {loadingPreset && <Spinner size="sm" />}
              确认加载
            </Button>
          </>
        }
      >
        {loadTarget != null && (
          <p className="text-sm leading-6 text-ink-2">
            确定加载预设「{loadTarget.name}」吗？当前配置将被覆盖。
          </p>
        )}
      </Modal>

      {/* orphan 警告 */}
      <Modal
        open={loadTarget != null && loadWarnings != null}
        onClose={() => {
          setLoadTarget(null)
          setLoadWarnings(null)
        }}
        title="预设包含无效端点引用"
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setLoadTarget(null)
                setLoadWarnings(null)
              }}
            >
              取消
            </Button>
            <Button size="sm" onClick={() => void forceLoad()} disabled={loadingPreset}>
              {loadingPreset && <Spinner size="sm" />}
              强制加载
            </Button>
          </>
        }
      >
        {loadTarget != null && loadWarnings != null && (
          <div className="space-y-3 text-sm leading-6 text-ink-2">
            <p>预设「{loadTarget.name}」中的部分 Agent 引用了当前不存在的端点：</p>
            <ul className="list-disc space-y-1 pl-5">
              {loadWarnings.map((w, i) => {
                const epName =
                  endpoints.find((e) => e.id === w.endpointId)?.name ?? `端点 #${w.endpointId}`
                return (
                  <li key={i}>
                    {w.kind === 'orphan_endpoint' ? '无效端点' : w.kind}：{epName}
                    {w.agentIndex != null ? `（Agent #${w.agentIndex + 1}）` : ''}
                  </li>
                )
              })}
            </ul>
            <p>强制加载将跳过这些 Agent。是否继续？</p>
          </div>
        )}
      </Modal>
    </Card>
  )
}
