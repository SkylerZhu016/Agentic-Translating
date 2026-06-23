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
  /** 会话处于可聊天状态（assembled/refining） */
  canChat: boolean
  /** 不可聊天时的占位提示 */
  disabledHint: string
  onSend: (message: string) => void
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

export function ChatPanel({ messages, streaming, canChat, disabledHint, onSend }: ChatPanelProps) {
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  // 新内容出现（含流式 delta）时吸附到底部
  const lastMessage = messages[messages.length - 1]
  const scrollSignal = `${messages.length}:${lastMessage?.content.length ?? 0}:${lastMessage?.toolCalls?.length ?? 0}`
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [scrollSignal])

  const send = () => {
    const value = draft.trim()
    if (!value || streaming || !canChat) return
    setDraft('')
    onSend(value)
  }

  const inputDisabled = !canChat || streaming

  return (
    <div data-testid={TID.edit.chatPanel} className="flex h-full flex-col">
      {/* 消息流 */}
      <div ref={scrollRef} className="max-h-96 min-h-56 flex-1 overflow-y-auto px-5 py-4">
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
          <span className="text-[0.6875rem] text-ink-4">
            {streaming ? '统筹 Agent 回复中…' : '修改通过替换工具落版，历史可追溯'}
          </span>
          <Button size="sm" onClick={send} disabled={inputDisabled || draft.trim().length === 0}>
            {streaming ? <Spinner size="sm" /> : '发送'}
          </Button>
        </div>
      </div>
    </div>
  )
}
