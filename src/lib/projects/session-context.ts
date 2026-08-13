import type Database from 'better-sqlite3'
import type {
  FrozenProjectResource,
  ProjectResourceRevision,
  SessionProjectContext,
} from '../contracts/projects'
import { createProjectRepositories } from '../db/project-repositories'

type PromptLanguage = 'zh' | 'en'

const KIND_LABELS: Record<
  ProjectResourceRevision['kind'],
  { zh: string; en: string }
> = {
  term: { zh: '术语', en: 'Term' },
  proper_noun: { zh: '专有名词', en: 'Proper noun' },
  character_voice: { zh: '人物声音', en: 'Character voice' },
  style_rule: { zh: '文体准则', en: 'Style rule' },
  approved_decision: { zh: '已批准取舍', en: 'Approved decision' },
  context_note: { zh: '背景说明', en: 'Context note' },
  parallel_excerpt: { zh: '平行语料', en: 'Parallel excerpt' },
  counterexample: { zh: '反例', en: 'Counterexample' },
}

function compact(value: string | null): string | null {
  const normalized = value?.replace(/\r\n?/g, '\n').trim()
  return normalized ? normalized : null
}

function scopeText(
  revision: ProjectResourceRevision,
  language: PromptLanguage,
): string {
  const { scope } = revision
  const pinned = scope.pinned
    ? language === 'en'
      ? ', pinned'
      : '，固定优先'
    : ''
  if (scope.level === 'project') {
    return language === 'en' ? `project-wide${pinned}` : `项目级${pinned}`
  }
  const selector = compact(scope.selector) ?? ''
  if (language === 'en') {
    return `${scope.level === 'document' ? 'document' : 'character'}: ${selector}${pinned}`
  }
  return `${scope.level === 'document' ? '文档' : '人物'}：${selector}${pinned}`
}

function resourceText(
  resource: FrozenProjectResource,
  index: number,
  language: PromptLanguage,
): string {
  const revision = resource.revision
  const content = revision.content
  const source = compact(content.sourceText)
  const target = compact(content.targetText)
  const instruction = compact(content.instruction)
  const note = compact(content.note)
  const label = KIND_LABELS[revision.kind][language]
  const lines = [
    `${index + 1}. [${label} · ${scopeText(revision, language)} · revision ${revision.revisionNo}]`,
  ]

  if (source && target) {
    lines.push(
      language === 'en'
        ? `   Approved correspondence: ${source} -> ${target}`
        : `   已批准对应：${source} → ${target}`,
    )
  } else if (source) {
    lines.push(
      language === 'en' ? `   Source expression: ${source}` : `   原文表达：${source}`,
    )
  } else if (target) {
    lines.push(
      language === 'en' ? `   Target expression: ${target}` : `   目标语表达：${target}`,
    )
  }
  if (instruction) {
    lines.push(
      language === 'en' ? `   Guidance: ${instruction}` : `   准则：${instruction}`,
    )
  }
  if (note) {
    lines.push(language === 'en' ? `   Note: ${note}` : `   备注：${note}`)
  }
  return lines.join('\n')
}

/**
 * Render the user-approved, immutable project snapshot as user-context data.
 * It never becomes part of a system prompt and contains no endpoint material.
 */
export function formatSessionProjectContext(
  context: SessionProjectContext | null | undefined,
  language: PromptLanguage,
): string {
  if (!context || context.resources.length === 0) return ''
  const header = language === 'en'
    ? [
        'User-approved project translation archive (frozen for this session):',
        'Use relevant entries consistently and verify every application against the current source and task brief. Do not force an entry onto unrelated wording. If two entries conflict, preserve the conflict for review instead of silently choosing one.',
      ]
    : [
        '用户已批准的项目翻译档案（本会话冻结快照）：',
        '与当前原文相关的条目应保持一致，并逐项结合原文和任务要求核验。无关条目不要强行套用；条目相互冲突时保留冲突，交给后续审议，不要静默任选其一。',
      ]
  return [
    ...header,
    ...context.resources.map((resource, index) =>
      resourceText(resource, index, language),
    ),
  ].join('\n\n')
}

export function getSessionProjectContext(
  db: Database.Database,
  sessionId: string,
): SessionProjectContext | null {
  return (
    createProjectRepositories(db).sessionProjectContexts.getBySession(
      sessionId,
    ) ?? null
  )
}

export function sessionProjectContextBlock(
  db: Database.Database,
  sessionId: string,
  language: PromptLanguage,
): string {
  return formatSessionProjectContext(
    getSessionProjectContext(db, sessionId),
    language,
  )
}

/**
 * Append the immutable project archive to model-visible user data.
 * Keeping this operation here makes it difficult for individual prompt paths
 * to accidentally place project resources in a system message.
 */
export function appendSessionProjectContext(
  db: Database.Database,
  sessionId: string,
  language: PromptLanguage,
  userContent: string,
): string {
  const block = sessionProjectContextBlock(db, sessionId, language)
  return block ? `${userContent}\n\n${block}` : userContent
}

/** Copy the exact immutable archive used by one session to a newly created one. */
export function cloneSessionProjectContext(
  db: Database.Database,
  sourceSessionId: string,
  targetSessionId: string,
): SessionProjectContext | null {
  const repositories = createProjectRepositories(db)
  const source = repositories.sessionProjectContexts.getBySession(
    sourceSessionId,
  )
  if (!source) return null
  return repositories.sessionProjectContexts.freezeForSession({
    sessionId: targetSessionId,
    projectId: source.projectId,
    projectSnapshotId: source.projectSnapshotId,
    direction: source.direction,
    resourceRevisionIds: source.resourceRevisionIds,
    tokenEstimate: source.tokenEstimate,
  })
}
