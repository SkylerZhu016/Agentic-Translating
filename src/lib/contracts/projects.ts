import type { TranslationDirection } from './vnext'

export type ProjectStatus = 'active' | 'archived'

export type ProjectResourceKind =
  | 'term'
  | 'proper_noun'
  | 'character_voice'
  | 'style_rule'
  | 'approved_decision'
  | 'context_note'
  | 'parallel_excerpt'
  | 'counterexample'

export type ProjectResourceRevisionStatus =
  | 'suggested'
  | 'approved'
  | 'rejected'
  | 'retired'

export interface ProjectResourceContent {
  sourceText: string | null
  targetText: string | null
  instruction: string | null
  note: string
}

export type ProjectResourceSourceType =
  | 'user'
  | 'session_patch'
  | 'disagreement_decision'
  | 'agent_suggestion'
  | 'import'

export interface ProjectResourceSource {
  type: ProjectResourceSourceType
  sessionId: string | null
  referenceId: string | null
  note: string
}

export type ProjectResourceScopeLevel =
  | 'project'
  | 'document'
  | 'character'

export interface ProjectResourceScope {
  direction: TranslationDirection
  level: ProjectResourceScopeLevel
  selector: string | null
  pinned: boolean
}

export interface TranslationProject {
  id: string
  name: string
  description: string
  direction: TranslationDirection
  sourceLang: string
  targetLang: string
  status: ProjectStatus
  currentSnapshotId: string | null
  currentSnapshotRevisionNo: number | null
  currentSnapshotSummary: ProjectSnapshotSummary
  createdAt: string
  updatedAt: string
}

export interface ProjectSnapshotSummary {
  snapshotId: string | null
  revisionNo: number | null
  resourceCount: number
  tokenEstimate: number
}

export interface ProjectResource {
  id: string
  projectId: string
  createdAt: string
}

export interface ProjectResourceRevision {
  id: string
  resourceId: string
  revisionNo: number
  kind: ProjectResourceKind
  content: ProjectResourceContent
  status: ProjectResourceRevisionStatus
  source: ProjectResourceSource
  scope: ProjectResourceScope
  createdAt: string
}

export interface ProjectResourceWithCurrentRevision {
  resource: ProjectResource
  currentRevision: ProjectResourceRevision
}

export interface ProjectSnapshot {
  id: string
  projectId: string
  revisionNo: number
  approvedResourceRevisionIds: string[]
  contentHash: string
  createdAt: string
}

export type ProjectSuggestionStatus = 'pending' | 'approved' | 'rejected'

export interface ProjectMemorySuggestion {
  id: string
  projectId: string
  kind: ProjectResourceKind
  content: ProjectResourceContent
  source: ProjectResourceSource
  scope: ProjectResourceScope
  status: ProjectSuggestionStatus
  materializedResourceId: string | null
  resolvedRevisionId: string | null
  createdAt: string
  resolvedAt: string | null
}

export interface FrozenProjectResource {
  resourceId: string
  revision: ProjectResourceRevision
}

export interface SessionProjectContext {
  id: string
  sessionId: string
  projectId: string
  projectSnapshotId: string
  direction: TranslationDirection
  sourceLang: string
  targetLang: string
  resourceRevisionIds: string[]
  resources: FrozenProjectResource[]
  tokenEstimate: number
  createdAt: string
}
