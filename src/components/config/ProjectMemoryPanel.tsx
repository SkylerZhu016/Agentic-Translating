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

const RESOURCE_KIND_LABELS: Record<ProjectResourceKind, string> = {
  term: '术语',
  proper_noun: '专名',
  character_voice: '人物语气',
  style_rule: '风格规则',
  approved_decision: '已确认决策',
  context_note: '背景说明',
  parallel_excerpt: '平行语料',
  counterexample: '反例',
}

const DIRECTION_LABELS: Record<TranslationDirection, string> = {
  en_to_zh: '英译中',
  zh_to_en: '中译英',
  custom: '自定义',
}

const REVISION_STATUS_LABELS: Record<ProjectResourceRevision['status'], string> = {
  suggested: '待批准',
  approved: '已批准',
  rejected: '已拒绝',
  retired: '已停用',
}

const SCOPE_LEVEL_LABELS: Record<ProjectResourceScope['level'], string> = {
  project: '项目范围',
  document: '文档范围',
  character: '人物范围',
}

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
): Array<{ label: string; value: string }> {
  return [
    content.sourceText ? { label: '原文', value: content.sourceText } : null,
    content.targetText ? { label: '译文', value: content.targetText } : null,
    content.instruction ? { label: '规则', value: content.instruction } : null,
    content.note ? { label: '备注', value: content.note } : null,
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

export function projectApiErrorMessage(
  errorCode: unknown,
  status: number,
): string {
  if (typeof errorCode === 'string' && PROJECT_ERROR_MESSAGES[errorCode]) {
    return PROJECT_ERROR_MESSAGES[errorCode]
  }
  return `项目档案请求未完成（${status}）。`
}

async function requestProjectJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, init)
  const payload = await response.json().catch(() => null) as unknown
  if (!response.ok) {
    const errorCode =
      payload && typeof payload === 'object' && 'error' in payload
        ? (payload as { error?: unknown }).error
        : undefined
    throw new Error(projectApiErrorMessage(errorCode, response.status))
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

function resourceDraftError(draft: ProjectResourceDraft): string | null {
  const hasSource = Boolean(draft.sourceText.trim())
  const hasTarget = Boolean(draft.targetText.trim())
  const hasInstruction = Boolean(draft.instruction.trim())

  if (
    draft.kind === 'term' ||
    draft.kind === 'proper_noun' ||
    draft.kind === 'parallel_excerpt'
  ) {
    return hasSource && hasTarget ? null : '请填写原文和对应译文。'
  }
  if (draft.kind === 'character_voice') {
    return hasSource && hasInstruction ? null : '请填写人物示例原文和语气规则。'
  }
  return hasInstruction ? null : '请填写这条档案规则的内容。'
}

function usesSourceAndTarget(kind: ProjectResourceKind): boolean {
  return kind === 'term' || kind === 'proper_noun' || kind === 'parallel_excerpt'
}

function usesCharacterVoiceFields(kind: ProjectResourceKind): boolean {
  return kind === 'character_voice'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '项目档案暂时不可用，请稍后重试。'
}

function scopeLabel(scope: ProjectResourceScope): string {
  const level = SCOPE_LEVEL_LABELS[scope.level]
  return scope.selector ? `${level}：${scope.selector}` : level
}

function ResourceContent({ content }: { content: ProjectResourceContent }) {
  const lines = projectContentLines(content)
  if (lines.length === 0) {
    return <p className="text-xs text-ink-4">暂无内容摘要</p>
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
      setProjectError(errorText(error))
    } finally {
      if (generation === projectLoadGeneration.current) setProjectLoading(false)
    }
  }, [])

  const loadProjectDetail = useCallback(async (projectId: string) => {
    const generation = ++detailLoadGeneration.current
    setDetailLoading(true)
    setDetailError(null)
    setDecisionError(null)

    const [resourceResult, snapshotResult, suggestionResult] =
      await Promise.allSettled([
        requestProjectJson<{ resources: ProjectResourceWithCurrentRevision[] }>(
          `/api/projects/${encodeURIComponent(projectId)}/resources`,
        ),
        requestProjectJson<{ snapshots: ProjectSnapshot[] }>(
          `/api/projects/${encodeURIComponent(projectId)}/snapshots`,
        ),
        requestProjectJson<{ suggestions: ProjectMemorySuggestion[] }>(
          `/api/projects/${encodeURIComponent(projectId)}/suggestions?status=pending`,
        ),
      ])

    if (generation !== detailLoadGeneration.current) return

    const failures: string[] = []
    if (resourceResult.status === 'fulfilled') {
      setResources(resourceResult.value.resources)
    } else {
      setResources([])
      failures.push(`资源：${errorText(resourceResult.reason)}`)
    }
    if (snapshotResult.status === 'fulfilled') {
      setSnapshots(snapshotResult.value.snapshots)
    } else {
      setSnapshots([])
      failures.push(`快照：${errorText(snapshotResult.reason)}`)
    }
    if (suggestionResult.status === 'fulfilled') {
      setPendingSuggestions(suggestionResult.value.suggestions)
    } else {
      setPendingSuggestions([])
      failures.push(`待审建议：${errorText(suggestionResult.reason)}`)
    }

    setDetailError(failures.length > 0 ? failures.join('；') : null)
    setDetailLoading(false)
  }, [])

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
      setProjectFormError('请填写项目名称。')
      return
    }
    if (!projectDraft.sourceLang.trim() || !projectDraft.targetLang.trim()) {
      setProjectFormError('请填写源语言和目标语言。')
      return
    }
    if (
      projectDraft.sourceLang.trim().toLocaleLowerCase() ===
      projectDraft.targetLang.trim().toLocaleLowerCase()
    ) {
      setProjectFormError('源语言和目标语言不能相同。')
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
      notify?.('翻译项目已创建', {
        message: '方向与语言组合已锁定。',
        tone: 'inverted',
      })
    } catch (error) {
      setProjectFormError(errorText(error))
    } finally {
      setProjectSaving(false)
    }
  }

  async function createResource() {
    if (!selectedProject) return
    const validationError = resourceDraftError(resourceDraft)
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
      })
      setResourceModalOpen(false)
      setResourceDraft({ ...EMPTY_RESOURCE_DRAFT })
      notify?.('档案建议已创建', {
        message: '建议尚未进入会话，需人工批准。',
        tone: 'inverted',
      })
      await refreshProjectAfterMutation(projectId)
    } catch (error) {
      setResourceFormError(errorText(error))
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
      )
      notify?.(decision === 'approve' ? '档案版本已批准' : '档案版本已拒绝', {
        message:
          decision === 'approve'
            ? '新的项目快照已生成。'
            : '该建议未进入项目快照。',
        tone: 'inverted',
      })
      await refreshProjectAfterMutation(projectId)
    } catch (error) {
      const message = errorText(error)
      if (selectedProjectIdRef.current === projectId) {
        setDecisionError(message)
      } else {
        notify?.('档案版本处理未完成', { message })
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
        overline="Project memory"
        title="项目级翻译档案"
        actions={
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="hidden sm:inline-flex">
              {projects.length} 个活跃项目
            </Badge>
            <Button
              size="sm"
              disabled={decidingRevisionId !== null}
              onClick={() => setProjectModalOpen(true)}
            >
              新建项目
            </Button>
          </div>
        }
        testId="project-memory-panel"
      >
        <p className="text-sm leading-6 text-ink-3">
          集中维护术语、专名、文风与已确认决策。新建议尚未进入会话；只有人工批准后才会生成新的项目快照。
        </p>

        {projectLoading ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-ink-3">
            <Spinner size="sm" />加载项目档案…
          </div>
        ) : projectError ? (
          <div className="mt-4 rounded-sm border border-line bg-paper-sink px-3 py-3">
            <p role="alert" className="text-sm leading-6 text-ink-2">{projectError}</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => void loadProjects()}>
              重试项目加载
            </Button>
          </div>
        ) : projects.length === 0 ? (
          <div className="mt-4 rounded-sm border border-dashed border-line-2 px-4 py-5 text-center">
            <p className="font-serif text-sm text-ink">尚未创建翻译项目</p>
            <p className="mt-1 text-xs leading-5 text-ink-4">
              先固定语言方向，再逐条积累经过人工审核的项目知识。
            </p>
          </div>
        ) : (
          <div className="mt-4">
            <p className="mb-2 text-xs font-medium text-ink-2">选择活跃项目</p>
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
                          {DIRECTION_LABELS[project.direction]}
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
                    {selectedProject.description || '暂无项目说明。'}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="solid">{DIRECTION_LABELS[selectedProject.direction]}</Badge>
                  <Badge variant="outline">方向创建后不可编辑</Badge>
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
                  重试档案详情
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
                <Spinner size="sm" />加载资源、建议与快照…
              </div>
            ) : (
              <>
                <section className="mt-5" aria-labelledby="project-resources-heading">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 id="project-resources-heading" className="font-serif text-sm font-medium text-ink">
                        档案资源与当前版本
                      </h3>
                      <p className="mt-1 text-xs text-ink-4">新建建议的作用范围统一为整个项目。</p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setResourceFormError(null)
                        setResourceModalOpen(true)
                      }}
                    >
                      新建档案建议
                    </Button>
                  </div>

                  {resources.length === 0 ? (
                    <p className="mt-3 rounded-sm border border-dashed border-line-2 px-3 py-4 text-center text-xs text-ink-4">
                      暂无资源。创建的第一版会保持“待批准”，不会直接进入会话。
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
                                  <Badge variant="subtle">{RESOURCE_KIND_LABELS[revision.kind]}</Badge>
                                  <Badge variant={revision.status === 'approved' ? 'solid' : 'outline'}>
                                    {REVISION_STATUS_LABELS[revision.status]}
                                  </Badge>
                                  <span className="text-xs text-ink-4">revision {revision.revisionNo}</span>
                                  <span className="max-w-full truncate text-xs text-ink-4" title={scopeLabel(revision.scope)}>
                                    {scopeLabel(revision.scope)}
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
                                    {deciding && decidingAction === 'approve' && <Spinner size="sm" />}批准
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={decidingRevisionId !== null}
                                    onClick={() => void decideRevision(entry, 'reject')}
                                  >
                                    {deciding && decidingAction === 'reject' && <Spinner size="sm" />}拒绝
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
                      待审建议
                    </h3>
                    <Badge variant="outline">绝不自动批准</Badge>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-ink-4">
                    来自 Agent 的 pending 条目会标记为“AI 建议”；这里只展示，不自动批准或写入项目快照。
                  </p>
                  {pendingSuggestions.length === 0 ? (
                    <p className="mt-3 text-xs text-ink-4">暂无 pending 建议。</p>
                  ) : (
                    <ul className="mt-3 space-y-2">
                      {pendingSuggestions.map((suggestion) => (
                        <li key={suggestion.id} className="rounded-sm border border-line bg-paper/55 px-3 py-3">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant="subtle">{RESOURCE_KIND_LABELS[suggestion.kind]}</Badge>
                            <Badge variant={suggestion.source.type === 'agent_suggestion' ? 'solid' : 'outline'}>
                              {suggestion.source.type === 'agent_suggestion' ? 'AI 建议' : 'pending'}
                            </Badge>
                            <span className="max-w-full truncate text-xs text-ink-4" title={scopeLabel(suggestion.scope)}>
                              {scopeLabel(suggestion.scope)}
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
                      项目快照
                    </h3>
                    {latestSnapshot && <Badge variant="solid">revision {latestSnapshot.revisionNo}</Badge>}
                  </div>
                  {latestSnapshot ? (
                    <div className="mt-3 rounded-sm border border-line bg-paper-sink px-3 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="font-medium text-ink-2">
                          当前 snapshot revision {latestSnapshot.revisionNo}
                        </span>
                        <span className="font-mono text-ink-4" title={latestSnapshot.contentHash}>
                          hash {snapshotHashSummary(latestSnapshot.contentHash)}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-ink-4">
                        包含 {latestSnapshot.approvedResourceRevisionIds.length} 条已批准资源版本
                      </p>
                    </div>
                  ) : (
                    <p className="mt-3 text-xs text-ink-4">尚无可用快照摘要。</p>
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
        title="新建翻译项目"
        aria-label="新建翻译项目"
        footer={
          <>
            <Button variant="ghost" size="sm" disabled={projectSaving} onClick={() => setProjectModalOpen(false)}>
              取消
            </Button>
            <Button size="sm" disabled={projectSaving} onClick={() => void createProject()}>
              {projectSaving && <Spinner size="sm" />}创建项目
            </Button>
          </>
        }
        testId="create-project-modal"
      >
        <div className="space-y-4">
          <Field label="项目名称">
            <Input
              value={projectDraft.name}
              onChange={(event) => setProjectDraft((current) => ({ ...current, name: event.target.value }))}
              placeholder="例如：长篇小说第一卷"
              aria-label="项目名称"
              maxLength={200}
              autoFocus
            />
          </Field>
          <Field label="翻译方向" hint="项目创建后不可编辑。">
            <Select
              value={projectDraft.direction}
              aria-label="翻译方向"
              onChange={(event) => {
                const direction = event.target.value as TranslationDirection
                setProjectDraft((current) => ({
                  ...current,
                  direction,
                  ...projectLanguagesForDirection(direction),
                }))
              }}
            >
              <option value="en_to_zh">英译中</option>
              <option value="zh_to_en">中译英</option>
              <option value="custom">自定义</option>
            </Select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="源语言">
              <Input
                value={projectDraft.sourceLang}
                readOnly={projectDraft.direction !== 'custom'}
                onChange={(event) => setProjectDraft((current) => ({ ...current, sourceLang: event.target.value }))}
                placeholder="例如：日文"
                aria-label="源语言"
                maxLength={100}
              />
            </Field>
            <Field label="目标语言">
              <Input
                value={projectDraft.targetLang}
                readOnly={projectDraft.direction !== 'custom'}
                onChange={(event) => setProjectDraft((current) => ({ ...current, targetLang: event.target.value }))}
                placeholder="例如：中文"
                aria-label="目标语言"
                maxLength={100}
              />
            </Field>
          </div>
          <Field label="项目说明" hint="可填写作品背景、受众或长期翻译目标。">
            <Textarea
              rows={4}
              value={projectDraft.description}
              onChange={(event) => setProjectDraft((current) => ({ ...current, description: event.target.value }))}
              placeholder="可选"
              aria-label="项目说明"
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
        title="新建档案建议"
        aria-label="新建档案建议"
        footer={
          <>
            <Button variant="ghost" size="sm" disabled={resourceSaving} onClick={() => setResourceModalOpen(false)}>
              取消
            </Button>
            <Button size="sm" disabled={resourceSaving} onClick={() => void createResource()}>
              {resourceSaving && <Spinner size="sm" />}保存为建议
            </Button>
          </>
        }
        testId="create-project-resource-modal"
      >
        <div className="space-y-4">
          <div className="rounded-sm border border-line bg-paper-sink px-3 py-2 text-xs leading-5 text-ink-3">
            作用范围固定为整个项目。保存后只创建 suggested revision，建议尚未进入会话，必须由人批准或拒绝。
          </div>
          <Field label="资源类型">
            <Select
              value={resourceDraft.kind}
              aria-label="资源类型"
              onChange={(event) => {
                const kind = event.target.value as ProjectResourceKind
                setResourceDraft({ ...EMPTY_RESOURCE_DRAFT, kind })
                setResourceFormError(null)
              }}
            >
              {RESOURCE_KINDS.map((kind) => (
                <option key={kind} value={kind}>{RESOURCE_KIND_LABELS[kind]}</option>
              ))}
            </Select>
          </Field>

          {usesSourceAndTarget(resourceDraft.kind) && (
            <>
              <Field label="原文内容">
                <Textarea
                  rows={3}
                  value={resourceDraft.sourceText}
                  onChange={(event) => setResourceDraft((current) => ({ ...current, sourceText: event.target.value }))}
                  aria-label="档案原文内容"
                  maxLength={200_000}
                />
              </Field>
              <Field label="对应译文">
                <Textarea
                  rows={3}
                  value={resourceDraft.targetText}
                  onChange={(event) => setResourceDraft((current) => ({ ...current, targetText: event.target.value }))}
                  aria-label="档案对应译文"
                  maxLength={200_000}
                />
              </Field>
            </>
          )}

          {usesCharacterVoiceFields(resourceDraft.kind) && (
            <>
              <Field label="人物示例原文">
                <Textarea
                  rows={3}
                  value={resourceDraft.sourceText}
                  onChange={(event) => setResourceDraft((current) => ({ ...current, sourceText: event.target.value }))}
                  aria-label="人物示例原文"
                  maxLength={200_000}
                />
              </Field>
              <Field label="语气与表达规则">
                <Textarea
                  rows={4}
                  value={resourceDraft.instruction}
                  onChange={(event) => setResourceDraft((current) => ({ ...current, instruction: event.target.value }))}
                  aria-label="人物语气规则"
                  maxLength={100_000}
                />
              </Field>
            </>
          )}

          {!usesSourceAndTarget(resourceDraft.kind) && !usesCharacterVoiceFields(resourceDraft.kind) && (
            <Field label="规则内容">
              <Textarea
                rows={5}
                value={resourceDraft.instruction}
                onChange={(event) => setResourceDraft((current) => ({ ...current, instruction: event.target.value }))}
                aria-label="档案规则内容"
                maxLength={100_000}
              />
            </Field>
          )}

          <Field label="备注" hint="可选；用于解释这条建议的背景。">
            <Textarea
              rows={2}
              value={resourceDraft.note}
              onChange={(event) => setResourceDraft((current) => ({ ...current, note: event.target.value }))}
              aria-label="档案备注"
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
