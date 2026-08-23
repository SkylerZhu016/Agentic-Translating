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
import { localizeDiagnosticError, useI18n } from '@/src/i18n'

export interface PresetPanelProps {
  endpoints: Endpoint[]
  notify: NotifyFn
  onPresetLoaded: () => Promise<void>
}

export function PresetPanel({ endpoints, notify, onPresetLoaded }: PresetPanelProps) {
  const { t } = useI18n()
  const apiErrorMessage = (error: unknown) =>
    isApiError(error)
      ? localizeDiagnosticError(t, error.payload, t('config.error.tryLater'))
      : t('config.error.networkRetry')
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
      notify(t('legacy.preset.loadListFailed'), { message: apiErrorMessage(e) })
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
      notify(t('legacy.preset.error.name'))
      return
    }
    if (createMode === 'copy' && copyFromId == null) {
      notify(t('legacy.preset.error.copySource'))
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
      notify(t('legacy.preset.created'), { tone: 'inverted' })
      setCreateOpen(false)
      await loadPresets()
    } catch (e) {
      notify(t('legacy.preset.createFailed'), { message: apiErrorMessage(e) })
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
      notify(t('legacy.preset.error.name'))
      return
    }
    setSavingEdit(true)
    try {
      await configApi.updatePreset(editTarget.id, {
        name: editName.trim(),
        description: editDescription.trim() || undefined,
      })
      notify(t('legacy.preset.updated'), { tone: 'inverted' })
      setEditTarget(null)
      await loadPresets()
    } catch (e) {
      notify(t('legacy.preset.updateFailed'), { message: apiErrorMessage(e) })
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
      notify(t('legacy.preset.deleted', { name: deleteTarget.name }), { tone: 'inverted' })
      setDeleteTarget(null)
      await loadPresets()
    } catch (e) {
      notify(t('legacy.preset.deleteFailed'), { message: apiErrorMessage(e) })
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
        notify(t('legacy.preset.loaded', { name: loadTarget.name }), { tone: 'inverted' })
        setLoadTarget(null)
        await onPresetLoaded()
      }
    } catch (e) {
      notify(t('legacy.preset.loadFailed'), { message: apiErrorMessage(e) })
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
        notify(t('legacy.preset.forceFailed'), {
          message: t('legacy.preset.notApplied'),
        })
        setLoadTarget(null)
        setLoadWarnings(null)
        return
      }
      notify(t('legacy.preset.forceLoaded', { name: loadTarget.name }), { tone: 'inverted' })
      setLoadTarget(null)
      setLoadWarnings(null)
      await onPresetLoaded()
    } catch (e) {
      notify(t('legacy.preset.loadFailed'), { message: apiErrorMessage(e) })
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
        name: t('legacy.preset.copyName', { name: preset.name }),
        fromPresetId: preset.id,
      })
      notify(t('legacy.preset.copied'), { tone: 'inverted' })
      await loadPresets()
    } catch (e) {
      notify(t('legacy.preset.copyFailed'), { message: apiErrorMessage(e) })
    }
  }

  return (
    <Card
      overline={t('legacy.preset.overline')}
      title={t('legacy.preset.title')}
      actions={
        <Button variant="outline" size="sm" onClick={openCreate}>
          {t('legacy.preset.new')}
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
            {t('legacy.preset.empty')}
          </p>
          <Button variant="outline" size="sm" onClick={openCreate} className="mt-3">
            {t('legacy.preset.new')}
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
                    {preset.is_builtin
                      ? t('legacy.prompt.builtin')
                      : t('legacy.prompt.custom')}
                  </Badge>
                </div>
                {preset.description && (
                  <p className="mt-0.5 text-xs leading-5 text-ink-3">{preset.description}</p>
                )}
              </div>
              <Button variant="ghost" size="sm" onClick={() => requestLoad(preset)}>
                {t('legacy.preset.load')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => copyPreset(preset)}>
                {t('legacy.preset.copy')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => openEdit(preset)}>
                {t('legacy.preset.edit')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => requestDelete(preset)}
                disabled={!!preset.is_builtin}
              >
                {t('common.delete')}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* 新建预设 */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t('legacy.preset.new')}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setCreateOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={() => void confirmCreate()} disabled={creating}>
              {creating && <Spinner size="sm" />}
              {t('common.create')}
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
          <Field label={t('legacy.preset.name')}>
            <Input
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder={t('legacy.preset.namePlaceholder')}
            />
          </Field>
          <Field label={t('legacy.preset.description')} hint={t('legacy.preset.optional')}>
            <Input
              value={createDescription}
              onChange={(e) => setCreateDescription(e.target.value)}
              placeholder={t('legacy.preset.descriptionPlaceholder')}
            />
          </Field>
          <Field label={t('legacy.preset.createMode')}>
            <Select
              value={createMode}
              onChange={(e) => setCreateMode(e.target.value as typeof createMode)}
            >
              <option value="empty">{t('legacy.preset.mode.empty')}</option>
              <option value="copy">{t('legacy.preset.mode.copy')}</option>
              <option value="current">{t('legacy.preset.mode.current')}</option>
            </Select>
          </Field>
          {createMode === 'copy' && (
            <Field label={t('legacy.preset.copySource')}>
              <Select
                value={copyFromId ?? ''}
                onChange={(e) =>
                  setCopyFromId(e.target.value === '' ? null : Number(e.target.value))
                }
              >
                <option value="">{t('legacy.preset.select')}</option>
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
        title={t('legacy.preset.editTitle')}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setEditTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={() => void confirmEdit()} disabled={savingEdit}>
              {savingEdit && <Spinner size="sm" />}
              {t('common.save')}
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
            <Field label={t('legacy.preset.name')}>
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder={t('legacy.preset.editNamePlaceholder')}
              />
            </Field>
            <Field label={t('legacy.preset.description')} hint={t('legacy.preset.optional')}>
              <Input
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder={t('legacy.preset.editDescriptionPlaceholder')}
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
        title={t('legacy.preset.deleteTitle')}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={() => void confirmDelete()} disabled={deleting}>
              {deleting && <Spinner size="sm" />}
              {t('legacy.preset.deleteConfirm')}
            </Button>
          </>
        }
      >
        {deleteTarget != null && (
          <p className="text-sm leading-6 text-ink-2">
            {t('legacy.preset.deleteDescription', { name: deleteTarget.name })}
          </p>
        )}
      </Modal>

      {/* 加载确认 */}
      <Modal
        open={loadTarget != null && loadWarnings == null}
        onClose={() => setLoadTarget(null)}
        title={t('legacy.preset.loadTitle')}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setLoadTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={() => void confirmLoad()} disabled={loadingPreset}>
              {loadingPreset && <Spinner size="sm" />}
              {t('legacy.preset.loadConfirm')}
            </Button>
          </>
        }
      >
        {loadTarget != null && (
          <p className="text-sm leading-6 text-ink-2">
            {t('legacy.preset.loadDescription', { name: loadTarget.name })}
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
        title={t('legacy.preset.orphanTitle')}
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
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={() => void forceLoad()} disabled={loadingPreset}>
              {loadingPreset && <Spinner size="sm" />}
              {t('legacy.preset.forceLoad')}
            </Button>
          </>
        }
      >
        {loadTarget != null && loadWarnings != null && (
          <div className="space-y-3 text-sm leading-6 text-ink-2">
            <p>{t('legacy.preset.orphanDescription', { name: loadTarget.name })}</p>
            <ul className="list-disc space-y-1 pl-5">
              {loadWarnings.map((w, i) => {
                const epName =
                  endpoints.find((e) => e.id === w.endpointId)?.name
                    ?? t('legacy.preset.endpointFallback', { id: w.endpointId })
                return (
                  <li key={i}>
                    {w.kind === 'orphan_endpoint'
                      ? t('legacy.preset.invalidEndpoint')
                      : w.kind} · {epName}
                    {w.agentIndex != null
                      ? t('legacy.preset.agentIndex', { index: w.agentIndex + 1 })
                      : ''}
                  </li>
                )
              })}
            </ul>
            <p>{t('legacy.preset.forceDescription')}</p>
          </div>
        )}
      </Modal>
    </Card>
  )
}
