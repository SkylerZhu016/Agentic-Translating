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
import {
  localizeDiagnosticError,
  useI18n,
  type MessageKey,
} from '@/src/i18n'

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
  const { t } = useI18n()
  return (
    <div className="mt-3 space-y-2 rounded-sm border border-line bg-paper px-3 py-3">
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-ink-4">
          {t('agentLibrary.output.body')}
        </p>
        <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap text-xs leading-5 text-ink-2">
          {result.body}
        </pre>
      </div>
      {result.annotation && (
        <details className="border-t border-line pt-2">
          <summary className="cursor-pointer text-xs text-ink-3">
            {t('agentLibrary.output.annotation')}
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
  const { t } = useI18n()
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
      if (!response.ok) throw new Error(t('agentLibrary.error.saveConfig'))
      notify(t('agentLibrary.savedConfig'), { tone: 'inverted' })
      await onChanged()
    } catch (error) {
      notify(t('config.error.save'), {
        message: error instanceof Error ? error.message : t('config.error.tryLater'),
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
      notify(t('agentLibrary.test.require'))
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
          ? t('modelPicker.diagnostic', { id: payload.diagnosticId })
          : ''
        throw new Error(`${localizeDiagnosticError(
          t,
          payload.error,
          t('agentLibrary.test.callFailed'),
        )}${diagnostic}`)
      }
      setResult({
        raw: payload.raw,
        body: payload.body ?? '',
        annotation: payload.annotation ?? null,
      })
    } catch (error) {
      setTestError(error instanceof Error ? error.message : t('agentLibrary.test.callFailed'))
    } finally {
      setTesting(false)
    }
  }

  return (
    <details className="mt-3 rounded-sm border border-line bg-paper/55">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-ink-2">
        {t('agentLibrary.variant.settings')}
        <span className="ml-2 font-normal text-ink-4">
          {variant.modelOverride
            ? t('agentLibrary.variant.current', { model: variant.modelOverride })
            : t('agentLibrary.variant.followDefault', {
                model: defaultBinding.model
                  ? t('agentLibrary.variant.defaultModelDetail', { model: defaultBinding.model })
                  : '',
              })}
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
          {t('agentLibrary.variant.enabled')}
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <select
            value={endpointId}
            onChange={(event) => {
              setEndpointId(event.target.value)
              setModel('')
            }}
            className="h-9 rounded-sm border border-line-2 bg-paper-raise px-2 text-sm"
            aria-label={t('agentLibrary.variant.endpointAria', { name: variant.catalogName })}
          >
            <option value="">{t('agentLibrary.variant.defaultEndpoint')}</option>
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
                ? t('agentLibrary.variant.defaultModel', { model: defaultBinding.model })
                : t('agentLibrary.variant.defaultWorkflowModel')
            }
            ariaLabel={t('agentLibrary.variant.modelAria', { name: variant.catalogName })}
          />
        </div>
        {!builtin && (
          <>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-label={t('agentLibrary.custom.nameAria')}
            />
            <Textarea
              rows={2}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              aria-label={t('agentLibrary.custom.descriptionAria')}
            />
            <Textarea
              rows={6}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              aria-label={t('agentLibrary.custom.promptAria')}
            />
          </>
        )}
        <Button size="sm" disabled={saving} onClick={() => void save()}>
          {saving && <Spinner size="sm" />}{t('agentLibrary.variant.save')}
        </Button>
        <div className="space-y-2 border-t border-line pt-3">
          <div>
            <p className="text-xs font-medium text-ink">{t('agentLibrary.test.title')}</p>
            <p className="mt-1 text-xs leading-5 text-ink-4">
              {t('agentLibrary.test.description')}
            </p>
          </div>
          <Textarea
            rows={3}
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder={t('agentLibrary.test.sourcePlaceholder')}
            aria-label={t('agentLibrary.test.sourceAria', { name: variant.catalogName })}
          />
          <Textarea
            rows={2}
            value={taskBrief}
            onChange={(event) => setTaskBrief(event.target.value)}
            placeholder={t('agentLibrary.test.taskPlaceholder')}
            aria-label={t('agentLibrary.test.taskAria', { name: variant.catalogName })}
          />
          <Textarea
            rows={2}
            value={additionalInstruction}
            onChange={(event) => setAdditionalInstruction(event.target.value)}
            placeholder={t('agentLibrary.test.extraPlaceholder')}
            aria-label={t('agentLibrary.test.extraAria', { name: variant.catalogName })}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={testing}
            onClick={() => void testAgent()}
          >
            {testing && <Spinner size="sm" />}{t('agentLibrary.test.run')}
          </Button>
          {testError && (
            <p role="alert" className="rounded-sm border border-cinnabar/30 bg-cinnabar/5 px-3 py-2 text-xs text-cinnabar">
              {testError}
            </p>
          )}
          {result && <IndependentTestOutput result={result} />}
        </div>
      </div>
    </details>
  )
}

type ProfileRole =
  | 'defaultWorker'
  | 'mainAgent'
  | 'reviewAgent'
  | 'filterAgent'
  | 'orchestrateAgent'
  | 'assembleAgent'
  | 'editingAgent'

const PROFILE_ROLES = [
  ['defaultWorker', 'agentLibrary.role.defaultWorker', 'agentLibrary.role.defaultWorkerHint'],
  ['mainAgent', 'agentLibrary.role.main', 'agentLibrary.role.mainHint'],
  ['reviewAgent', 'agentLibrary.role.review', 'agentLibrary.role.reviewHint'],
  ['filterAgent', 'agentLibrary.role.filter', 'agentLibrary.role.filterHint'],
  ['orchestrateAgent', 'agentLibrary.role.orchestrate', 'agentLibrary.role.orchestrateHint'],
  ['assembleAgent', 'agentLibrary.role.assemble', 'agentLibrary.role.assembleHint'],
  ['editingAgent', 'agentLibrary.role.editing', 'agentLibrary.role.editingHint'],
] as const satisfies ReadonlyArray<readonly [ProfileRole, MessageKey, MessageKey]>

export function AgentLibraryPanel({ notify }: { notify: NotifyFn }) {
  const { direction } = useDirection()
  const { t, formatDuration } = useI18n()
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
  const [testingRole, setTestingRole] = useState<ProfileRole | null>(null)
  const [roleTestStatus, setRoleTestStatus] = useState<
    Partial<Record<ProfileRole, { message: string; success: boolean }>>
  >({})

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
      if (!response.ok) throw new Error(t('agentLibrary.profile.error.save'))
      setProfile(await response.json())
      notify(t('agentLibrary.profile.saved'), { tone: 'inverted' })
    } catch (error) {
      notify(t('config.error.save'), {
        message: error instanceof Error ? error.message : t('config.error.tryLater'),
      })
    } finally {
      setProfileSaving(false)
    }
  }

  async function testProfileBinding(
    key: ProfileRole,
    label: string,
  ) {
    const binding = profile[key]
    if (!binding.endpointId || !binding.model.trim()) {
      setRoleTestStatus((current) => ({
        ...current,
        [key]: { message: t('agentLibrary.profile.selectFirst'), success: false },
      }))
      return
    }
    setTestingRole(key)
    setRoleTestStatus((current) => ({
      ...current,
      [key]: { message: t('agentLibrary.profile.testing'), success: true },
    }))
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
          `${localizeDiagnosticError(
            t,
            payload?.error,
            t('agentLibrary.profile.testFailed'),
          )}${
            payload?.diagnosticId ? t('modelPicker.diagnostic', { id: payload.diagnosticId }) : ''
          }`,
        )
      }
      setRoleTestStatus((current) => ({
        ...current,
        [key]: {
          message: t('agentLibrary.profile.success', {
            latency: formatDuration(payload?.latencyMs ?? 0),
          }),
          success: true,
        },
      }))
    } catch (error) {
      setRoleTestStatus((current) => ({
        ...current,
        [key]: {
          message: error instanceof Error
            ? error.message
            : t('agentLibrary.profile.testFailedRole', { role: label }),
          success: false,
        },
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
      notify(t('agentLibrary.clone.failed'))
      return
    }
    notify(t('agentLibrary.cloned'), { tone: 'inverted' })
    await load()
  }

  async function remove(archetypeId: string) {
    const response = await fetch(`/api/agent-catalog/${encodeURIComponent(archetypeId)}`, {
      method: 'DELETE',
    })
    if (!response.ok) {
      notify(t('agentLibrary.delete.failed'))
      return
    }
    notify(t('agentLibrary.deleted'), { tone: 'inverted' })
    await load()
  }

  async function create() {
    if (!name.trim() || !description.trim() || !prompt.trim()) {
      notify(t('agentLibrary.custom.require'))
      return
    }
    if (both && (!otherDescription.trim() || !otherPrompt.trim())) {
      notify(t('agentLibrary.custom.requireBoth'))
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
      if (!response.ok) throw new Error(t('config.error.save'))
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
      notify(t('agentLibrary.custom.created'), { tone: 'inverted' })
      await load()
    } catch (error) {
      notify(t('config.error.save'), {
        message: error instanceof Error ? error.message : t('config.error.tryLater'),
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
      notify(t('agentLibrary.preview.requirePrompt'))
      return
    }
    if (!previewSource.trim() || !effectiveEndpointId || !effectiveModel) {
      notify(t('agentLibrary.preview.require'))
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
          ? t('modelPicker.diagnostic', { id: payload.diagnosticId })
          : ''
        throw new Error(`${localizeDiagnosticError(
          t,
          payload.error,
          t('agentLibrary.preview.failed'),
        )}${diagnostic}`)
      }
      setPreviewResult({
        raw: payload.raw,
        body: payload.body ?? '',
        annotation: payload.annotation ?? null,
      })
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : t('agentLibrary.preview.failed'))
    } finally {
      setPreviewTesting(false)
    }
  }

  return (
    <Card
      overline={t('agentLibrary.overline')}
      title={t('agentLibrary.title', {
        direction: direction === 'en_to_zh'
          ? t('history.filter.enToZh')
          : t('history.filter.zhToEn'),
      })}
      actions={
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          {t('agentLibrary.new')}
        </Button>
      }
    >
      <details className="mb-4 rounded-sm border border-line bg-paper/55" open>
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-ink-2">
          {t('agentLibrary.profile.title')}
        </summary>
        <div className="space-y-3 border-t border-line px-3 py-3">
          {PROFILE_ROLES.map(([key, labelKey, hintKey]) => {
            const label = t(labelKey)
            return (
            <div
              key={key}
              className="grid min-w-0 gap-3 border-b border-line/70 pb-3 last:border-b-0 last:pb-0 md:grid-cols-[minmax(8rem,0.55fr)_minmax(0,1.8fr)] md:items-start"
            >
              <div>
                <p className="text-xs font-medium text-ink">{label}</p>
                <p className="text-xs text-ink-4">{t(hintKey)}</p>
              </div>
              <div className="grid min-w-0 gap-2 xl:grid-cols-[minmax(7rem,0.7fr)_minmax(0,1.7fr)_4rem] xl:items-start">
                <select
                  value={profile[key].endpointId?.toString() ?? ''}
                  aria-label={t('agentLibrary.role.endpointAria', { role: label })}
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
                  <option value="">{t('agentLibrary.role.unconfigured')}</option>
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
                  emptyLabel={t('modelPicker.empty')}
                  ariaLabel={t('agentLibrary.role.modelAria', { role: label })}
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
                    {t('agentLibrary.role.test')}
                  </Button>
                  <p
                    className={`mt-1 min-h-4 break-words text-[10px] leading-4 ${
                      roleTestStatus[key]?.success
                        ? 'text-ink-4'
                        : 'text-cinnabar'
                    }`}
                  >
                    {roleTestStatus[key]?.message ?? ''}
                  </p>
                </div>
              </div>
            </div>
            )
          })}
          <Button
            size="sm"
            variant="outline"
            disabled={profileSaving}
            onClick={() => void saveProfile()}
          >
            {profileSaving && <Spinner size="sm" />}{t('agentLibrary.profile.save')}
          </Button>
        </div>
      </details>
      <Input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={t('agentLibrary.search.placeholder')}
        aria-label={t('agentLibrary.search.aria')}
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
                      {archetype?.isBuiltin
                        ? t('agentLibrary.badge.builtin')
                        : t('agentLibrary.badge.custom')}
                    </Badge>
                    <Badge variant="subtle">{archetype?.category ?? 'custom'}</Badge>
                    <Badge variant={variant.modelOverride ? 'outline' : 'subtle'}>
                      {variant.modelOverride
                        ? t('agentLibrary.badge.independent', { model: variant.modelOverride })
                        : t('agentLibrary.badge.default')}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-ink-3">
                    {variant.catalogDescription}
                  </p>
                  {archetype?.isBuiltin && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-ink-3">
                        {t('agentLibrary.prompt.readonly')}
                      </summary>
                      <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-sm border border-line bg-paper px-3 py-2 text-xs leading-5 text-ink-2">
                        {variant.rolePrompt}
                      </pre>
                    </details>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="sm" onClick={() => void clone(variant.id)}>
                    {t('agentLibrary.clone')}
                  </Button>
                  {!archetype?.isBuiltin && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void remove(variant.archetypeId)}
                    >
                      {t('config.action.delete')}
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
        title={t('agentLibrary.new')}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              {t('config.action.cancel')}
            </Button>
            <Button size="sm" disabled={saving} onClick={() => void create()}>
              {saving && <Spinner size="sm" />}{t('config.action.save')}
            </Button>
          </>
        }
        className="max-w-2xl"
      >
        <div className="space-y-4">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('agentLibrary.custom.namePlaceholder')}
          />
          <label className="flex items-center justify-between gap-3 text-sm text-ink-2">
            {t('agentLibrary.custom.category')}
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value as AgentCategory)}
              className="rounded-sm border border-line-2 bg-paper-raise px-2 py-1.5"
            >
              <option value="foundation">{t('agentLibrary.category.foundation')}</option>
              <option value="expression">{t('agentLibrary.category.expression')}</option>
              <option value="domain">{t('agentLibrary.category.domain')}</option>
              <option value="creative">{t('agentLibrary.category.creative')}</option>
              <option value="adversarial">{t('agentLibrary.category.adversarial')}</option>
            </select>
          </label>
          <Textarea
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t('agentLibrary.custom.descriptionPlaceholder')}
          />
          <Textarea
            rows={7}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={
              direction === 'en_to_zh'
                ? t('agentLibrary.custom.promptZh')
                : t('agentLibrary.custom.promptEn')
            }
          />
          <details className="rounded-sm border border-line bg-paper/55" open>
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-ink-2">
              {t('agentLibrary.preview.title')}
            </summary>
            <div className="space-y-2 border-t border-line px-3 py-3">
              <p className="text-xs leading-5 text-ink-4">
                {t('agentLibrary.preview.description')}
              </p>
              <Textarea
                rows={4}
                value={previewSource}
                onChange={(event) => setPreviewSource(event.target.value)}
                placeholder={t('agentLibrary.preview.sourcePlaceholder')}
                aria-label={t('agentLibrary.preview.sourceAria')}
              />
              <Textarea
                rows={2}
                value={previewTaskBrief}
                onChange={(event) => setPreviewTaskBrief(event.target.value)}
                placeholder={t('agentLibrary.test.taskPlaceholder')}
                aria-label={t('agentLibrary.preview.taskAria')}
              />
              <Textarea
                rows={2}
                value={previewInstruction}
                onChange={(event) => setPreviewInstruction(event.target.value)}
                placeholder={t('agentLibrary.test.extraPlaceholder')}
                aria-label={t('agentLibrary.preview.extraAria')}
              />
              <div className="grid gap-2 sm:grid-cols-2">
                <select
                  value={previewEndpointId}
                  onChange={(event) => {
                    setPreviewEndpointId(event.target.value)
                    setPreviewModel('')
                  }}
                  className="h-9 rounded-sm border border-line-2 bg-paper-raise px-2 text-sm"
                  aria-label={t('agentLibrary.preview.endpointAria')}
                >
                  <option value="">{t('agentLibrary.preview.defaultEndpoint')}</option>
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
                      ? t('agentLibrary.preview.defaultModel', { model: profile.defaultWorker.model })
                      : t('agentLibrary.preview.selectModel')
                  }
                  ariaLabel={t('agentLibrary.preview.modelAria')}
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={previewTesting}
                onClick={() => void previewCustomAgent()}
              >
                {previewTesting && <Spinner size="sm" />}{t('agentLibrary.test.run')}
              </Button>
              {previewError && (
                <p role="alert" className="rounded-sm border border-cinnabar/30 bg-cinnabar/5 px-3 py-2 text-xs text-cinnabar">
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
            {t('agentLibrary.custom.bothDirections')}
          </label>
          {both && (
            <>
              <Textarea
                rows={2}
                value={otherDescription}
                onChange={(event) => setOtherDescription(event.target.value)}
                placeholder={t('agentLibrary.custom.otherDescription')}
              />
              <Textarea
                rows={7}
                value={otherPrompt}
                onChange={(event) => setOtherPrompt(event.target.value)}
                placeholder={
                  direction === 'en_to_zh'
                    ? t('agentLibrary.custom.otherPromptEn')
                    : t('agentLibrary.custom.otherPromptZh')
                }
              />
            </>
          )}
        </div>
      </Modal>
    </Card>
  )
}
