'use client'

// ---------------------------------------------------------------------------
// ChatPanel —— 对话修订面板
// 消息流（用户右 / AI 左 / tool 居中系统条），AI 流式渲染；工具调用渲染
// tool-call-badge（替换「old…」→「new…」+ 成功墨绿 / 失败朱红 + diffSummary）；
// 输入框 Enter 发送 / Shift+Enter 换行。
// ---------------------------------------------------------------------------

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { TID } from '@/src/lib/testids'
import { Button, Spinner, Textarea } from '@/src/components/ui'
import { BoundedText, CollapsibleText } from '@/src/components/ui/BoundedText'
import { truncate, type ChatMessageView, type ToolCallView } from './types'
import { useI18n } from '@/src/i18n/LocaleProvider'

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
  disabled?: boolean
  /** 不可聊天时的占位提示 */
  disabledHint: string
  onSend: (message: string) => void
  /** 把普通用户的模糊感受细化为可审阅的局部修订意见；不会自动发送或改文 */
  onSuggest?: (message: string) => Promise<string>
}

// ── 工具调用徽章 ──────────────────────────────────────────────

const ToolCallBadge = memo(function ToolCallBadge({ call }: { call: ToolCallView }) {
  const { t } = useI18n()
  const isReplace = !call.toolName || call.toolName === 'replace_text'
  const label = isReplace
    ? t('chat.tool.replace', {
        old: truncate(call.oldString, 20),
        next: truncate(call.newString, 20),
      })
    : call.toolName === 'file_read'
      ? t('chat.tool.read', { path: truncate(call.oldString, 40) })
      : call.toolName === 'file_edit'
        ? t('chat.tool.edit', { path: truncate(call.oldString, 40) })
        : call.toolName === 'run_command'
          ? t('chat.tool.command', { command: truncate(call.oldString, 40) })
          : `${call.toolName} ${truncate(call.oldString, 40)}`

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
        data-tool={isReplace ? 'replace_text' : call.toolName}
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
      {call.status === 'failed' && isReplace && (
        <p role="alert" className="mt-1 text-[0.6875rem] leading-4 text-cinnabar">{t('chat.tool.replaceFailed')}</p>
      )}
      {call.status === 'ok' && call.diffSummary && (
        <p className="mt-1 text-[0.6875rem] leading-4 text-ink-3">{truncate(call.diffSummary, 160)}</p>
      )}
    </div>
  )
})

// ── 单条消息 ─────────────────────────────────────────────────

const MessageItem = memo(function MessageItem({
  message,
  followRequest,
  onFollowChange,
}: {
  message: ChatMessageView
  followRequest: number
  onFollowChange: (following: boolean) => void
}) {
  const { t } = useI18n()
  if (message.role === 'tool') {
    // 系统条（如"已恢复到版本 N"）
    return (
      <li data-testid={TID.edit.chatMessage} data-role="tool" className="flex justify-center">
        <div className="inline-flex min-w-0 max-w-full items-center gap-2 text-[0.6875rem] tracking-wide text-ink-4">
          <span className="h-px w-6 bg-line" aria-hidden />
          <BoundedText text={message.content} viewportClassName="max-h-40" textClassName="text-[0.6875rem] leading-5 text-ink-4" />
          <span className="h-px w-6 bg-line" aria-hidden />
        </div>
      </li>
    )
  }

  if (message.role === 'user') {
    return (
      <li data-testid={TID.edit.chatMessage} data-role="user" className="flex justify-end">
        <div className="min-w-0 max-w-[92%] rounded-lg rounded-br-sm bg-pine px-3 py-2">
          <BoundedText
            text={message.content}
            downloadFileName="message.txt"
            viewportClassName="max-h-64"
            textClassName="text-sm leading-6 text-paper"
            className="[&_button]:text-paper [&_[data-text-controls]]:border-paper/20 [&_[data-text-controls]]:text-paper/80"
            onFollowChange={onFollowChange}
          />
        </div>
      </li>
    )
  }

  // assistant
  return (
    <li data-testid={TID.edit.chatMessage} data-role="assistant" className="flex justify-start">
      <div className="min-w-0 max-w-[92%] rounded-md rounded-bl-xs border border-line bg-paper px-3 py-2">
        {message.reasoningPreview ? (
          <CollapsibleText
            className={message.content ? 'mb-2 border-b border-line pb-2' : ''}
            title={t('reasoning.preview')}
            meta={t('reasoning.received', { count: message.reasoningCharacters ?? message.reasoningPreview?.length ?? 0 })}
            description={t('reasoning.limited')}
            text={message.reasoningPreview ?? ''}
            tailPreview
            streaming={message.streaming}
            viewportClassName="max-h-44"
            textClassName="font-mono text-xs leading-5 text-ink-3"
            followRequest={followRequest}
            onFollowChange={onFollowChange}
          />
        ) : (message.reasoningCharacters ?? 0) > 0 ? (
          <p className="mb-2 text-[0.6875rem] leading-5 text-ink-4">
            {t('reasoning.stats', { count: message.reasoningCharacters ?? 0 })}
          </p>
        ) : null}
        {(message.content || !(message.reasoningCharacters ?? 0)) && (
          <BoundedText
            text={message.content}
            streaming={message.streaming}
            downloadFileName="assistant-message.txt"
            viewportClassName="max-h-72"
            followRequest={followRequest}
            onFollowChange={onFollowChange}
          />
        )}
        {message.toolCalls?.map((call) => <ToolCallBadge key={call.id} call={call} />)}
        {message.error && (
          <div role="alert" className="mt-1.5">
            <BoundedText
              text={message.error}
              viewportClassName="max-h-40"
              textClassName="text-[0.75rem] leading-5 text-cinnabar"
            />
          </div>
        )}
      </div>
    </li>
  )
})

// ── 面板 ─────────────────────────────────────────────────────

export function ChatPanel({
  messages,
  streaming,
  remoteStreaming = false,
  activityStartedAt = null,
  activityPhase = 'waiting_for_model',
  canChat,
  disabled = false,
  disabledHint,
  onSend,
  onSuggest,
}: ChatPanelProps) {
  const { t, formatDuration } = useI18n()
  const [draft, setDraft] = useState('')
  const [suggesting, setSuggesting] = useState(false)
  const [suggestionStartedAt, setSuggestionStartedAt] = useState<number | null>(null)
  const [suggestionError, setSuggestionError] = useState<string | null>(null)
  const [clock, setClock] = useState(() => Date.now())
  const [visibleCount, setVisibleCount] = useState(40)
  const [followingLatest, setFollowingLatest] = useState(true)
  const [followRequest, setFollowRequest] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const messageListRef = useRef<HTMLOListElement>(null)
  const followingLatestRef = useRef(true)
  const draftRef = useRef('')
  const suggestingRef = useRef(false)
  const suggestionSequence = useRef(0)
  const previousMessageCount = useRef(messages.length)
  followingLatestRef.current = followingLatest

  const handleTextFollowChange = useCallback((following: boolean) => {
    // Reading inside an individual message must also stop the outer list moving.
    if (!following) setFollowingLatest(false)
  }, [])

  // Follow new output only while the reader is already at the bottom.
  const lastMessage = messages[messages.length - 1]
  const scrollSignal = `${messages.length}:${lastMessage?.content.length ?? 0}:${lastMessage?.toolCalls?.length ?? 0}`
  useEffect(() => {
    const el = scrollRef.current
    if (el && followingLatest) el.scrollTop = el.scrollHeight
    const newMessages = Math.max(0, messages.length - previousMessageCount.current)
    if (newMessages > 0 && !followingLatest) setVisibleCount((count) => count + newMessages)
    previousMessageCount.current = messages.length
  }, [scrollSignal, followingLatest, messages.length])

  useEffect(() => {
    const list = messageListRef.current
    if (!list || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const element = scrollRef.current
      if (element && followingLatestRef.current) element.scrollTop = element.scrollHeight
    })
    observer.observe(list)
    return () => observer.disconnect()
  }, [messages.length > 0])

  useEffect(() => () => {
    suggestionSequence.current += 1
  }, [])

  useEffect(() => {
    if (!streaming && !suggesting) return
    setClock(Date.now())
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [streaming, suggesting])

  const elapsed = activityStartedAt == null
    ? null
    : formatDuration(clock - activityStartedAt, { maxParts: 2 })

  const send = () => {
    const value = draftRef.current.trim()
    if (!value || streaming || disabled || suggestingRef.current || !canChat) return
    draftRef.current = ''
    setDraft('')
    setSuggestionError(null)
    setFollowingLatest(true)
    onSend(value)
  }

  const suggest = async () => {
    const value = draftRef.current.trim()
    if (!value || streaming || disabled || suggestingRef.current || !canChat || !onSuggest) return
    suggestingRef.current = true
    const sequence = ++suggestionSequence.current
    setSuggesting(true)
    setSuggestionStartedAt(Date.now())
    setSuggestionError(null)
    try {
      const feedback = (await onSuggest(value)).trim()
      if (suggestionSequence.current !== sequence) return
      if (!feedback) throw new Error(t('chat.suggestion.empty'))
      draftRef.current = feedback
      setDraft(feedback)
    } catch (error) {
      if (suggestionSequence.current !== sequence) return
      setSuggestionError(
        error instanceof Error ? error.message : t('chat.suggestion.failed'),
      )
    } finally {
      if (suggestionSequence.current === sequence) {
        suggestingRef.current = false
        setSuggesting(false)
        setSuggestionStartedAt(null)
      }
    }
  }

  const inputDisabled = !canChat || streaming || suggesting || disabled
  const activityLabel = activityPhase === 'waiting_for_model'
    ? t('chat.activity.waiting')
    : activityPhase === 'thinking'
      ? t('chat.activity.thinking')
    : activityPhase === 'applying_edits'
      ? t('chat.activity.applying')
      : t('chat.activity.generating')
  const suggestionElapsed = suggestionStartedAt == null
    ? null
    : formatDuration(clock - suggestionStartedAt, { maxParts: 2 })

  return (
    <div data-testid={TID.edit.chatPanel} className="flex h-full flex-col">
      {/* 消息流 */}
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget
          setFollowingLatest(element.scrollHeight - element.scrollTop - element.clientHeight < 48)
        }}
        className={`max-h-[28rem] flex-1 overflow-y-auto overscroll-contain px-4 py-3 ${messages.length > 0 ? 'min-h-28' : ''}`}
      >
        {streaming && (
          <div
            role="status"
            aria-live="polite"
            className="mb-3 flex items-center gap-2 rounded-sm border border-line bg-paper-sink/55 px-3 py-2 text-xs text-ink-3"
          >
            <Spinner size="sm" className="shrink-0" />
            <span>
              {remoteStreaming
                ? t('chat.activity.remote', { activity: activityLabel })
                : t('chat.activity.local', { activity: activityLabel })}
              {elapsed ? t('chat.activity.elapsed', { elapsed }) : ''}
              {t('chat.activity.alive')}
            </span>
          </div>
        )}
        {messages.length === 0 ? (
          <div className="rounded-md bg-paper-sink/60 px-3 py-3">
            <p className="text-sm leading-6 text-ink-3">
              {canChat ? t('chat.empty') : disabledHint}
            </p>
          </div>
        ) : (
          <>
            {messages.length > visibleCount && (
              <Button
                size="sm"
                variant="ghost"
                className="mb-3 w-full"
                onClick={() => {
                  setFollowingLatest(false)
                  setVisibleCount((count) => count + 40)
                }}
              >
                {t('chat.showEarlier', { count: Math.min(40, messages.length - visibleCount) })}
              </Button>
            )}
            <ol ref={messageListRef} className="space-y-3">
              {messages.slice(-visibleCount).map((m) => (
                <MessageItem
                  key={m.id}
                  message={m}
                  followRequest={m.id === lastMessage?.id ? followRequest : 0}
                  onFollowChange={handleTextFollowChange}
                />
              ))}
            </ol>
          </>
        )}
      </div>
      {!followingLatest && messages.length > 0 && (
        <Button size="sm" variant="ghost" className="mx-4 mb-2" onClick={() => {
          setFollowingLatest(true)
          setFollowRequest((value) => value + 1)
        }}>
          {t('chat.jumpLatest')}
        </Button>
      )}

      {/* 输入区 */}
      <div className="border-t border-line px-4 py-3">
        <Textarea
          value={draft}
          onChange={(e) => {
            draftRef.current = e.target.value
            setDraft(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
          rows={2}
          disabled={inputDisabled}
          placeholder={canChat ? t('chat.placeholder') : disabledHint}
          aria-label={t('chat.input.aria')}
          className="resize-none"
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-y-2">
          <span className={`min-w-0 pr-2 text-[0.6875rem] ${suggestionError ? 'text-cinnabar' : 'text-ink-4'}`}>
            {suggestionError
              ? suggestionError
              : suggesting
                ? t('chat.suggestion.running', {
                    elapsed: suggestionElapsed
                      ? t('chat.activity.elapsed', { elapsed: suggestionElapsed })
                      : '',
                  })
              : streaming
              ? remoteStreaming
                ? t('chat.streaming.remote', {
                    elapsed: elapsed ? t('chat.activity.elapsed', { elapsed }) : '',
                  })
                : t('chat.streaming.local', {
                    elapsed: elapsed ? t('chat.activity.elapsed', { elapsed }) : '',
                  })
              : t('chat.traceable')}
          </span>
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            {onSuggest && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void suggest()}
                disabled={inputDisabled || draft.trim().length === 0}
                title={t('chat.suggestion.costHint')}
              >
                {suggesting ? <Spinner size="sm" /> : t('chat.suggestion.action')}
              </Button>
            )}
            <Button size="sm" onClick={send} disabled={inputDisabled || draft.trim().length === 0}>
              {streaming ? <Spinner size="sm" /> : t('chat.send')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
