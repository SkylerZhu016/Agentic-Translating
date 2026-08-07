// ---------------------------------------------------------------------------
// 编辑+聊天视图共享模型 —— 服务端行记录 & 本地流式渲染视图模型
// ---------------------------------------------------------------------------

import type { ChatMessage, FinalVersion, SessionState } from '@/src/lib/contracts/types'

export type { ChatMessage, FinalVersion, SessionState }

/** 工具调用渲染状态（tool_call → tool_result 配对） */
export interface ToolCallView {
  id: string
  /** replace_text 用 old/new 摘要；编程工具（file_read/file_edit/run_command）显示工具名+参数 */
  toolName?: string
  oldString: string
  newString: string
  status: 'pending' | 'ok' | 'failed'
  diffSummary?: string
}

/** 聊天消息视图模型：服务端历史 + 本地乐观/流式消息统一渲染 */
export interface ChatMessageView {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  createdAt?: string
  /** 流式进行中（AI 消息追加 delta） */
  streaming?: boolean
  /** 本轮出错（message_complete.error / 网络失败） */
  error?: string
  /** 本轮发生的工具调用（仅流式期间渲染 badge；历史消息服务端不落 tool_calls） */
  toolCalls?: ToolCallView[]
}

/** 选中片段快照（提交时随 selection 一起快照，防响应期间光标移动） */
export interface SelectionSnapshot {
  text: string
  start: number
  end: number
}

/** 截断工具：片段预览/徽章文案 */
export function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}
