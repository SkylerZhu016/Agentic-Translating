'use client'

// ---------------------------------------------------------------------------
// ChatPanel —— 对话修订面板
// 消息流（用户右 / AI 左 / tool 居中系统条），AI 流式渲染；工具调用渲染
// tool-call-badge（替换「old…」→「new…」+ 成功墨绿 / 失败朱红 + diffSummary）；
// 输入框 Enter 发送 / Shift+Enter 换行。
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from 'react'
import { TID } from '@/src/lib/testids'
import { Button, Spinner, Textarea } from '@/src/components/ui'
import { truncate, type ChatMessageView, type ToolCallView } from './types'

export interface ChatPanelProps {
  messages: ChatMessageView[]
  /** 有聊天请求在飞（禁用输入） */
  streaming: boolean
  /** 请求由另一个标签页或自动化客户端发起 */
  remoteStreaming?: boolean
  /** 本轮请求开始时间，用于显示持续等待而非“假死” */
  activityStartedAt?: number | null
  activityPhase?: 'waiting_for_model' | 'thinking' | 'generating' | 'applying_edits'
  /** 会话处于可聊天状态（assembled/refining） */
  canChat: boolean
  /** 不可聊天时的占位提示 */
  disabledHint: string
  onSend: (message: string) => void
  /** 把普通用户的模糊感受细化为可审阅的局部修订意见；不会自动发送或改文 */
  onSuggest?: (message: string) => Promise<string>
}

// ── 工具调用徽章 ──────────────────────────────────────────────

function ToolCallBadge({ call }: { call: ToolCallView }) {
  const label = `替换「${truncate(call.oldString, 20)}」→「${truncate(call.newString, 20)}」`

  const tone =
    call.status === 'ok'
      ? 'border-moss/45 bg-moss/10 text-moss'
      : call.status === 'failed'
        ? 'border-cinnabar/45 bg-cinnabar/10 text-cinnabar'
        : 'border-line-2 bg-paper-sink/60 text-ink-3'

  return (
    <div className="mt-2">
      <span
        data-testid={TID.edit.toolCallBadge}
        data-status={call.status}
        className={`inline-flex max-w-full items-center gap-1.5 rounded-xs border px-2 py-1 font-serif text-[0.75rem] leading-4 ${tone}`}
      >
        {call.status === 'pending' && <Spinner size="sm" className="shrink-0" />}
        {call.status === 'ok' && (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3 shrink-0" aria-hidden>
            <path d="M4.5 12.5l5 5 10-11" />
          </svg>
        )}
        {call.status === 'failed' && (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="h-3 w-3 shrink-0" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        )}
        <span className="min-w-0 break-all">{label}</span>
      </span>
      {call.status === 'failed' && (
        <p className="mt-1 text-[0.6875rem] leading-4 text-cinnabar">替换未生效：未找到唯一匹配，文本保持不变</p>
      )}
      {call.status === 'ok' && call.diffSummary && (
        <p className="mt-1 text-[0.6875rem] leading-4 text-ink-3">{call.diffSummary}</p>
      )}
    </div>
  )
}

// ── 单条消息 ─────────────────────────────────────────────────

function MessageItem({ message }: { message: ChatMessageView }) {
  if (message.role === 'tool') {
    // 系统条（如"已恢复到版本 N"）
    return (
      <li data-testid={TID.edit.chatMessage} data-role="tool" className="flex justify-center">
        <span className="inline-flex items-center gap-2 text-[0.6875rem] tracking-wide text-ink-4">
          <span className="h-px w-6 bg-line" aria-hidden />
          {message.content}
          <span className="h-px w-6 bg-line" aria-hidden />
        </span>
      </li>
    )
  }

  if (message.role === 'user') {
    return (
      <li data-testid={TID.edit.chatMessage} data-role="user" className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-md rounded-br-xs bg-ink px-3 py-2 text-sm leading-6 text-paper">
          {message.content}
        </div>
      </li>
    )
  }

  // assistant
  return (
    <li data-testid={TID.edit.chatMessage} data-role="assistant" className="flex justify-start">
      <div className="max-w-[92%] rounded-md rounded-bl-xs border border-line bg-paper px-3 py-2">
        <div className="whitespace-pre-wrap break-words text-sm leading-6 text-ink-2">
          {message.content}
          {message.streaming && (
            <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-[3px] animate-pulse bg-ink" aria-hidden />
          )}
        </div>
        {message.toolCalls?.map((call) => <ToolCallBadge key={call.id} call={call} />)}
        {message.error && (
          <p className="mt-1.5 text-[0.75rem] leading-4 text-cinnabar">{message.error}</p>
        )}
      </div>
    </li>
  )
}

// ── 面板 ─────────────────────────────────────────────────────

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return minutes > 0 ? `${minutes} 分 ${remainder} 秒` : `${remainder} 秒`
}

export function ChatPanel({
  messages,
  streaming,
  remoteStreaming = false,
  activityStartedAt = null,
  activityPhase = 'waiting_for_model',
  canChat,
  disabledHint,
  onSend,
  onSuggest,
}: ChatPanelProps) {
  const [draft, setDraft] = useState('')
  const [suggesting, setSuggesting] = useState(false)
  const [suggestionStartedAt, setSuggestionStartedAt] = useState<number | null>(null)
  const [suggestionError, setSuggestionError] = useState<string | null>(null)
  const [clock, setClock] = useState(() => Date.now())
  const scrollRef = useRef<HTMLDivElement>(null)

  // 新内容出现（含流式 delta）时吸附到底部
  const lastMessage = messages[messages.length - 1]
  const scrollSignal = `${messages.length}:${lastMessage?.content.length ?? 0}:${lastMessage?.toolCalls?.length ?? 0}`
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [scrollSignal])

  useEffect(() => {
    if (!streaming && !suggesting) return
    setClock(Date.now())
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [streaming, suggesting])

  const elapsed = activityStartedAt == null
    ? null
    : formatElapsed(clock - activityStartedAt)

  const send = () => {
    const value = draft.trim()
    if (!value || streaming || !canChat) return
    setDraft('')
    onSend(value)
  }

  const suggest = async () => {
    const value = draft.trim()
    if (!value || streaming || suggesting || !canChat || !onSuggest) return
    setSuggesting(true)
    setSuggestionStartedAt(Date.now())
    setSuggestionError(null)
    try {
      const feedback = (await onSuggest(value)).trim()
      if (!feedback) throw new Error('模型没有返回可用建议')
      setDraft(feedback)
    } catch (error) {
      setSuggestionError(
        error instanceof Error ? error.message : '细化修改意见失败',
      )
    } finally {
      setSuggesting(false)
      setSuggestionStartedAt(null)
    }
  }

  const inputDisabled = !canChat || streaming || suggesting
  const activityLabel = activityPhase === 'waiting_for_model'
    ? '正在等待模型开始输出'
    : activityPhase === 'thinking'
      ? '已收到模型活动，正在思考'
    : activityPhase === 'applying_edits'
      ? '正在核对并应用修改'
      : '正在生成回复'
  const suggestionElapsed = suggestionStartedAt == null
    ? null
    : formatElapsed(clock - suggestionStartedAt)

  return (
    <div data-testid={TID.edit.chatPanel} className="flex h-full flex-col">
      {/* 消息流 */}
      <div ref={scrollRef} className="max-h-96 min-h-56 flex-1 overflow-y-auto px-5 py-4">
        {streaming && (
          <div
            role="status"
            aria-live="polite"
            className="mb-3 flex items-center gap-2 rounded-sm border border-line bg-paper-sink/55 px-3 py-2 text-xs text-ink-3"
          >
            <Spinner size="sm" className="shrink-0" />
            <span>
              {remoteStreaming
                ? `另一处正在执行对话修订 · ${activityLabel}`
                : `统筹 Agent ${activityLabel}`}
              {elapsed ? ` · 已等待 ${elapsed}` : ''}
              {' · 页面仍在工作'}
            </span>
          </div>
        )}
        {messages.length === 0 ? (
          <div className="flex h-full min-h-44 items-center justify-center">
            <p className="max-w-60 text-center text-sm leading-6 text-ink-4">
              选中译文片段提出修改指令，或与统筹 Agent 持续对话打磨译文
            </p>
          </div>
        ) : (
          <ol className="space-y-3">
            {messages.map((m) => (
              <MessageItem key={m.id} message={m} />
            ))}
          </ol>
        )}
      </div>

      {/* 输入区 */}
      <div className="border-t border-line px-5 py-3">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
          rows={2}
          disabled={inputDisabled}
          placeholder={canChat ? '继续打磨译文……（Enter 发送，Shift+Enter 换行）' : disabledHint}
          aria-label="聊天输入"
          className="resize-none"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className={`min-w-0 pr-2 text-[0.6875rem] ${suggestionError ? 'text-cinnabar' : 'text-ink-4'}`}>
            {suggestionError
              ? suggestionError
              : suggesting
                ? `目标语读者与双语核验者正在分别定位问题${suggestionElapsed ? ` · 已等待 ${suggestionElapsed}` : ''}，结果只会回填输入框`
              : streaming
              ? `${remoteStreaming ? '其他客户端正在修订' : '统筹 Agent 回复中'}${elapsed ? ` · ${elapsed}` : ''}`
              : '修改通过替换工具落版，历史可追溯'}
          </span>
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            {onSuggest && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void suggest()}
                disabled={inputDisabled || draft.trim().length === 0}
                title="让两个隔离审查镜头把当前感受细化为具体修改意见；不会自动发送"
              >
                {suggesting ? <Spinner size="sm" /> : '细化意见'}
              </Button>
            )}
            <Button size="sm" onClick={send} disabled={inputDisabled || draft.trim().length === 0}>
              {streaming ? <Spinner size="sm" /> : '发送'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
