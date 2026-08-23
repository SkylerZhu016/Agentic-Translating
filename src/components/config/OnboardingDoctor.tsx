'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge, Button, Card, Spinner } from '@/src/components/ui'
import { useDirection } from '@/src/components/direction/DirectionProvider'
import type {
  AgentDirectionVariant,
  DirectionPromptBundle,
  ModelBinding,
  ReviewMode,
  TeamPolicy,
} from '@/src/lib/contracts/vnext'
import type { Endpoint } from './api'
import { ModelPicker } from './ModelPicker'
import type { NotifyFn } from './shared'
import {
  localizeDiagnosticError,
  useI18n,
  type MessageKey,
  type Translator,
} from '@/src/i18n'

interface CapabilityResult {
  supported: boolean
  error: string | null
}

interface EndpointCapabilityProfile {
  endpointId: number
  checkedAt: string
  expiresAt: string
  models: {
    supported: boolean
    count: number | null
    error: string | null
  }
  chat: CapabilityResult
  streaming: CapabilityResult
  usage: CapabilityResult
  tools: CapabilityResult
  reasoningContent: CapabilityResult
  firstByteMs: number | null
  testedModel: string
  diagnosticId: string
}

interface OnboardingState {
  schemaVersion: 1
  completedAt: string | null
  dismissedAt: string | null
  lastDoctorRunAt: string | null
  selectedEndpointId: number | null
  generatedPresetRevisionIds: string[]
}

interface OnboardingStatus {
  state: OnboardingState
  hasRunnableConfig: boolean
  recommendedAction: 'start' | 'check_existing' | 'none'
}

type WorkflowLevel = 'quick' | 'balanced' | 'deep'

const LEVEL_META = {
  quick: {
    labelKey: 'doctor.level.quick',
    descriptionKey: 'doctor.level.quickDescription',
    archetypes: ['semantic-fidelity', 'target-naturalness'],
    teamPolicy: 'fixed',
    reviewMode: 'main_editor',
    maxAgentCalls: 2,
  },
  balanced: {
    labelKey: 'doctor.level.balanced',
    descriptionKey: 'doctor.level.balancedDescription',
    archetypes: [
      'semantic-fidelity',
      'target-naturalness',
      'voice-register',
      'terminology',
      'long-context',
      'literary-prose',
      'poetry-form',
    ],
    teamPolicy: 'dynamic',
    reviewMode: 'main_editor',
    maxAgentCalls: 5,
  },
  deep: {
    labelKey: 'doctor.level.deep',
    descriptionKey: 'doctor.level.deepDescription',
    archetypes: 'all',
    teamPolicy: 'dynamic',
    reviewMode: 'four_stage',
    maxAgentCalls: 10,
  },
} as const satisfies Record<
  WorkflowLevel,
  {
    labelKey: MessageKey
    descriptionKey: MessageKey
    archetypes: readonly string[] | 'all'
    teamPolicy: TeamPolicy
    reviewMode: ReviewMode
    maxAgentCalls: number
  }
>

const CAPABILITY_LABELS = [
  { key: 'models', labelKey: 'doctor.capability.models' },
  { key: 'chat', labelKey: 'doctor.capability.chat' },
  { key: 'streaming', labelKey: 'doctor.capability.streaming' },
  { key: 'usage', labelKey: 'doctor.capability.usage' },
  { key: 'tools', labelKey: 'doctor.capability.tools' },
] as const satisfies ReadonlyArray<{
  key: 'models' | 'chat' | 'streaming' | 'usage' | 'tools'
  labelKey: MessageKey
}>

function endpointLocation(endpoint: Endpoint | undefined, t: Translator): string {
  if (!endpoint) return t('doctor.location.unknown')
  try {
    const host = new URL(endpoint.base_url).hostname.toLowerCase()
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      return t('doctor.location.local')
    }
    return t('doctor.location.remote', { host })
  } catch {
    return t('doctor.location.unverified')
  }
}

async function readJson<T>(response: Response, t: Translator): Promise<T> {
  const body = await response.json().catch(() => null) as
    | (T & { error?: string })
    | null
  if (!response.ok) {
    throw new Error(localizeDiagnosticError(
      t,
      body?.error,
      t('doctor.error.request', { status: response.status }),
    ))
  }
  return body as T
}

export function OnboardingDoctor({
  endpoints,
  notify,
}: {
  endpoints: Endpoint[]
  notify: NotifyFn
}) {
  const { direction } = useDirection()
  const { t, formatDuration, formatNumber } = useI18n()
  const [status, setStatus] = useState<OnboardingStatus | null>(null)
  const [endpointId, setEndpointId] = useState<number | null>(null)
  const [model, setModel] = useState('')
  const [profile, setProfile] = useState<EndpointCapabilityProfile | null>(null)
  const [level, setLevel] = useState<WorkflowLevel>('balanced')
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)
  const [creating, setCreating] = useState(false)
  const [expanded, setExpanded] = useState(true)

  const selectedEndpoint = endpoints.find((item) => item.id === endpointId)

  const loadStatus = useCallback(async () => {
    setLoading(true)
    try {
      const next = await readJson<OnboardingStatus>(
        await fetch('/api/onboarding/status', { cache: 'no-store' }),
        t,
      )
      setStatus(next)
      setEndpointId((current) =>
        current ??
        next.state.selectedEndpointId ??
        endpoints[0]?.id ??
        null,
      )
      if (next.recommendedAction === 'none') setExpanded(false)
    } catch (error) {
      notify(t('doctor.unavailable'), {
        message: error instanceof Error ? error.message : t('config.error.tryLater'),
      })
    } finally {
      setLoading(false)
    }
  }, [endpoints, notify, t])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  useEffect(() => {
    setModel('')
    setProfile(null)
    if (!endpointId) return
    void fetch(`/api/endpoints/${endpointId}/capabilities`, {
      cache: 'no-store',
    }).then(async (response) => {
      if (!response.ok) return
      const existing = await response.json() as EndpointCapabilityProfile
      setProfile(existing)
      if (existing.testedModel) setModel(existing.testedModel)
    })
  }, [endpointId])

  // A provider that only returns JSON can still run through the existing
  // transport fallback.  Streaming is therefore an experience signal, not a
  // hard gate that would incorrectly reject an otherwise usable endpoint.
  const capabilityReady = Boolean(profile?.chat.supported)
  const modeWarning = useMemo(() => {
    if (!profile) return null
    const warnings: string[] = []
    if (!profile.streaming.supported) {
      warnings.push(
        t('doctor.warning.streaming'),
      )
    }
    if (!profile.tools.supported) {
      warnings.push(
        t('doctor.warning.tools'),
      )
    }
    if (!profile.usage.supported) {
      warnings.push(
        t('doctor.warning.usage'),
      )
    }
    return warnings.length > 0 ? warnings.join(' ') : null
  }, [profile, t])

  async function runDoctor() {
    if (!endpointId) return
    setChecking(true)
    setProfile(null)
    try {
      const checked = await readJson<EndpointCapabilityProfile>(
        await fetch(`/api/endpoints/${endpointId}/capability-check`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(model.trim() ? { model: model.trim() } : {}),
        }),
        t,
      )
      setProfile(checked)
      if (!model && checked.testedModel) setModel(checked.testedModel)
      const nextStatus = await readJson<OnboardingStatus>(
        await fetch('/api/onboarding/status', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lastDoctorRunAt: checked.checkedAt,
            selectedEndpointId: endpointId,
          }),
        }),
        t,
      )
      setStatus(nextStatus)
      notify(t('doctor.check.complete'), { tone: 'inverted' })
    } catch (error) {
      notify(t('doctor.check.failed'), {
        message: error instanceof Error ? error.message : t('config.error.tryLater'),
      })
    } finally {
      setChecking(false)
    }
  }

  async function generateWorkflow() {
    if (!endpointId || !model.trim() || !capabilityReady) return
    setCreating(true)
    try {
      const [catalogue, bundle] = await Promise.all([
        readJson<{ variants: AgentDirectionVariant[] }>(
          await fetch(`/api/agent-catalog?direction=${direction}`),
          t,
        ),
        readJson<DirectionPromptBundle>(
          await fetch(`/api/direction-prompt-bundles?direction=${direction}`),
          t,
        ),
      ])
      const meta = LEVEL_META[level]
      const variants = catalogue.variants.filter(
        (variant) =>
          variant.enabled &&
          (meta.archetypes === 'all' ||
            meta.archetypes.some(
              (archetypeId) => archetypeId === variant.archetypeId,
            )),
      )
      if (variants.length < 2) {
        throw new Error(t('doctor.workflow.notEnoughAgents'))
      }
      const binding: ModelBinding = {
        endpointId,
        model: model.trim(),
        contextWindow: selectedEndpoint?.context_window ?? null,
      }
      const effectiveReviewMode: ReviewMode =
        meta.reviewMode === 'main_editor' && !profile?.tools.supported
          ? 'four_stage'
          : meta.reviewMode
      const contract = {
        // These labels are prompt-contract values and remain stable across UI locales.
        sourceLang: direction === 'en_to_zh' ? '英文' : '中文',
        targetLang: direction === 'en_to_zh' ? '中文' : '英文',
        taskBriefTemplate: '',
        teamPolicy: meta.teamPolicy,
        reviewMode: effectiveReviewMode,
        candidateAnnotationMode: 'body_only' as const,
        agentVariantIds: variants.map((variant) => variant.id),
        agentVariantSnapshots: variants,
        defaultWorkerBinding: binding,
        agentBindingOverrides: {},
        mainAgentBinding: binding,
        reviewAgentBinding: binding,
        filterAgentBinding: binding,
        orchestrateAgentBinding: binding,
        assembleAgentBinding: binding,
        editingAgentBinding: binding,
        contextAnalysisBindings: [binding],
        promptBundleVersion: bundle.version,
        maxAgentCalls: meta.maxAgentCalls,
        batchConcurrency: 2,
        constraints: {},
      }
      const presetResponse = await readJson<{
        revision: { id: string }
      }>(
        await fetch('/api/workflow-presets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: t('doctor.workflow.name', { level: t(meta.labelKey) }),
            description: t('doctor.workflow.description', {
              endpoint: selectedEndpoint?.name ?? t('doctor.workflow.currentEndpoint'),
            }),
            direction,
            contract,
          }),
        }),
        t,
      )
      await readJson(
        await fetch(`/api/model-profiles/${direction}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            defaultWorker: binding,
            mainAgent: binding,
            reviewAgent: binding,
            filterAgent: binding,
            orchestrateAgent: binding,
            assembleAgent: binding,
            editingAgent: binding,
          }),
        }),
        t,
      )
      const completedAt = new Date().toISOString()
      const generatedPresetRevisionIds = Array.from(
        new Set([
          ...(status?.state.generatedPresetRevisionIds ?? []),
          presetResponse.revision.id,
        ]),
      )
      const next = await readJson<OnboardingStatus>(
        await fetch('/api/onboarding/status', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            completedAt,
            dismissedAt: null,
            selectedEndpointId: endpointId,
            generatedPresetRevisionIds,
          }),
        }),
        t,
      )
      setStatus(next)
      setExpanded(false)
      notify(t('doctor.workflow.created', { level: t(meta.labelKey) }), {
        tone: 'inverted',
        message: t('doctor.workflow.createdDetail'),
      })
    } catch (error) {
      notify(t('doctor.workflow.createFailed'), {
        message: error instanceof Error ? error.message : t('config.error.tryLater'),
      })
    } finally {
      setCreating(false)
    }
  }

  async function dismiss() {
    try {
      const next = await readJson<OnboardingStatus>(
        await fetch('/api/onboarding/status', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dismissedAt: new Date().toISOString() }),
        }),
        t,
      )
      setStatus(next)
      setExpanded(false)
    } catch (error) {
      notify(t('doctor.settings.failed'), {
        message: error instanceof Error ? error.message : t('config.error.tryLater'),
      })
    }
  }

  return (
    <Card
      id="compatibility-doctor"
      overline={t('doctor.overline')}
      title={t('doctor.title')}
      actions={
        status?.state.completedAt || status?.state.dismissedAt ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? t('doctor.collapse') : t('doctor.recheck')}
          </Button>
        ) : undefined
      }
    >
      {loading ? (
        <div className="flex min-h-24 items-center justify-center text-ink-3">
          <Spinner />
        </div>
      ) : !expanded ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-ink">
              {status?.state.completedAt ? t('doctor.ready') : t('doctor.dismissed')}
            </p>
            <p className="mt-1 text-xs leading-5 text-ink-3">
              {profile
                ? t('doctor.summary', {
                    model: profile.testedModel || t('doctor.currentModel'),
                    location: endpointLocation(selectedEndpoint, t),
                  })
                : t('doctor.recheckHint')}
            </p>
          </div>
          <Badge variant="outline">
            {status?.hasRunnableConfig ? t('doctor.runnable') : t('doctor.needsConfig')}
          </Badge>
        </div>
      ) : (
        <div className="space-y-5">
          <section className="compatibility-endpoint-section">
            <div className="mb-2 flex items-center gap-2">
              <Badge variant="solid">{formatNumber(1)}</Badge>
              <p className="text-sm font-medium text-ink">{t('doctor.step.endpoint')}</p>
            </div>
            {endpoints.length === 0 ? (
              <div className="rounded-sm border border-dashed border-line-2 bg-paper/60 px-4 py-4">
                <p className="text-sm leading-6 text-ink-3">
                  {t('doctor.endpoint.empty')}
                </p>
                <Button
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    document
                      .getElementById('endpoint-management')
                      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }
                >
                  {t('doctor.endpoint.add')}
                </Button>
              </div>
            ) : (
              <div
                data-testid="compatibility-model-fields"
                className="compatibility-endpoint-grid grid min-w-0 max-w-full gap-2 sm:grid-cols-[minmax(10rem,0.8fr)_minmax(16rem,1.2fr)]"
              >
                <select
                  value={endpointId ?? ''}
                  aria-label={t('doctor.endpoint.aria')}
                  onChange={(event) =>
                    setEndpointId(Number(event.target.value) || null)
                  }
                  className="h-9 min-w-0 max-w-full rounded-sm border border-line-2 bg-paper-raise px-2 text-sm text-ink"
                >
                  <option value="">{t('doctor.endpoint.select')}</option>
                  {endpoints.map((endpoint) => (
                    <option key={endpoint.id} value={endpoint.id}>
                      {endpoint.name}
                    </option>
                  ))}
                </select>
                <ModelPicker
                  endpointId={endpointId}
                  value={model}
                  onChange={(nextModel) => {
                    setModel(nextModel)
                    if (nextModel !== profile?.testedModel) setProfile(null)
                  }}
                  emptyLabel={t('doctor.model.select')}
                  ariaLabel={t('doctor.model.aria')}
                />
              </div>
            )}
            {selectedEndpoint && (
              <p className="mt-2 text-xs leading-5 text-ink-4">
                {t('doctor.endpoint.privacy', {
                  location: endpointLocation(selectedEndpoint, t),
                })}
              </p>
            )}
          </section>

          <section className="border-t border-line pt-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Badge variant="solid">{formatNumber(2)}</Badge>
                <p className="text-sm font-medium text-ink">{t('doctor.step.capabilities')}</p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={checking || !endpointId}
                onClick={() => void runDoctor()}
              >
                {checking && <Spinner size="sm" />}
                {profile ? t('doctor.recheck') : t('doctor.check.start')}
              </Button>
            </div>
            {profile ? (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  {CAPABILITY_LABELS.map(({ key, labelKey }) => {
                    const result = profile[key]
                    return (
                      <div
                        key={key}
                        className="rounded-sm border border-line bg-paper/55 px-2 py-2 text-center"
                        title={
                          result.error
                            ? localizeDiagnosticError(
                                t,
                                result.error,
                                t('doctor.capability.failed'),
                              )
                            : undefined
                        }
                      >
                        <p className="text-xs text-ink-3">{t(labelKey)}</p>
                        <p
                          className={`mt-1 text-xs font-medium ${
                            result.supported ? 'text-pine' : 'text-cinnabar'
                          }`}
                        >
                          {result.supported
                            ? t('doctor.capability.available')
                            : t('doctor.capability.failed')}
                        </p>
                      </div>
                    )
                  })}
                </div>
                <p className="text-xs leading-5 text-ink-4">
                  {t('doctor.result.model', {
                    model: profile.testedModel || t('doctor.result.noAutoModel'),
                  })}
                  {profile.firstByteMs != null
                    ? t('doctor.result.firstByte', {
                        duration: formatDuration(profile.firstByteMs),
                      })
                    : ''}
                  {t('doctor.result.diagnostic', { id: profile.diagnosticId })}
                </p>
                {modeWarning && (
                  <p className="rounded-sm border border-amber/35 bg-amber/5 px-3 py-2 text-xs leading-5 text-ink-2">
                    {modeWarning}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-xs leading-5 text-ink-4">
                {t('doctor.check.hint')}
              </p>
            )}
          </section>

          <section className="border-t border-line pt-4">
            <div className="mb-2 flex items-center gap-2">
              <Badge variant="solid">{formatNumber(3)}</Badge>
              <p className="text-sm font-medium text-ink">{t('doctor.step.workflow')}</p>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {(Object.keys(LEVEL_META) as WorkflowLevel[]).map((item) => {
                const meta = LEVEL_META[item]
                const selected = level === item
                return (
                  <button
                    key={item}
                    type="button"
                    disabled={!capabilityReady}
                    onClick={() => setLevel(item)}
                    className={[
                      'rounded-sm border px-3 py-3 text-left transition-colors',
                      selected
                        ? 'border-ink bg-paper-sink'
                        : 'border-line bg-paper/55 hover:border-line-2',
                      !capabilityReady ? 'cursor-not-allowed opacity-55' : '',
                    ].join(' ')}
                  >
                    <span className="block text-sm font-medium text-ink">
                      {t(meta.labelKey)}
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-ink-3">
                      {t(meta.descriptionKey)}
                    </span>
                  </button>
                )
              })}
            </div>
            <div className="mt-3 flex w-full min-w-0 max-w-full flex-wrap items-center gap-2 sm:justify-between">
              <p className="w-full min-w-0 text-xs leading-5 text-ink-4 sm:w-auto sm:flex-1">
                {t('doctor.workflow.hint')}
              </p>
              <div
                data-testid="first-run-workflow-actions"
                className="flex w-full min-w-0 max-w-full flex-wrap gap-2 sm:w-auto sm:justify-end"
              >
                {!status?.state.completedAt && !status?.state.dismissedAt && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={creating || checking}
                    onClick={() => void dismiss()}
                  >
                    {t('doctor.dismiss')}
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={
                    creating ||
                    !capabilityReady ||
                    !endpointId ||
                    !model.trim()
                  }
                  onClick={() => void generateWorkflow()}
                >
                  {creating && <Spinner size="sm" />}
                  {t('doctor.workflow.create', { level: t(LEVEL_META[level].labelKey) })}
                </Button>
              </div>
            </div>
          </section>
        </div>
      )}
    </Card>
  )
}
