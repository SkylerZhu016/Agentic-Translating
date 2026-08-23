import type { Stage } from '@/src/lib/contracts/types'
import type { Translator } from '@/src/i18n/types'
import {
  COORDINATION_RUN_STATES,
  STAGES,
  STAGE_INDEX,
  canRunStage,
  type StageRowMap,
  type StageStatus,
} from './stage-meta'

export function localizedStageMeta(stage: Stage, t: Translator) {
  switch (stage) {
    case 'review':
      return { label: t('stage.review.label'), hint: t('stage.review.hint') }
    case 'filter':
      return { label: t('stage.filter.label'), hint: t('stage.filter.hint') }
    case 'orchestrate':
      return { label: t('stage.orchestrate.label'), hint: t('stage.orchestrate.hint') }
    case 'assemble':
      return { label: t('stage.assemble.label'), hint: t('stage.assemble.hint') }
  }
}

export function localizedStageStatus(status: StageStatus, t: Translator) {
  switch (status) {
    case 'pending': return t('stage.status.pending')
    case 'running': return t('stage.status.running')
    case 'complete': return t('stage.status.complete')
    case 'failed': return t('stage.status.failed')
    case 'stale': return t('stage.status.stale')
  }
}

export function localizedStageBlockReason(
  stage: Stage,
  rows: StageRowMap,
  sessionState: string | null,
  runningStage: Stage | null,
  t: Translator,
) {
  if (canRunStage(stage, rows, sessionState, runningStage)) return null
  if (runningStage !== null) {
    return runningStage === stage ? null : t('stage.block.otherRunning')
  }
  if (sessionState == null) return t('stage.block.noSession')
  if (!COORDINATION_RUN_STATES.has(sessionState)) return t('stage.block.waitTranslation')
  const index = STAGE_INDEX[stage]
  if (index > 0) {
    const prerequisite = STAGES[index - 1]
    const label = localizedStageMeta(prerequisite.key, t).label
    const status = rows[prerequisite.key]?.status ?? 'pending'
    if (status === 'stale') return t('stage.block.stalePrerequisite', { stage: label })
    if (status === 'failed') return t('stage.block.failedPrerequisite', { stage: label })
    if (status !== 'complete') return t('stage.block.completePrerequisite', { stage: label })
  }
  return null
}
