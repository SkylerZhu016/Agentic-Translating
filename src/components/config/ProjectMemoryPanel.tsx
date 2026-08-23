'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  Badge,
  Button,
  Card,
  Input,
  Modal,
  Spinner,
  Textarea,
} from '@/src/components/ui'
import type {
  ProjectMemorySuggestion,
  ProjectResourceContent,
  ProjectResourceKind,
  ProjectResourceRevision,
  ProjectResourceScope,
  ProjectResourceWithCurrentRevision,
  ProjectSnapshot,
  TranslationProject,
} from '@/src/lib/contracts/projects'
import type { TranslationDirection } from '@/src/lib/contracts/vnext'
import { Field, Select, type NotifyFn } from './shared'
import { useI18n, type MessageKey, type Translator } from '@/src/i18n'

const RESOURCE_KINDS: ProjectResourceKind[] = [
  'term',
  'proper_noun',
  'character_voice',
  'style_rule',
  'approved_decision',
  'context_note',
  'parallel_excerpt',
  'counterexample',
]

const RESOURCE_KIND_KEYS = {
  term: 'project.kind.term',
  proper_noun: 'project.kind.properNoun',
  character_voice: 'project.kind.characterVoice',
  style_rule: 'project.kind.styleRule',
  approved_decision: 'project.kind.approvedDecision',
  context_note: 'project.kind.contextNote',
  parallel_excerpt: 'project.kind.parallelExcerpt',
  counterexample: 'project.kind.counterexample',
} as const satisfies Record<ProjectResourceKind, MessageKey>

const DIRECTION_KEYS = {
  en_to_zh: 'project.direction.enToZh',
  zh_to_en: 'project.direction.zhToEn',
  custom: 'project.direction.custom',
} as const satisfies Record<TranslationDirection, MessageKey>

const REVISION_STATUS_KEYS = {
  suggested: 'project.status.suggested',
  approved: 'project.status.approved',
  rejected: 'project.status.rejected',
  retired: 'project.status.retired',
} as const satisfies Record<ProjectResourceRevision['status'], MessageKey>

const SCOPE_LEVEL_KEYS = {
  project: 'project.scope.project',
  document: 'project.scope.document',
  character: 'project.scope.character',
} as const satisfies Record<ProjectResourceScope['level'], MessageKey>

interface ProjectDraft {
  name: string
  description: string
  direction: TranslationDirection
  sourceLang: string
  targetLang: string
}

export interface ProjectResourceDraft {
  kind: ProjectResourceKind
  sourceText: string
  targetText: string
  instruction: string
  note: string
}

const EMPTY_PROJECT_DRAFT: ProjectDraft = {
  name: '',
  description: '',
  direction: 'en_to_zh',
  sourceLang: '英文',
  targetLang: '中文',
}

const EMPTY_RESOURCE_DRAFT: ProjectResourceDraft = {
  kind: 'term',
  sourceText: '',
  targetText: '',
  instruction: '',
  note: '',
}

function normalizedNullableText(value: string): string | null {
  const normalized = value.trim()
  return normalized ? normalized : null
}

export function buildProjectResourceContent(
  draft: ProjectResourceDraft,
): ProjectResourceContent {
  return {
    sourceText: normalizedNullableText(draft.sourceText),
    targetText: normalizedNullableText(draft.targetText),
    instruction: normalizedNullableText(draft.instruction),
    note: draft.note.trim(),
  }
}

export function buildProjectScope(
  direction: TranslationDirection,
): ProjectResourceScope {
  return {
    direction,
    level: 'project',
    selector: null,
    pinned: false,
  }
}

export function projectContentLines(
  content: ProjectResourceContent,
  t?: Translator,
): Array<{ label: string; value: string }> {
  return [
    content.sourceText ? { label: t?.('project.content.source') ?? '原文', value: content.sourceText } : null,
    content.targetText ? { label: t?.('project.content.target') ?? '译文', value: content.targetText } : null,
    content.instruction ? { label: t?.('project.content.instruction') ?? '规则', value: content.instruction } : null,
    content.note ? { label: t?.('project.content.note') ?? '备注', value: content.note } : null,
  ].filter((entry): entry is { label: string; value: string } => entry !== null)
}

export function snapshotHashSummary(contentHash: string): string {
  return contentHash.length > 12 ? `${contentHash.slice(0, 12)}…` : contentHash
}

const PROJECT_ERROR_MESSAGES: Record<string, string> = {
  validation_failed: '填写内容不符合档案要求，请检查后重试。',
  project_not_found: '项目不存在或已不可用。',
  resource_not_found: '这条档案资源已不可用，请刷新后重试。',
  revision_not_found: '这版档案已不可用，请刷新后重试。',
  project_archived: '该项目已归档，不能继续修改。',
  stale_resource_revision: '档案在加载后已有更新，请刷新后重试。',
  revision_not_suggested: '只有当前处于待批准状态的版本可以处理。',
  scope_direction_mismatch: '资源方向与项目方向不一致。',
  direction_mismatch: '语言与所选翻译方向不一致。',
  secret_content_rejected: '内容疑似包含敏感凭据，已停止保存。',
  snapshot_integrity_error: '项目快照校验失败，请稍后重试。',
  internal_error: '项目档案暂时不可用，请稍后重试。',
}

const PROJECT_ERROR_KEYS = {
  validation_failed: 'project.error.validationFailed',
  project_not_found: 'project.error.notFound',
  resource_not_found: 'project.error.resourceNotFound',
  revision_not_found: 'project.error.revisionNotFound',
  project_archived: 'project.error.archived',
  stale_resource_revision: 'project.error.staleRevision',
  revision_not_suggested: 'project.error.notSuggested',
  scope_direction_mismatch: 'project.error.scopeDirection',
  direction_mismatch: 'project.error.direction',
  secret_content_rejected: 'project.error.secret',
  snapshot_integrity_error: 'project.error.snapshotIntegrity',
  internal_error: 'project.error.internal',
} as const satisfies Record<string, MessageKey>

export function projectApiErrorMessage(
  errorCode: unknown,
  status: number,
  t?: Translator,
): string {
  if (typeof errorCode === 'string') {
    const key = errorCode in PROJECT_ERROR_KEYS
      ? PROJECT_ERROR_KEYS[errorCode as keyof typeof PROJECT_ERROR_KEYS]
      : null
    if (key && t) return t(key)
    if (PROJECT_ERROR_MESSAGES[errorCode]) return PROJECT_ERROR_MESSAGES[errorCode]
  }
  return t
    ? t('project.error.request', { status })
    : `项目档案请求未完成（${status}）。`
}

async function requestProjectJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
  t?: Translator,
): Promise<T> {
  const response = await fetch(input, init)
  const payload = await response.json().catch(() => null) as unknown
  if (!response.ok) {
    const errorCode =
      payload && typeof payload === 'object' && 'error' in payload
        ? (payload as { error?: unknown }).error
        : undefined
    throw new Error(projectApiErrorMessage(errorCode, response.status, t))
  }
  return payload as T
}

function projectLanguagesForDirection(
  direction: TranslationDirection,
): Pick<ProjectDraft, 'sourceLang' | 'targetLang'> {
  if (direction === 'en_to_zh') {
    return { sourceLang: '英文', targetLang: '中文' }
  }
  if (direction === 'zh_to_en') {
    return { sourceLang: '中文', targetLang: '英文' }
  }
  return { sourceLang: '', targetLang: '' }
}

function resourceDraftError(draft: ProjectResourceDraft, t: Translator): string | null {
  const hasSource = Boolean(draft.sourceText.trim())
  const hasTarget = Boolean(draft.targetText.trim())
  const hasInstruction = Boolean(draft.instruction.trim())

  if (
    draft.kind === 'term' ||
    draft.kind === 'proper_noun' ||
    draft.kind === 'parallel_excerpt'
  ) {
    return hasSource && hasTarget ? null : t('project.resource.requirePair')
  }
  if (draft.kind === 'character_voice') {
    return hasSource && hasInstruction ? null : t('project.resource.requireVoice')
  }
  return hasInstruction ? null : t('project.resource.requireRule')
}

function usesSourceAndTarget(kind: ProjectResourceKind): boolean {
  return kind === 'term' || kind === 'proper_noun' || kind === 'parallel_excerpt'
}

function usesCharacterVoiceFields(kind: ProjectResourceKind): boolean {
  return kind === 'character_voice'
}

function errorText(error: unknown, t: Translator): string {
  return error instanceof Error ? error.message : t('project.error.internal')
}

function scopeLabel(scope: ProjectResourceScope, t: Translator): string {
  const level = t(SCOPE_LEVEL_KEYS[scope.level])
  return scope.selector ? t('project.scope.selector', { level, selector: scope.selector }) : level
}

function ResourceContent({ content }: { content: ProjectResourceContent }) {
  const { t } = useI18n()
  const lines = projectContentLines(content, t)
  if (lines.length === 0) {
    return <p className="text-xs text-ink-4">{t('project.content.empty')}</p>
  }
  return (
    <dl className="mt-2 space-y-2">
      {lines.map((line) => (
        <div key={line.label} className="grid gap-1 sm:grid-cols-[3rem_minmax(0,1fr)]">
          <dt className="text-xs font-medium text-ink-4">{line.label}</dt>
          <dd className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-ink-2">
            {line.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function ProjectMemoryPanel({ notify }: { notify?: NotifyFn }) {
  const { t, formatNumber } = useI18n()
  const [projects, setProjects] = useState<TranslationProject[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [projectLoading, setProjectLoading] = useState(true)
  const [projectError, setProjectError] = useState<string | null>(null)

  const [resources, setResources] = useState<ProjectResourceWithCurrentRevision[]>([])
  const [snapshots, setSnapshots] = useState<ProjectSnapshot[]>([])
  const [pendingSuggestions, setPendingSuggestions] = useState<ProjectMemorySuggestion[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [decisionError, setDecisionError] = useState<string | null>(null)

  const [projectModalOpen, setProjectModalOpen] = useState(false)
  const [projectDraft, setProjectDraft] = useState<ProjectDraft>({ ...EMPTY_PROJECT_DRAFT })
  const [projectSaving, setProjectSaving] = useState(false)
  const [projectFormError, setProjectFormError] = useState<string | null>(null)

  const [resourceModalOpen, setResourceModalOpen] = useState(false)
  const [resourceDraft, setResourceDraft] = useState<ProjectResourceDraft>({ ...EMPTY_RESOURCE_DRAFT })
  const [resourceSaving, setResourceSaving] = useState(false)
  const [resourceFormError, setResourceFormError] = useState<string | null>(null)
  const [decidingRevisionId, setDecidingRevisionId] = useState<string | null>(null)
  const [decidingAction, setDecidingAction] = useState<'approve' | 'reject' | null>(null)

  const projectLoadGeneration = useRef(0)
  const detailLoadGeneration = useRef(0)
  const selectedProjectIdRef = useRef<string | null>(null)

  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? null

  const loadProjects = useCallback(async () => {
    const generation = ++projectLoadGeneration.current
    setProjectError(null)
    try {
      const payload = await requestProjectJson<{ projects: TranslationProject[] }>(
        '/api/projects?status=active',
        undefined,
        t,
      )
      if (generation !== projectLoadGeneration.current) return
      setProjects(payload.projects)
      const current = selectedProjectIdRef.current
      const next = current && payload.projects.some((project) => project.id === current)
        ? current
        : payload.projects[0]?.id ?? null
      if (next !== current) detailLoadGeneration.current += 1
      selectedProjectIdRef.current = next
      setSelectedProjectId(next)
    } catch (error) {
      if (generation !== projectLoadGeneration.current) return
      setProjectError(errorText(error, t))
    } finally {
      if (generation === projectLoadGeneration.current) setProjectLoading(false)
    }
  }, [t])

  const loadProjectDetail = useCallback(async (projectId: string) => {
    const generation = ++detailLoadGeneration.current
    setDetailLoading(true)
    setDetailError(null)
    setDecisionError(null)

    const [resourceResult, snapshotResult, suggestionResult] =
      await Promise.allSettled([
        requestProjectJson<{ resources: ProjectResourceWithCurrentRevision[] }>(
          `/api/projects/${encodeURIComponent(projectId)}/resources`,
          undefined,
          t,
        ),
        requestProjectJson<{ snapshots: ProjectSnapshot[] }>(
          `/api/projects/${encodeURIComponent(projectId)}/snapshots`,
          undefined,
          t,
        ),
        requestProjectJson<{ suggestions: ProjectMemorySuggestion[] }>(
          `/api/projects/${encodeURIComponent(projectId)}/suggestions?status=pending`,
          undefined,
          t,
        ),
      ])

    if (generation !== detailLoadGeneration.current) return

    const failures: string[] = []
    if (resourceResult.status === 'fulfilled') {
      setResources(resourceResult.value.resources)
    } else {
      setResources([])
      failures.push(t('project.detail.resourcesError', { error: errorText(resourceResult.reason, t) }))
    }
    if (snapshotResult.status === 'fulfilled') {
      setSnapshots(snapshotResult.value.snapshots)
    } else {
      setSnapshots([])
      failures.push(t('project.detail.snapshotsError', { error: errorText(snapshotResult.reason, t) }))
    }
    if (suggestionResult.status === 'fulfilled') {
      setPendingSuggestions(suggestionResult.value.suggestions)
    } else {
      setPendingSuggestions([])
      failures.push(t('project.detail.suggestionsError', { error: errorText(suggestionResult.reason, t) }))
    }

    setDetailError(failures.length > 0 ? failures.join('；') : null)
    setDetailLoading(false)
  }, [t])

  const refreshProjectAfterMutation = useCallback(async (
    projectId: string,
  ) => {
    await loadProjects()
    if (selectedProjectIdRef.current === projectId) {
      await loadProjectDetail(projectId)
    }
  }, [loadProjectDetail, loadProjects])

  useEffect(() => {
    void loadProjects()
    return () => {
      projectLoadGeneration.current += 1
      detailLoadGeneration.current += 1
    }
  }, [loadProjects])

  useEffect(() => {
    if (!selectedProjectId) {
      detailLoadGeneration.current += 1
      setResources([])
      setSnapshots([])
      setPendingSuggestions([])
      setDetailLoading(false)
      setDetailError(null)
      return
    }
    void loadProjectDetail(selectedProjectId)
  }, [loadProjectDetail, selectedProjectId])

  async function createProject() {
    if (!projectDraft.name.trim()) {
      setProjectFormError(t('project.form.requireName'))
      return
    }
    if (!projectDraft.sourceLang.trim() || !projectDraft.targetLang.trim()) {
      setProjectFormError(t('project.form.requireLanguages'))
      return
    }
    if (
      projectDraft.sourceLang.trim().toLocaleLowerCase() ===
      projectDraft.targetLang.trim().toLocaleLowerCase()
    ) {
      setProjectFormError(t('project.form.sameLanguages'))
      return
    }

    setProjectSaving(true)
    setProjectFormError(null)
    try {
      const payload = await requestProjectJson<{ project: TranslationProject }>(
        '/api/projects',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: projectDraft.name.trim(),
            description: projectDraft.description.trim(),
            direction: projectDraft.direction,
            sourceLang: projectDraft.sourceLang.trim(),
            targetLang: projectDraft.targetLang.trim(),
          }),
        },
        t,
      )
      setProjects((current) => [
        payload.project,
        ...current.filter((project) => project.id !== payload.project.id),
      ])
      detailLoadGeneration.current += 1
      selectedProjectIdRef.current = payload.project.id
      setSelectedProjectId(payload.project.id)
      setProjectModalOpen(false)
      setProjectDraft({ ...EMPTY_PROJECT_DRAFT })
      notify?.(t('project.created'), {
        message: t('project.created.detail'),
        tone: 'inverted',
      })
    } catch (error) {
      setProjectFormError(errorText(error, t))
    } finally {
      setProjectSaving(false)
    }
  }

  async function createResource() {
    if (!selectedProject) return
    const validationError = resourceDraftError(resourceDraft, t)
    if (validationError) {
      setResourceFormError(validationError)
      return
    }

    const projectId = selectedProject.id
    setResourceSaving(true)
    setResourceFormError(null)
    try {
      await requestProjectJson<{
        resource: ProjectResourceWithCurrentRevision['resource']
        revision: ProjectResourceRevision
      }>(`/api/projects/${encodeURIComponent(projectId)}/resources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: resourceDraft.kind,
          content: buildProjectResourceContent(resourceDraft),
          scope: buildProjectScope(selectedProject.direction),
        }),
      }, t)
      setResourceModalOpen(false)
      setResourceDraft({ ...EMPTY_RESOURCE_DRAFT })
      notify?.(t('project.resource.created'), {
        message: t('project.resource.created.detail'),
        tone: 'inverted',
      })
      await refreshProjectAfterMutation(projectId)
    } catch (error) {
      setResourceFormError(errorText(error, t))
    } finally {
      setResourceSaving(false)
    }
  }

  async function decideRevision(
    resource: ProjectResourceWithCurrentRevision,
    decision: 'approve' | 'reject',
  ) {
    if (!selectedProject || resource.currentRevision.status !== 'suggested') return
    const projectId = selectedProject.id
    setDecidingRevisionId(resource.currentRevision.id)
    setDecidingAction(decision)
    setDecisionError(null)
    try {
      await requestProjectJson<unknown>(
        `/api/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resource.resource.id)}/${decision}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ revisionId: resource.currentRevision.id }),
        },
        t,
      )
      notify?.(decision === 'approve' ? t('project.revision.approved') : t('project.revision.rejected'), {
        message:
          decision === 'approve'
            ? t('project.revision.approved.detail')
            : t('project.revision.rejected.detail'),
        tone: 'inverted',
      })
      await refreshProjectAfterMutation(projectId)
    } catch (error) {
      const message = errorText(error, t)
      if (selectedProjectIdRef.current === projectId) {
        setDecisionError(message)
      } else {
        notify?.(t('project.revision.failed'), { message })
      }
    } finally {
      setDecidingRevisionId(null)
      setDecidingAction(null)
    }
  }

  const latestSnapshot = snapshots[0] ?? null

  return (
    <>
      <Card
        overline={t('project.overline')}
        title={t('project.title')}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="hidden sm:inline-flex">
              {t('project.activeCount', { count: formatNumber(projects.length) })}
            </Badge>
            <Button
              size="sm"
              disabled={decidingRevisionId !== null}
              onClick={() => setProjectModalOpen(true)}
            >
              {t('project.new')}
            </Button>
          </div>
        }
        testId="project-memory-panel"
      >
        <p className="text-sm leading-6 text-ink-3">
          {t('project.description')}
        </p>

        {projectLoading ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-ink-3">
            <Spinner size="sm" />{t('project.loading')}
          </div>
        ) : projectError ? (
          <div className="mt-4 rounded-sm border border-line bg-paper-sink px-3 py-3">
            <p role="alert" className="text-sm leading-6 text-ink-2">{projectError}</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => void loadProjects()}>
              {t('project.retry')}
            </Button>
          </div>
        ) : projects.length === 0 ? (
          <div className="mt-4 rounded-sm border border-dashed border-line-2 px-4 py-5 text-center">
            <p className="font-serif text-sm text-ink">{t('project.empty.title')}</p>
            <p className="mt-1 text-xs leading-5 text-ink-4">
              {t('project.empty.description')}
            </p>
          </div>
        ) : (
          <div className="mt-4">
            <p className="mb-2 text-xs font-medium text-ink-2">{t('project.select')}</p>
            <ul className="grid gap-2 sm:grid-cols-2">
              {projects.map((project) => {
                const selected = project.id === selectedProjectId
                return (
                  <li key={project.id}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() => {
                        if (selected) return
                        detailLoadGeneration.current += 1
                        selectedProjectIdRef.current = project.id
                        setSelectedProjectId(project.id)
                      }}
                      className={[
                        'w-full rounded-sm border px-3 py-2.5 text-left transition-colors',
                        selected
                          ? 'border-ink bg-paper-sink'
                          : 'border-line bg-paper-raise hover:border-line-2',
                      ].join(' ')}
                    >
                      <span className="block truncate text-sm font-medium text-ink">{project.name}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge variant={selected ? 'solid' : 'subtle'}>
                          {t(DIRECTION_KEYS[project.direction])}
                        </Badge>
                        <span className="text-xs text-ink-4">
                          {project.sourceLang} → {project.targetLang}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {selectedProject && (
          <div className="mt-5 border-t border-line pt-5">
            <div className="rounded-sm border border-line bg-paper/55 px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-serif text-base font-medium text-ink">{selectedProject.name}</h3>
                  <p className="mt-1 text-sm leading-6 text-ink-3">
                    {selectedProject.description || t('project.noDescription')}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="solid">{t(DIRECTION_KEYS[selectedProject.direction])}</Badge>
                  <Badge variant="outline">{t('project.directionLocked')}</Badge>
                </div>
              </div>
              <p className="mt-2 text-xs text-ink-4">
                {selectedProject.sourceLang} → {selectedProject.targetLang}
              </p>
            </div>

            {detailError && (
              <div className="mt-3 rounded-sm border border-line bg-paper-sink px-3 py-3">
                <p role="alert" className="text-xs leading-5 text-ink-2">{detailError}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => void loadProjectDetail(selectedProject.id)}
                >
                  {t('project.detail.retry')}
                </Button>
              </div>
            )}

            {decisionError && (
              <p role="alert" className="mt-3 rounded-sm border border-line bg-paper-sink px-3 py-2 text-xs text-ink-2">
                {decisionError}
              </p>
            )}

            {detailLoading ? (
              <div className="mt-4 flex items-center gap-2 text-sm text-ink-3">
                <Spinner size="sm" />{t('project.detail.loading')}
              </div>
            ) : (
              <>
                <section className="mt-5" aria-labelledby="project-resources-heading">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 id="project-resources-heading" className="font-serif text-sm font-medium text-ink">
                        {t('project.resources.title')}
                      </h3>
                      <p className="mt-1 text-xs text-ink-4">{t('project.resources.scopeHint')}</p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setResourceFormError(null)
                        setResourceModalOpen(true)
                      }}
                    >
                      {t('project.resource.new')}
                    </Button>
                  </div>

                  {resources.length === 0 ? (
                    <p className="mt-3 rounded-sm border border-dashed border-line-2 px-3 py-4 text-center text-xs text-ink-4">
                      {t('project.resources.empty')}
                    </p>
                  ) : (
                    <ul className="mt-3 divide-y divide-line rounded-sm border border-line px-3">
                      {resources.map((entry) => {
                        const revision = entry.currentRevision
                        const deciding = decidingRevisionId === revision.id
                        return (
                          <li key={entry.resource.id} className="py-3">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <Badge variant="subtle">{t(RESOURCE_KIND_KEYS[revision.kind])}</Badge>
                                  <Badge variant={revision.status === 'approved' ? 'solid' : 'outline'}>
                                    {t(REVISION_STATUS_KEYS[revision.status])}
                                  </Badge>
                                  <span className="text-xs text-ink-4">
                                    {t('project.revision', { revision: formatNumber(revision.revisionNo) })}
                                  </span>
                                  <span className="max-w-full truncate text-xs text-ink-4" title={scopeLabel(revision.scope, t)}>
                                    {scopeLabel(revision.scope, t)}
                                  </span>
                                </div>
                                <ResourceContent content={revision.content} />
                              </div>
                              {revision.status === 'suggested' && (
                                <div className="flex shrink-0 gap-1.5">
                                  <Button
                                    size="sm"
                                    disabled={decidingRevisionId !== null}
                                    onClick={() => void decideRevision(entry, 'approve')}
                                  >
                                    {deciding && decidingAction === 'approve' && <Spinner size="sm" />}{t('project.approve')}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={decidingRevisionId !== null}
                                    onClick={() => void decideRevision(entry, 'reject')}
                                  >
                                    {deciding && decidingAction === 'reject' && <Spinner size="sm" />}{t('project.reject')}
                                  </Button>
                                </div>
                              )}
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </section>

                <section className="mt-5 border-t border-line pt-4" aria-labelledby="pending-suggestions-heading">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 id="pending-suggestions-heading" className="font-serif text-sm font-medium text-ink">
                      {t('project.pending.title')}
                    </h3>
                    <Badge variant="outline">{t('project.pending.neverAuto')}</Badge>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-ink-4">
                    {t('project.pending.description')}
                  </p>
                  {pendingSuggestions.length === 0 ? (
                    <p className="mt-3 text-xs text-ink-4">{t('project.pending.empty')}</p>
                  ) : (
                    <ul className="mt-3 space-y-2">
                      {pendingSuggestions.map((suggestion) => (
                        <li key={suggestion.id} className="rounded-sm border border-line bg-paper/55 px-3 py-3">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant="subtle">{t(RESOURCE_KIND_KEYS[suggestion.kind])}</Badge>
                            <Badge variant={suggestion.source.type === 'agent_suggestion' ? 'solid' : 'outline'}>
                              {suggestion.source.type === 'agent_suggestion'
                                ? t('project.pending.ai')
                                : t('project.pending.label')}
                            </Badge>
                            <span className="max-w-full truncate text-xs text-ink-4" title={scopeLabel(suggestion.scope, t)}>
                              {scopeLabel(suggestion.scope, t)}
                            </span>
                          </div>
                          <ResourceContent content={suggestion.content} />
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className="mt-5 border-t border-line pt-4" aria-labelledby="snapshot-heading">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 id="snapshot-heading" className="font-serif text-sm font-medium text-ink">
                      {t('project.snapshot.title')}
                    </h3>
                    {latestSnapshot && (
                      <Badge variant="solid">
                        {t('project.revision', { revision: formatNumber(latestSnapshot.revisionNo) })}
                      </Badge>
                    )}
                  </div>
                  {latestSnapshot ? (
                    <div className="mt-3 rounded-sm border border-line bg-paper-sink px-3 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="font-medium text-ink-2">
                          {t('project.snapshot.current', { revision: formatNumber(latestSnapshot.revisionNo) })}
                        </span>
                        <span className="font-mono text-ink-4" title={latestSnapshot.contentHash}>
                          {t('project.snapshot.hash', { hash: snapshotHashSummary(latestSnapshot.contentHash) })}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-ink-4">
                        {t('project.snapshot.resourceCount', {
                          count: formatNumber(latestSnapshot.approvedResourceRevisionIds.length),
                        })}
                      </p>
                    </div>
                  ) : (
                    <p className="mt-3 text-xs text-ink-4">{t('project.snapshot.empty')}</p>
                  )}
                </section>
              </>
            )}
          </div>
        )}
      </Card>

      <Modal
        open={projectModalOpen}
        onClose={() => {
          if (!projectSaving) setProjectModalOpen(false)
        }}
        title={t('project.form.newTitle')}
        aria-label={t('project.form.newTitle')}
        footer={
          <>
            <Button variant="ghost" size="sm" disabled={projectSaving} onClick={() => setProjectModalOpen(false)}>
              {t('config.action.cancel')}
            </Button>
            <Button size="sm" disabled={projectSaving} onClick={() => void createProject()}>
              {projectSaving && <Spinner size="sm" />}{t('project.form.create')}
            </Button>
          </>
        }
        testId="create-project-modal"
      >
        <div className="space-y-4">
          <Field label={t('project.form.name')}>
            <Input
              value={projectDraft.name}
              onChange={(event) => setProjectDraft((current) => ({ ...current, name: event.target.value }))}
              placeholder={t('project.form.namePlaceholder')}
              aria-label={t('project.form.name')}
              maxLength={200}
              autoFocus
            />
          </Field>
          <Field label={t('project.form.direction')} hint={t('project.form.directionHint')}>
            <Select
              value={projectDraft.direction}
              aria-label={t('project.form.direction')}
              onChange={(event) => {
                const direction = event.target.value as TranslationDirection
                setProjectDraft((current) => ({
                  ...current,
                  direction,
                  ...projectLanguagesForDirection(direction),
                }))
              }}
            >
              <option value="en_to_zh">{t('project.direction.enToZh')}</option>
              <option value="zh_to_en">{t('project.direction.zhToEn')}</option>
              <option value="custom">{t('project.direction.custom')}</option>
            </Select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('project.form.sourceLang')}>
              <Input
                value={projectDraft.sourceLang}
                readOnly={projectDraft.direction !== 'custom'}
                onChange={(event) => setProjectDraft((current) => ({ ...current, sourceLang: event.target.value }))}
                placeholder={t('project.form.sourceLangPlaceholder')}
                aria-label={t('project.form.sourceLang')}
                maxLength={100}
              />
            </Field>
            <Field label={t('project.form.targetLang')}>
              <Input
                value={projectDraft.targetLang}
                readOnly={projectDraft.direction !== 'custom'}
                onChange={(event) => setProjectDraft((current) => ({ ...current, targetLang: event.target.value }))}
                placeholder={t('project.form.targetLangPlaceholder')}
                aria-label={t('project.form.targetLang')}
                maxLength={100}
              />
            </Field>
          </div>
          <Field label={t('project.form.description')} hint={t('project.form.descriptionHint')}>
            <Textarea
              rows={4}
              value={projectDraft.description}
              onChange={(event) => setProjectDraft((current) => ({ ...current, description: event.target.value }))}
              placeholder={t('project.form.optional')}
              aria-label={t('project.form.description')}
              maxLength={20_000}
            />
          </Field>
          {projectFormError && (
            <p role="alert" className="rounded-sm border border-line bg-paper-sink px-3 py-2 text-xs leading-5 text-ink-2">
              {projectFormError}
            </p>
          )}
        </div>
      </Modal>

      <Modal
        open={resourceModalOpen}
        onClose={() => {
          if (!resourceSaving) setResourceModalOpen(false)
        }}
        title={t('project.resource.newTitle')}
        aria-label={t('project.resource.newTitle')}
        footer={
          <>
            <Button variant="ghost" size="sm" disabled={resourceSaving} onClick={() => setResourceModalOpen(false)}>
              {t('config.action.cancel')}
            </Button>
            <Button size="sm" disabled={resourceSaving} onClick={() => void createResource()}>
              {resourceSaving && <Spinner size="sm" />}{t('project.resource.saveSuggestion')}
            </Button>
          </>
        }
        testId="create-project-resource-modal"
      >
        <div className="space-y-4">
          <div className="rounded-sm border border-line bg-paper-sink px-3 py-2 text-xs leading-5 text-ink-3">
            {t('project.resource.scopeNotice')}
          </div>
          <Field label={t('project.resource.kind')}>
            <Select
              value={resourceDraft.kind}
              aria-label={t('project.resource.kind')}
              onChange={(event) => {
                const kind = event.target.value as ProjectResourceKind
                setResourceDraft({ ...EMPTY_RESOURCE_DRAFT, kind })
                setResourceFormError(null)
              }}
            >
              {RESOURCE_KINDS.map((kind) => (
                <option key={kind} value={kind}>{t(RESOURCE_KIND_KEYS[kind])}</option>
              ))}
            </Select>
          </Field>

          {usesSourceAndTarget(resourceDraft.kind) && (
            <>
              <Field label={t('project.resource.source')}>
                <Textarea
                  rows={3}
                  value={resourceDraft.sourceText}
                  onChange={(event) => setResourceDraft((current) => ({ ...current, sourceText: event.target.value }))}
                  aria-label={t('project.resource.sourceAria')}
                  maxLength={200_000}
                />
              </Field>
              <Field label={t('project.resource.target')}>
                <Textarea
                  rows={3}
                  value={resourceDraft.targetText}
                  onChange={(event) => setResourceDraft((current) => ({ ...current, targetText: event.target.value }))}
                  aria-label={t('project.resource.targetAria')}
                  maxLength={200_000}
                />
              </Field>
            </>
          )}

          {usesCharacterVoiceFields(resourceDraft.kind) && (
            <>
              <Field label={t('project.resource.voiceSource')}>
                <Textarea
                  rows={3}
                  value={resourceDraft.sourceText}
                  onChange={(event) => setResourceDraft((current) => ({ ...current, sourceText: event.target.value }))}
                  aria-label={t('project.resource.voiceSource')}
                  maxLength={200_000}
                />
              </Field>
              <Field label={t('project.resource.voiceRule')}>
                <Textarea
                  rows={4}
                  value={resourceDraft.instruction}
                  onChange={(event) => setResourceDraft((current) => ({ ...current, instruction: event.target.value }))}
                  aria-label={t('project.resource.voiceRuleAria')}
                  maxLength={100_000}
                />
              </Field>
            </>
          )}

          {!usesSourceAndTarget(resourceDraft.kind) && !usesCharacterVoiceFields(resourceDraft.kind) && (
            <Field label={t('project.resource.rule')}>
              <Textarea
                rows={5}
                value={resourceDraft.instruction}
                onChange={(event) => setResourceDraft((current) => ({ ...current, instruction: event.target.value }))}
                aria-label={t('project.resource.ruleAria')}
                maxLength={100_000}
              />
            </Field>
          )}

          <Field label={t('project.resource.note')} hint={t('project.resource.noteHint')}>
            <Textarea
              rows={2}
              value={resourceDraft.note}
              onChange={(event) => setResourceDraft((current) => ({ ...current, note: event.target.value }))}
              aria-label={t('project.resource.noteAria')}
              maxLength={20_000}
            />
          </Field>
          {resourceFormError && (
            <p role="alert" className="rounded-sm border border-line bg-paper-sink px-3 py-2 text-xs leading-5 text-ink-2">
              {resourceFormError}
            </p>
          )}
        </div>
      </Modal>
    </>
  )
}
