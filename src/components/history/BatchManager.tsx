'use client'

import { useEffect, useRef, useState } from 'react'
import { Badge, Button, Modal, Spinner } from '@/src/components/ui'
import { useDirection } from '@/src/components/direction/DirectionProvider'
import {
  localizeDiagnosticError,
  useI18n,
  type MessageKey,
} from '@/src/i18n'
import type { WorkflowPreset, WorkflowPresetRevision } from '@/src/lib/contracts/vnext'

interface BatchJobView {
  id: string
  name: string
  direction: string
  status: string
  concurrency: number
  total_count: number
  completed_count: number
  failed_count: number
  updated_at: string
}

interface PreparedFile {
  relativePath: string
  sourceText: string
  originalLineEnding: 'lf' | 'crlf'
  hadBom: boolean
}

const BATCH_STATUS_KEYS = {
  queued: 'batch.status.queued',
  running: 'batch.status.running',
  paused: 'batch.status.paused',
  failed: 'batch.status.failed',
  completed: 'batch.status.completed',
  cancelled: 'batch.status.cancelled',
} as const satisfies Record<string, MessageKey>

export function BatchManager() {
  const { direction } = useDirection()
  const { t, formatNumber } = useI18n()
  const [jobs, setJobs] = useState<BatchJobView[]>([])
  const [presets, setPresets] = useState<WorkflowPreset[]>([])
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [presetId, setPresetId] = useState('')
  const [revisionId, setRevisionId] = useState('')
  const [concurrency, setConcurrency] = useState(2)
  const [files, setFiles] = useState<PreparedFile[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [desktop, setDesktop] = useState(false)
  const [exportMessage, setExportMessage] = useState<string | null>(null)
  const folderInput = useRef<HTMLInputElement | null>(null)

  async function load() {
    const [jobsResponse, presetsResponse] = await Promise.all([
      fetch('/api/batches', { cache: 'no-store' }),
      fetch(`/api/workflow-presets?direction=${direction}`),
    ])
    if (jobsResponse.ok) setJobs(await jobsResponse.json())
    if (presetsResponse.ok) setPresets(await presetsResponse.json())
  }

  useEffect(() => {
    setDesktop(Boolean(window.agenticDesktop))
    void load()
    const timer = window.setInterval(() => void load(), 2000)
    return () => window.clearInterval(timer)
  }, [direction])

  useEffect(() => {
    folderInput.current?.setAttribute('webkitdirectory', '')
  }, [open])

  async function selectPreset(value: string) {
    setPresetId(value)
    setRevisionId('')
    if (!value) return
    const response = await fetch(`/api/workflow-presets/${encodeURIComponent(value)}`)
    if (!response.ok) return
    const payload = await response.json() as {
      preset: WorkflowPreset
      revisions: WorkflowPresetRevision[]
    }
    const revision = payload.revisions.find(
      (item) => item.revisionNo === payload.preset.currentRevisionNo,
    )
    setRevisionId(revision?.id ?? '')
  }

  async function prepareFiles(list: FileList | null) {
    if (!list) return
    setError(null)
    if (list.length > 500) {
      setError(t('batch.error.maxFiles', { count: formatNumber(500) }))
      return
    }
    const prepared: PreparedFile[] = []
    try {
      for (const file of Array.from(list)) {
        const relativePath =
          (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
          file.name
        if (!/\.(txt|md)$/i.test(relativePath)) continue
        if (file.size > 5 * 1024 * 1024) {
          throw new Error(t('batch.error.fileSize', { size: '5 MiB', path: relativePath }))
        }
        const bytes = new Uint8Array(await file.arrayBuffer())
        const hadBom =
          bytes.length >= 3 &&
          bytes[0] === 0xef &&
          bytes[1] === 0xbb &&
          bytes[2] === 0xbf
        let sourceText: string
        try {
          sourceText = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        } catch {
          throw new Error(t('batch.error.invalidUtf8', { path: relativePath }))
        }
        prepared.push({
          relativePath: relativePath.replace(/\\/g, '/'),
          sourceText,
          originalLineEnding: sourceText.includes('\r\n') ? 'crlf' : 'lf',
          hadBom,
        })
      }
      if (prepared.length === 0) throw new Error(t('batch.error.noFiles'))
      setFiles(prepared)
    } catch (prepareError) {
      setError(prepareError instanceof Error ? prepareError.message : t('batch.error.read'))
    }
  }

  async function prepareNativeFiles(kind: 'files' | 'folder') {
    const bridge = window.agenticDesktop
    if (!bridge) return
    setError(null)
    const result =
      kind === 'files'
        ? await bridge.selectFiles()
        : await bridge.selectFolder()
    if (result.canceled) return
    if (result.error) {
      setError(result.error)
      return
    }
    if (result.files.length === 0) {
      setError(t('batch.error.noFiles'))
      return
    }
    setFiles(result.files)
  }

  async function create() {
    if (!name.trim() || !revisionId || files.length === 0) {
      setError(t('batch.error.required'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          presetRevisionId: revisionId,
          concurrency,
          files,
        }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as {
          error?: string
        } | null
        throw new Error(localizeDiagnosticError(
          t,
          payload?.error,
          t('batch.error.create'),
        ))
      }
      setOpen(false)
      setName('')
      setPresetId('')
      setRevisionId('')
      setFiles([])
      await load()
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : t('batch.error.create'))
    } finally {
      setBusy(false)
    }
  }

  async function action(id: string, actionName: string) {
    await fetch(`/api/batches/${encodeURIComponent(id)}/${actionName}`, {
      method: 'POST',
    })
    await load()
  }

  async function exportBatch(id: string) {
    const bridge = window.agenticDesktop
    if (!bridge) return
    setExportMessage(null)
    try {
      const result = await bridge.exportBatch(id, true)
      if (result.outputDirectory) {
        setExportMessage(t('batch.exported', { path: result.outputDirectory }))
      }
    } catch (exportError) {
      setExportMessage(
        exportError instanceof Error ? exportError.message : t('batch.error.export'),
      )
    }
  }

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          {t('batch.new')}
        </Button>
      </div>
      {exportMessage && (
        <p className="mb-3 rounded-sm border border-line bg-paper px-3 py-2 text-xs text-ink-2">
          {exportMessage}
        </p>
      )}
      {jobs.length === 0 ? (
        <div className="rounded-sm border border-dashed border-line-2 p-8 text-center text-sm text-ink-4">
          {t('batch.empty')}
        </div>
      ) : (
        <ol className="divide-y divide-line">
          {jobs.map((job) => (
            <li key={job.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-ink">{job.name}</p>
                    <Badge variant="subtle">
                      {job.status in BATCH_STATUS_KEYS
                        ? t(BATCH_STATUS_KEYS[job.status as keyof typeof BATCH_STATUS_KEYS])
                        : job.status}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-ink-3">
                    {t('batch.progress', {
                      complete: formatNumber(job.completed_count),
                      total: formatNumber(job.total_count),
                      failed: formatNumber(job.failed_count),
                      concurrency: formatNumber(job.concurrency),
                    })}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1">
                  {job.status === 'running' && (
                    <Button variant="ghost" size="sm" onClick={() => void action(job.id, 'pause')}>{t('batch.action.pause')}</Button>
                  )}
                  {['paused', 'failed'].includes(job.status) && (
                    <Button variant="ghost" size="sm" onClick={() => void action(job.id, 'resume')}>{t('batch.action.resume')}</Button>
                  )}
                  {job.failed_count > 0 && (
                    <Button variant="ghost" size="sm" onClick={() => void action(job.id, 'retry-failed')}>{t('batch.action.retryFailed')}</Button>
                  )}
                  {!['completed', 'cancelled'].includes(job.status) && (
                    <Button variant="ghost" size="sm" onClick={() => void action(job.id, 'cancel')}>{t('batch.action.cancel')}</Button>
                  )}
                  {desktop ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void exportBatch(job.id)}
                    >
                      {t('batch.action.exportFolder')}
                    </Button>
                  ) : (
                    <Button
                      href={`/api/batches/${encodeURIComponent(job.id)}/export?audit=1`}
                      variant="outline"
                      size="sm"
                    >
                      {t('batch.action.exportZip')}
                    </Button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t('batch.new')}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button size="sm" disabled={busy} onClick={() => void create()}>
              {busy && <Spinner size="sm" />}{t('batch.create')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('batch.name.placeholder')}
            aria-label={t('batch.name.placeholder')}
            className="h-9 w-full rounded-sm border border-line-2 bg-paper-raise px-3 text-sm"
          />
          <select
            value={presetId}
            onChange={(event) => void selectPreset(event.target.value)}
            className="h-9 w-full rounded-sm border border-line-2 bg-paper-raise px-2 text-sm"
          >
            <option value="">{t('batch.preset.select')}</option>
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {t('batch.preset.revision', {
                  name: preset.name,
                  revision: formatNumber(preset.currentRevisionNo),
                })}
              </option>
            ))}
          </select>
          <label className="block text-xs text-ink-3">
            {t('batch.concurrency', { count: formatNumber(concurrency) })}
            <input
              type="range"
              min={1}
              max={4}
              value={concurrency}
              onChange={(event) => setConcurrency(Number(event.target.value))}
              className="mt-2 w-full accent-ink"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {desktop ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void prepareNativeFiles('files')}
                >
                  {t('batch.selectFiles')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void prepareNativeFiles('folder')}
                >
                  {t('batch.selectFolder')}
                </Button>
              </>
            ) : (
              <>
                <label className="inline-flex h-8 cursor-pointer items-center rounded-sm border border-line-2 bg-paper-raise px-3 text-sm text-ink">
                  {t('batch.selectFiles')}
                  <input
                    type="file"
                    multiple
                    accept=".txt,.md,text/plain,text/markdown"
                    className="hidden"
                    onChange={(event) => void prepareFiles(event.target.files)}
                  />
                </label>
                <label className="inline-flex h-8 cursor-pointer items-center rounded-sm border border-line-2 bg-paper-raise px-3 text-sm text-ink">
                  {t('batch.selectFolder')}
                  <input
                    ref={folderInput}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(event) => void prepareFiles(event.target.files)}
                  />
                </label>
              </>
            )}
            <span className="self-center text-xs text-ink-4">
              {t('batch.selectedFiles', { count: formatNumber(files.length) })}
            </span>
          </div>
          {error && <p role="alert" className="text-sm text-cinnabar">{error}</p>}
        </div>
      </Modal>
    </div>
  )
}
