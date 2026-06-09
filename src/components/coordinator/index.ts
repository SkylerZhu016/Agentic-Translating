// ---------------------------------------------------------------------------
// 统筹视图统一出口（Wave 4 Task 23）
// emitSessionChanged 同时供翻译/聊天面板（Task 22/24）广播会话变更
// ---------------------------------------------------------------------------

export { CoordinatorPanel } from './CoordinatorPanel'
export { CoordinatorFinalText } from './CoordinatorFinalText'
export { StageStepper, type StageStepperProps } from './StageStepper'
export { StageOutputPanel, type StageOutputPanelProps } from './StageOutputPanel'
export { emitSessionChanged, SESSION_CHANGED_EVENT } from './session-bus'
export { useSessionFull, type SessionFullResponse } from './use-session'
export {
  STAGES,
  STAGE_INDEX,
  canRunStage,
  stageBlockReason,
  allStagesComplete,
  toStageRowMap,
  type StageRowMap,
  type StageStatus,
} from './stage-meta'
