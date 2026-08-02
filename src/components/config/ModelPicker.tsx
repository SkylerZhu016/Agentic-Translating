'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button, Input, Spinner } from '@/src/components/ui'

export interface ModelOption {
  id: string
  ownedBy: string | null
}

interface ModelsPayload {
  models?: ModelOption[]
  error?: string
  diagnosticId?: string
}

const modelCache = new Map<number, ModelOption[]>()
const pendingRequests = new Map<number, Promise<ModelOption[]>>()

async function fetchModels(endpointId: number, force = false) {
  if (!force) {
    const cached = modelCache.get(endpointId)
    if (cached) return cached
    const pending = pendingRequests.get(endpointId)
    if (pending) return pending
  }

  const request = fetch(`/api/endpoints/${endpointId}/models`, {
    cache: 'no-store',
  }).then(async (response) => {
    const payload = await response.json().catch(() => null) as ModelsPayload | null
    if (!response.ok) {
      throw new Error(
        `${payload?.error ?? '读取模型列表失败'}${
          payload?.diagnosticId ? `（诊断 ID：${payload.diagnosticId}）` : ''
        }`,
      )
    }
    const models = payload?.models ?? []
    modelCache.set(endpointId, models)
    return models
  }).finally(() => {
    pendingRequests.delete(endpointId)
  })

  pendingRequests.set(endpointId, request)
  return request
}

export function ModelPicker({
  endpointId,
  value,
  onChange,
  emptyLabel = '选择模型',
  ariaLabel = '模型',
  allowEmpty = true,
  disabled = false,
}: {
  endpointId: number | null
  value: string
  onChange: (value: string) => void
  emptyLabel?: string
  ariaLabel?: string
  allowEmpty?: boolean
  disabled?: boolean
}) {
  const [models, setModels] = useState<ModelOption[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [manual, setManual] = useState(false)

  async function load(force = false) {
    if (!endpointId) return
    setLoading(true)
    setError('')
    try {
      setModels(await fetchModels(endpointId, force))
    } catch (loadError) {
      setModels([])
      setError(
        loadError instanceof Error ? loadError.message : '读取模型列表失败',
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setManual(false)
    setModels(endpointId ? modelCache.get(endpointId) ?? [] : [])
    setError('')
    if (endpointId) void load()
    // endpointId is intentionally the only trigger. Model changes should not
    // refetch the provider catalogue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpointId])

  const hasCurrentValue = useMemo(
    () => Boolean(value && !models.some((model) => model.id === value)),
    [models, value],
  )

  if (manual) {
    return (
      <div className="space-y-1.5">
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2">
          <Input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="手动输入模型 ID"
            aria-label={ariaLabel}
            disabled={disabled}
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setManual(false)}
          >
            返回列表
          </Button>
        </div>
        <p className="min-h-4 text-[11px] leading-4 text-ink-4">
          仅在提供商未实现 /models 或模型未公开列出时使用。
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
        <div className="relative col-span-2 min-w-0 sm:col-span-1">
          <select
            value={value}
            onChange={(event) => onChange(event.target.value)}
            aria-label={ariaLabel}
            disabled={disabled || !endpointId || loading}
            className="h-9 w-full rounded-sm border border-line-2 bg-paper-raise px-2 pr-8 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-60"
          >
            {allowEmpty && <option value="">{emptyLabel}</option>}
            {hasCurrentValue && (
              <option value={value}>{value}（当前配置，列表中未返回）</option>
            )}
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.id}
              </option>
            ))}
          </select>
          {loading && (
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
              <Spinner size="sm" />
            </span>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!endpointId || loading}
          onClick={() => void load(true)}
          title="重新读取模型列表"
        >
          刷新
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setManual(true)}
        >
          手动
        </Button>
      </div>
      <div className="min-h-4 text-[11px] leading-4">
        {!endpointId && <p className="text-ink-4">请先选择端点。</p>}
        {endpointId && !loading && !error && models.length === 0 && (
          <p className="text-ink-4">
            端点没有返回可用模型，可以刷新或手动输入。
          </p>
        )}
        {error && (
          <p className="text-cinnabar">
            {error}；仍可手动输入模型 ID。
          </p>
        )}
      </div>
    </div>
  )
}
