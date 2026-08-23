'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button, Input, Spinner } from '@/src/components/ui'
import {
  localizeDiagnosticError,
  useI18n,
  type Translator,
} from '@/src/i18n'

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

async function fetchModels(endpointId: number, t: Translator, force = false) {
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
        `${localizeDiagnosticError(
          t,
          payload?.error,
          t('modelPicker.error.load'),
        )}${
          payload?.diagnosticId ? t('modelPicker.diagnostic', { id: payload.diagnosticId }) : ''
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
  emptyLabel,
  ariaLabel,
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
  const { t } = useI18n()
  const resolvedEmptyLabel = emptyLabel ?? t('modelPicker.empty')
  const resolvedAriaLabel = ariaLabel ?? t('modelPicker.aria')
  const [models, setModels] = useState<ModelOption[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [manual, setManual] = useState(false)

  async function load(force = false) {
    if (!endpointId) return
    setLoading(true)
    setError('')
    try {
      setModels(await fetchModels(endpointId, t, force))
    } catch (loadError) {
      setModels([])
      setError(
        loadError instanceof Error ? loadError.message : t('modelPicker.error.load'),
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
            placeholder={t('modelPicker.manual.placeholder')}
            aria-label={resolvedAriaLabel}
            disabled={disabled}
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setManual(false)}
          >
            {t('modelPicker.back')}
          </Button>
        </div>
        <p className="min-h-4 text-[11px] leading-4 text-ink-4">
          {t('modelPicker.manual.hint')}
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
            aria-label={resolvedAriaLabel}
            disabled={disabled || !endpointId || loading}
            className="h-9 w-full rounded-sm border border-line-2 bg-paper-raise px-2 pr-8 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-60"
          >
            {allowEmpty && <option value="">{resolvedEmptyLabel}</option>}
            {hasCurrentValue && (
              <option value={value}>{t('modelPicker.currentMissing', { model: value })}</option>
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
          title={t('modelPicker.refresh.title')}
        >
          {t('modelPicker.refresh')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setManual(true)}
        >
          {t('modelPicker.manual')}
        </Button>
      </div>
      <div className="min-h-4 text-[11px] leading-4">
        {!endpointId && <p className="text-ink-4">{t('modelPicker.selectEndpoint')}</p>}
        {endpointId && !loading && !error && models.length === 0 && (
          <p className="text-ink-4">
            {t('modelPicker.none')}
          </p>
        )}
        {error && (
          <p role="alert" className="text-cinnabar">
            {t('modelPicker.manualFallback', { error })}
          </p>
        )}
      </div>
    </div>
  )
}
