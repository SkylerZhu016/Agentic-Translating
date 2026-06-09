// ---------------------------------------------------------------------------
// 会话变更总线 —— 兼容出口（canonical 实现位于 src/lib/client/session-bus）
// 保留本路径仅为统筹面板内部引用稳定；新代码一律引用 lib 路径
// ---------------------------------------------------------------------------

export {
  SESSION_CHANGED_EVENT,
  emitSessionChanged,
  onSessionChanged,
  type SessionChangedDetail,
} from '@/src/lib/client/session-bus'
