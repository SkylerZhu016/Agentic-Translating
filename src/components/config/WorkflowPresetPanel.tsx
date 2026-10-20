'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Button, Card, Input, Modal, Spinner, Textarea } from '@/src/components/ui'
import { useDirection } from '@/src/components/direction/DirectionProvider'
import type {
  AgentDirectionVariant,
  CandidateAnnotationMode,
  ModelBinding,
  ReviewMode,
  TeamPolicy,
  WorkflowPreset,
  WorkflowPresetRevision,
} from '@/src/lib/contracts/vnext'
import type { Endpoint } from './api'
import type { NotifyFn } from './shared'
import { ModelPicker } from './ModelPicker'
import { MODEL_BUDGET_LAYOUT, OutputBudgetField, OutputBudgetHint, parseOutputBudget } from './OutputBudgetField'
import { useI18n, type MessageKey } from '@/src/i18n'

type ExecutionRole =
  | 'mainAgent'
  | 'reviewAgent'
  | 'filterAgent'
  | 'orchestrateAgent'
  | 'assembleAgent'
  | 'editingAgent'

const EMPTY_EXECUTION_BINDINGS: Record<ExecutionRole, ModelBinding> = {
  mainAgent: { endpointId: null, model: '' },
  reviewAgent: { endpointId: null, model: '' },
  filterAgent: { endpointId: null, model: '' },
  orchestrateAgent: { endpointId: null, model: '' },
  assembleAgent: { endpointId: null, model: '' },
  editingAgent: { endpointId: null, model: '' },
}

const EXECUTION_ROLES = [
  ['mainAgent', 'workflowPreset.role.main'],
  ['reviewAgent', 'workflowPreset.role.review'],
  ['filterAgent', 'workflowPreset.role.filter'],
  ['orchestrateAgent', 'workflowPreset.role.orchestrate'],
  ['assembleAgent', 'workflowPreset.role.assemble'],
  ['editingAgent', 'workflowPreset.role.editing'],
] as const satisfies ReadonlyArray<readonly [ExecutionRole, MessageKey]>

export function WorkflowPresetPanel({
  endpoints,
  notify,
}: {
  endpoints: Endpoint[]
  notify: NotifyFn
}) {
  const { direction } = useDirection()
  const { t, formatDate, formatNumber } = useI18n()
  const [presets, setPresets] = useState<WorkflowPreset[]>([])
  const [variants, setVariants] = useState<AgentDirectionVariant[]>([])
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [taskBrief, setTaskBrief] = useState('')
  const [model, setModel] = useState('')
  const [workerOutputBudget, setWorkerOutputBudget] = useState('')
  const [executionOutputBudgets, setExecutionOutputBudgets] = useState<Partial<Record<ExecutionRole, string>>>({})
  const [analysisOutputBudgetA, setAnalysisOutputBudgetA] = useState('')
  const [analysisOutputBudgetB, setAnalysisOutputBudgetB] = useState('')
  const [executionBindings, setExecutionBindings] = useState<
    Record<ExecutionRole, ModelBinding>
  >({ ...EMPTY_EXECUTION_BINDINGS })
  const [analysisModelA, setAnalysisModelA] = useState('')
  const [analysisModelB, setAnalysisModelB] = useState('')
  const [endpointId, setEndpointId] = useState<number | null>(null)
  const [teamPolicy, setTeamPolicy] = useState<TeamPolicy>('fixed')
  const [reviewMode, setReviewMode] = useState<ReviewMode>('main_editor')
  const [candidateAnnotationMode, setCandidateAnnotationMode] =
    useState<CandidateAnnotationMode>('body_only')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [details, setDetails] = useState<{
    preset: WorkflowPreset
    revisions: WorkflowPresetRevision[]
  } | null>(null)
  const loadGeneration = useRef(0)
  const loadController = useRef<AbortController | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [recoveringId, setRecoveringId] = useState<string | null>(null)
  const activePresets = presets.filter((preset) => !preset.deletedAt)
  const deletedPresets = presets.filter((preset) => preset.deletedAt)
  const invalidOutputBudget = [
    workerOutputBudget,
    ...EXECUTION_ROLES.map(([key]) => executionOutputBudgets[key] ?? ''),
    ...(analysisModelA.trim() ? [analysisOutputBudgetA] : []),
    ...(analysisModelB.trim() ? [analysisOutputBudgetB] : []),
  ].some((value) => parseOutputBudget(value) === undefined)

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current
    loadController.current?.abort()
    const controller = new AbortController()
    loadController.current = controller
    setLoading(true)
    setLoadError(null)
    try {
      const [presetResponse, catalogueResponse] = await Promise.all([
        fetch(`/api/workflow-presets?direction=${direction}&includeDeleted=1`, { signal: controller.signal }),
        fetch(`/api/agent-catalog?direction=${direction}`, { signal: controller.signal }),
      ])
      if (!presetResponse.ok || !catalogueResponse.ok) throw new Error(t('config.error.networkRetry'))
      const [nextPresets, payload] = await Promise.all([
        presetResponse.json() as Promise<WorkflowPreset[]>,
        catalogueResponse.json() as Promise<{ variants: AgentDirectionVariant[] }>,
      ])
      if (generation !== loadGeneration.current || controller.signal.aborted) return
      setPresets(nextPresets)
      setVariants(payload.variants)
      setSelectedIds((current) => {
        const validIds = new Set(payload.variants.map((variant) => variant.id))
        const compatible = current.filter((id) => validIds.has(id))
        return compatible.length >= 2
          ? compatible
          : payload.variants.slice(0, 2).map((variant) => variant.id)
      })
      setEndpointId((current) => endpoints.some((endpoint) => endpoint.id === current) ? current : endpoints[0]?.id ?? null)
    } catch (error) {
      if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : t('config.error.networkRetry'))
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [direction, endpoints, t])

  useEffect(() => {
    void load()
    return () => {
      loadGeneration.current += 1
      loadController.current?.abort()
    }
  }, [load])

  async function create() {
    if (invalidOutputBudget) {
      notify(t('outputBudget.error'))
      return
    }
    if (
      !name.trim() ||
      !model.trim() ||
      !endpointId ||
      Object.values(executionBindings).some(
        (binding) => !binding.endpointId || !binding.model.trim(),
      ) ||
      selectedIds.length < 2
    ) {
      notify(t('workflowPreset.error.required'))
      return
    }
    const snapshots = selectedIds
      .map((id) => variants.find((variant) => variant.id === id))
      .filter((variant): variant is AgentDirectionVariant => Boolean(variant))
    setSaving(true)
    try {
      const bundleResponse = await fetch(
        `/api/direction-prompt-bundles?direction=${encodeURIComponent(direction)}`,
        { cache: 'no-store' },
      )
      if (!bundleResponse.ok) throw new Error(t('config.error.networkRetry'))
      const bundle = await bundleResponse.json() as { version?: unknown }
      if (
        typeof bundle.version !== 'number' ||
        !Number.isInteger(bundle.version) ||
        bundle.version < 1
      ) {
        throw new Error(t('config.error.networkRetry'))
      }
      const binding = {
        endpointId,
        model: model.trim(),
        maxOutputTokens: parseOutputBudget(workerOutputBudget),
        contextWindow:
          endpoints.find((endpoint) => endpoint.id === endpointId)?.context_window ??
          null,
      }
      const contextAnalysisBindings = [
        [analysisModelA, analysisOutputBudgetA],
        [analysisModelB, analysisOutputBudgetB],
      ]
        .filter(([selectedModel]) => selectedModel.trim())
        .map(([selectedModel, outputBudget]) => ({
          ...binding,
          model: selectedModel.trim(),
          maxOutputTokens: parseOutputBudget(outputBudget),
        }))
      const roleBindings = Object.fromEntries(EXECUTION_ROLES.map(([key]) => [
        key,
        { ...executionBindings[key], maxOutputTokens: parseOutputBudget(executionOutputBudgets[key] ?? '') },
      ]))
      const response = await fetch('/api/workflow-presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          direction,
          contract: {
            // These labels are prompt-contract values and remain stable across UI locales.
            sourceLang: direction === 'en_to_zh' ? '英文' : '中文',
            targetLang: direction === 'en_to_zh' ? '中文' : '英文',
            taskBriefTemplate: taskBrief,
            teamPolicy,
            reviewMode,
            candidateAnnotationMode,
            agentVariantIds: selectedIds,
            agentVariantSnapshots: snapshots,
            defaultWorkerBinding: binding,
            agentBindingOverrides: {},
            mainAgentBinding: roleBindings.mainAgent,
            reviewAgentBinding: roleBindings.reviewAgent,
            filterAgentBinding: roleBindings.filterAgent,
            orchestrateAgentBinding: roleBindings.orchestrateAgent,
            assembleAgentBinding: roleBindings.assembleAgent,
            editingAgentBinding: roleBindings.editingAgent,
            contextAnalysisBindings,
            promptBundleVersion: bundle.version,
            maxAgentCalls: 5,
            batchConcurrency: 2,
            constraints: {},
          },
        }),
      })
      if (!response.ok) {
        throw new Error(t('workflowPreset.error.save'))
      }
      setOpen(false)
      setName('')
      setDescription('')
      setTaskBrief('')
      setModel('')
      setWorkerOutputBudget('')
      setExecutionOutputBudgets({})
      setAnalysisOutputBudgetA('')
      setAnalysisOutputBudgetB('')
      setCandidateAnnotationMode('body_only')
      setExecutionBindings({ ...EMPTY_EXECUTION_BINDINGS })
      setAnalysisModelA('')
      setAnalysisModelB('')
      notify(t('workflowPreset.created'), { tone: 'inverted' })
      await load()
    } catch (error) {
      notify(t('config.error.save'), {
        message: error instanceof Error ? error.message : t('config.error.tryLater'),
      })
    } finally {
      setSaving(false)
    }
  }

  async function inspect(preset: WorkflowPreset) {
    try {
      const response = await fetch(`/api/workflow-presets/${encodeURIComponent(preset.id)}`)
      if (!response.ok) throw new Error(t('config.error.networkRetry'))
      setDetails(await response.json())
    } catch (error) {
      notify(t('config.error.networkRetry'), { message: error instanceof Error ? error.message : t('config.error.tryLater') })
    }
  }

  async function restore(revisionNo: number) {
    if (!details) return
    try {
      const response = await fetch(
        `/api/workflow-presets/${encodeURIComponent(details.preset.id)}/restore`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ revisionNo }),
        },
      )
      if (!response.ok) throw new Error(t('workflowPreset.error.restore'))
      notify(t('workflowPreset.restored'), { tone: 'inverted' })
      await inspect(details.preset)
      await load()
    } catch (error) {
      notify(t('workflowPreset.error.restore'), { message: error instanceof Error ? error.message : t('config.error.networkRetry') })
    }
  }

  async function remove(preset: WorkflowPreset) {
    try {
      const response = await fetch(`/api/workflow-presets/${encodeURIComponent(preset.id)}`, { method: 'DELETE' })
      if (!response.ok) throw new Error(t('workflowPreset.error.delete'))
      notify(t('workflowPreset.deleted'), { tone: 'inverted' })
      await load()
    } catch (error) {
      notify(t('workflowPreset.error.delete'), { message: error instanceof Error ? error.message : t('config.error.networkRetry') })
    }
  }

  async function recover(preset: WorkflowPreset) {
    if (recoveringId) return
    setRecoveringId(preset.id)
    try {
      const response = await fetch(`/api/workflow-presets/${encodeURIComponent(preset.id)}/recover`, { method: 'POST' })
      if (!response.ok) throw new Error(t('workflowPreset.error.restore'))
      notify(t('workflowPreset.trash.restored'), { tone: 'inverted' })
      await load()
    } catch (error) {
      notify(t('workflowPreset.error.restore'), { message: error instanceof Error ? error.message : t('config.error.networkRetry') })
    } finally {
      setRecoveringId(null)
    }
  }

  return (
    <Card
      overline={t('workflowPreset.overline')}
      title={t('workflowPreset.title')}
      actions={
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          {t('workflowPreset.new')}
        </Button>
      }
    >
      {loadError && <div role="alert" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-sm border border-cinnabar/30 bg-cinnabar/5 p-3 text-sm text-cinnabar">
        <p>{loadError}</p><Button size="sm" variant="outline" onClick={() => void load()}>{t('common.retry')}</Button>
      </div>}
      {loading ? <div className="flex min-h-24 items-center justify-center"><Spinner /></div> : activePresets.length === 0 ? (
        <p className="rounded-sm border border-dashed border-line-2 p-5 text-center text-sm text-ink-4">
          {t('workflowPreset.empty')}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {activePresets.map((preset) => (
            <li key={preset.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium text-ink">{preset.name}</p>
                  <Badge variant="subtle">
                    {t('workflowPreset.revisionShort', { revision: formatNumber(preset.currentRevisionNo) })}
                  </Badge>
                </div>
                <p className="mt-1 line-clamp-1 text-xs text-ink-3">
                  {preset.description || t('workflowPreset.noDescription')}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => void inspect(preset)}>
                {t('workflowPreset.revisions')}
              </Button>
              <Button
                href={`/api/workflow-presets/${encodeURIComponent(preset.id)}/export`}
                variant="ghost"
                size="sm"
              >
                {t('workflowPreset.export')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void remove(preset)}>
                {t('config.action.delete')}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <details className="mt-4 rounded-sm border border-line bg-paper/55">
        <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium text-ink-3">
          {t('workflowPreset.trash')}
          <span className="ml-2 text-xs font-normal text-ink-4">{formatNumber(deletedPresets.length)}</span>
        </summary>
        <div className="border-t border-line px-3 py-3">
          <p className="mb-3 text-xs leading-5 text-ink-4">{t('workflowPreset.trash.description')}</p>
          {deletedPresets.length === 0 ? <p className="text-sm text-ink-4">{t('workflowPreset.trash.empty')}</p> : (
            <ul className="divide-y divide-line">
              {deletedPresets.map((preset) => <li key={preset.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">{preset.name}</p>
                  <p className="mt-1 text-xs text-ink-4">{t('workflowPreset.revisionShort', { revision: formatNumber(preset.currentRevisionNo) })}</p>
                </div>
                <Button size="sm" variant="outline" disabled={recoveringId !== null} onClick={() => void recover(preset)}>
                  {recoveringId === preset.id && <Spinner size="sm" />}{t('workflowPreset.trash.restore')}
                </Button>
              </li>)}
            </ul>
          )}
        </div>
      </details>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t('workflowPreset.newTitle')}
        className="sm:max-w-2xl"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>{t('config.action.cancel')}</Button>
            <Button size="sm" disabled={saving || invalidOutputBudget} onClick={() => void create()}>
              {saving && <Spinner size="sm" />}{t('workflowPreset.saveInitial')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('workflowPreset.name.placeholder')} />
          <Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t('workflowPreset.description.placeholder')} />
          <Textarea
            rows={3}
            value={taskBrief}
            onChange={(event) => setTaskBrief(event.target.value)}
            placeholder={t('workflowPreset.taskBrief.placeholder', {
              fileName: '{{file_name}}',
              relativePath: '{{relative_path}}',
            })}
          />
          <div className="space-y-3 rounded-sm border border-line p-3">
            <p className="text-xs font-medium text-ink">{t('workflowPreset.models.title')}</p>
            <OutputBudgetHint />
            <select
              value={endpointId ?? ''}
              onChange={(event) => {
                setEndpointId(Number(event.target.value) || null)
                setModel('')
                setAnalysisModelA('')
                setAnalysisModelB('')
              }}
              className="rounded-sm border border-line-2 bg-paper-raise px-2 py-2 text-sm"
            >
              <option value="">{t('workflowPreset.endpoint.select')}</option>
              {endpoints.map((endpoint) => (
                <option key={endpoint.id} value={endpoint.id}>{endpoint.name}</option>
              ))}
            </select>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className={MODEL_BUDGET_LAYOUT}>
                <ModelPicker
                  endpointId={endpointId}
                  value={model}
                  onChange={setModel}
                  emptyLabel={t('workflowPreset.model.worker')}
                  ariaLabel={t('workflowPreset.model.workerAria')}
                />
                <OutputBudgetField value={workerOutputBudget} onChange={setWorkerOutputBudget} role={t('workflowPreset.model.workerAria')} />
              </div>
              <div className={MODEL_BUDGET_LAYOUT}>
                <ModelPicker
                  endpointId={endpointId}
                  value={analysisModelA}
                  onChange={setAnalysisModelA}
                  emptyLabel={t('workflowPreset.model.analysisA')}
                  ariaLabel={t('workflowPreset.model.analysisA')}
                />
                {analysisModelA.trim() && <OutputBudgetField value={analysisOutputBudgetA} onChange={setAnalysisOutputBudgetA} role={t('workflowPreset.model.analysisA')} />}
              </div>
              <div className={MODEL_BUDGET_LAYOUT}>
                <ModelPicker
                  endpointId={endpointId}
                  value={analysisModelB}
                  onChange={setAnalysisModelB}
                  emptyLabel={t('workflowPreset.model.analysisB')}
                  ariaLabel={t('workflowPreset.model.analysisB')}
                />
                {analysisModelB.trim() && <OutputBudgetField value={analysisOutputBudgetB} onChange={setAnalysisOutputBudgetB} role={t('workflowPreset.model.analysisB')} />}
              </div>
            </div>
            <div className="space-y-2 border-t border-line pt-3">
              <p className="text-xs font-medium text-ink">{t('workflowPreset.roles.title')}</p>
              {EXECUTION_ROLES.map(([key, labelKey]) => {
                const role = executionBindings[key]
                const label = t(labelKey)
                return (
                  <div
                    key={key}
                    className="grid gap-2 sm:grid-cols-[7rem_minmax(10rem,0.8fr)_minmax(16rem,1.2fr)] sm:items-start"
                  >
                    <p className="pt-2 text-xs font-medium text-ink-2">{label}</p>
                    <select
                      value={role.endpointId ?? ''}
                      aria-label={t('workflowPreset.role.endpointAria', { role: label })}
                      onChange={(event) => {
                        const selectedEndpointId =
                          Number(event.target.value) || null
                        setExecutionBindings((current) => ({
                          ...current,
                          [key]: {
                            ...current[key],
                            endpointId: selectedEndpointId,
                            model: '',
                            contextWindow:
                              endpoints.find(
                                (item) => item.id === selectedEndpointId,
                              )?.context_window ?? null,
                          },
                        }))
                      }}
                      className="h-9 rounded-sm border border-line-2 bg-paper-raise px-2 text-sm"
                    >
                      <option value="">{t('workflowPreset.endpoint.select')}</option>
                      {endpoints.map((endpoint) => (
                        <option key={endpoint.id} value={endpoint.id}>
                          {endpoint.name}
                        </option>
                      ))}
                    </select>
                    <div className={MODEL_BUDGET_LAYOUT}>
                      <ModelPicker
                        endpointId={role.endpointId}
                        value={role.model}
                        onChange={(selectedModel) =>
                          setExecutionBindings((current) => ({
                            ...current,
                            [key]: { ...current[key], model: selectedModel },
                          }))
                        }
                        emptyLabel={t('workflowPreset.role.modelSelect', { role: label })}
                        ariaLabel={t('workflowPreset.role.modelAria', { role: label })}
                      />
                      <OutputBudgetField
                        value={executionOutputBudgets[key] ?? ''}
                        onChange={(value) => setExecutionOutputBudgets((current) => ({ ...current, [key]: value }))}
                        role={label}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
            <p className="text-xs leading-relaxed text-ink-4">
              {t('workflowPreset.analysis.hint')}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-ink-3">
              {t('workflowPreset.teamPolicy')}
              <select
                value={teamPolicy}
                onChange={(event) => setTeamPolicy(event.target.value as TeamPolicy)}
                className="mt-1 block w-full rounded-sm border border-line-2 bg-paper-raise px-2 py-2 text-sm text-ink"
              >
                <option value="fixed">{t('workflowPreset.teamPolicy.fixed')}</option>
                <option value="dynamic">{t('workflowPreset.teamPolicy.dynamic')}</option>
              </select>
            </label>
            <label className="text-xs text-ink-3">
              {t('workflowPreset.reviewMode')}
              <select
                value={reviewMode}
                onChange={(event) => setReviewMode(event.target.value as ReviewMode)}
                className="mt-1 block w-full rounded-sm border border-line-2 bg-paper-raise px-2 py-2 text-sm text-ink"
              >
                <option value="main_editor">{t('workflowPreset.reviewMode.mainEditor')}</option>
                <option value="four_stage">{t('workflowPreset.reviewMode.fourStage')}</option>
              </select>
            </label>
          </div>
          <label className="block text-xs text-ink-3">
            {t('workflowPreset.annotationMode')}
            <select
              value={candidateAnnotationMode}
              onChange={(event) =>
                setCandidateAnnotationMode(
                  event.target.value as CandidateAnnotationMode,
                )
              }
              className="mt-1 block w-full rounded-sm border border-line-2 bg-paper-raise px-2 py-2 text-sm text-ink"
            >
              <option value="body_only">{t('workflowPreset.annotationMode.bodyOnly')}</option>
              <option value="body_and_annotation">{t('workflowPreset.annotationMode.withAnnotation')}</option>
            </select>
            <span className="mt-1 block leading-5 text-ink-4">
              {t('workflowPreset.annotationMode.hint')}
            </span>
          </label>
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
        title={details ? t('workflowPreset.detailsTitle', { name: details.preset.name }) : ''}
      >
        <ol className="divide-y divide-line">
          {details?.revisions.map((revision) => (
            <li key={revision.id} className="flex items-center justify-between gap-3 py-2">
              <div>
                <p className="text-sm font-medium text-ink">
                  {t('workflowPreset.revision', { revision: formatNumber(revision.revisionNo) })}
                </p>
                <p className="text-xs text-ink-4">{formatDate(revision.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={revision.revisionNo === details.preset.currentRevisionNo}
                onClick={() => void restore(revision.revisionNo)}
              >
                {t('workflowPreset.restoreAsNew')}
              </Button>
            </li>
          ))}
        </ol>
      </Modal>
    </Card>
  )
}
