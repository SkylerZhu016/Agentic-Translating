'use client'

// ---------------------------------------------------------------------------
// EditorSection —— 编辑+聊天视图编排器（最终译文 / 对话修订 / 版本历史）
// 数据流：
//   - 会话发现/全量/总线监听复用统筹面板 useSessionFull（服务端为准）
//   - 聊天：POST chat（SSE）→ message_start/delta/tool_call/tool_result/
//     message_complete/done 逐事件渲染到本地流式叠加层；完成后 refresh
//     以服务端落库内容替换叠加层
//   - 编辑生效 → changedRange 计算变更区间 → final-text 平滑滚动 + 短暂高亮
//   - 恢复：POST restore → refresh（append-only，恢复本身成为新版本）
//   - 两者均 emitSessionChanged 广播，供翻译/统筹面板同步
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseSSEChunk, takeCompleteSSEText } from '@/src/lib/contracts/sse'
import { REASONING_PREVIEW_LIMIT } from '@/src/lib/llm/reasoning-preview'
import type { SessionState } from '@/src/lib/contracts/types'
import { emitSessionChanged, useSessionFull, type SessionFullResponse } from '@/src/components/coordinator'
import { Badge, Button, Card } from '@/src/components/ui'
import { changedRange } from './changed-range'
import { ChatPanel } from './ChatPanel'
import { FinalTextPanel } from './FinalTextPanel'
import { VersionHistory } from './VersionHistory'
import type {
  ChatMessage,
  ChatMessageView,
  SelectionSnapshot,
  ToolCallView,
} from './types'
import { RevisionEvidence } from './RevisionEvidence'
import { DisagreementMap } from './DisagreementMap'
import { useI18n } from '@/src/i18n/LocaleProvider'
import { localizeDiagnosticError } from '@/src/i18n/diagnostic'
import { localizeEvidenceSummary } from '@/src/i18n/evidence'

/** 高亮停留时长（ms） */
const HIGHLIGHT_DURATION = 2600
const STREAM_RENDER_INTERVAL = 50

// ── 服务端历史消息 → 视图模型 ─────────────────────────────────
function toView(message: ChatMessage): ChatMessageView {
  return { id: `srv-${message.id}`, role: message.role, content: message.content, createdAt: message.created_at }
}

/** 会话全量中取最新版本文本 */
function latestTextOf(full: SessionFullResponse | null): string {
  return full?.finalVersion?.text ?? ''
}

// ── SSE data 载荷（与任务 19 服务端实现对齐）──────────────────
interface DeltaData { text?: string }
interface ToolCallData { name?: string; arguments?: { old_string?: unknown; new_string?: unknown } }
interface ToolResultData { ok?: boolean; diff_summary?: string; version_no?: number }
interface CompleteData { kind?: string; error?: string; message?: string }
type ChatActivityPhase =
  | 'waiting_for_model'
  | 'thinking'
  | 'generating'
  | 'applying_edits'

export function EditorSection({ className = '' }: { className?: string }) {
  const { t, formatNumber } = useI18n()
  const { data, sessionId, candidateRevision, refresh } = useSessionFull()

  /** 本地流式叠加层：乐观用户消息 + 流式 AI 消息；服务端落库后清空 */
  const [live, setLive] = useState<ChatMessageView[]>([])
  const [streaming, setStreaming] = useState(false)
  const [localChatStartedAt, setLocalChatStartedAt] = useState<number | null>(null)
  const [localChatPhase, setLocalChatPhase] = useState<ChatActivityPhase>('waiting_for_model')
  const [highlight, setHighlight] = useState<{ start: number; end: number } | null>(null)
  const [chatError, setChatError] = useState<string | null>(null)
  const [showSource, setShowSource] = useState(true)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const [mutating, setMutating] = useState(false)

  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toolSeq = useRef(0)
  const currentSessionRef = useRef(sessionId)
  currentSessionRef.current = sessionId
  const activeChat = useRef<{ controller: AbortController; sessionId: string } | null>(null)
  const restoreInFlight = useRef<string | null>(null)
  const suggestionController = useRef<AbortController | null>(null)
  const chatBaselineIds = useRef<Set<number> | null>(null)
  const mutationLock = useRef(false)
  const onMutationChange = useCallback((value: boolean) => {
    mutationLock.current = value
    setMutating(value)
  }, [])

  const sessionState = (data?.session.state ?? null) as SessionState | null
  const versions = useMemo(() => data?.versions ?? [], [data?.versions])
  const serverMessages = useMemo(
    () => (data?.messages ?? [])
      .filter((message) => !streaming || !chatBaselineIds.current || chatBaselineIds.current.has(message.id))
      .map(toView),
    [data?.messages, streaming],
  )
  const messages = useMemo(() => [...serverMessages, ...live], [serverMessages, live])

  // ── 派生：当前版本 / 当前文本 ───────────────────────────────
  const currentVersion = useMemo(
    () => data?.finalVersion ?? null,
    [data?.finalVersion],
  )
  const currentText = currentVersion?.text ?? ''
  const characterCount = useMemo(() => Array.from(currentText).length, [currentText])
  const currentVersionNo = currentVersion?.version_no ?? null
  const remoteChatActive = data?.chatActivity?.active === true && !streaming
  const chatBusy = streaming || remoteChatActive
  const chatStartedAt = streaming
    ? localChatStartedAt
    : data?.chatActivity?.startedAt ?? null
  const chatPhase = streaming
    ? localChatPhase
    : data?.chatActivity?.phase ?? 'waiting_for_model'

  const readonly = sessionState === 'coordinating'
  const canChat =
    sessionId != null &&
    currentVersion != null &&
    (sessionState === 'assembled' || sessionState === 'refining')
  const disabledHint = readonly
    ? t('editor.disabled.coordinating')
    : sessionState === 'done'
      ? t('editor.disabled.done')
      : t('editor.disabled.waitAssembly')

  useEffect(() => {
    setLive([])
    setStreaming(false)
    setChatError(null)
    setHighlight(null)
    setCopyState('idle')
    mutationLock.current = false
    setMutating(false)
    setLocalChatStartedAt(null)
    setLocalChatPhase('waiting_for_model')
    chatBaselineIds.current = null
    return () => {
      activeChat.current?.controller.abort()
      activeChat.current = null
      suggestionController.current?.abort()
      suggestionController.current = null
      restoreInFlight.current = null
      if (highlightTimer.current) clearTimeout(highlightTimer.current)
      if (copyTimer.current) clearTimeout(copyTimer.current)
    }
  }, [sessionId])

  // ── 编辑生效：对新旧文本求变更区间 → 滚动 + 高亮 ─────────────
  const flashChange = useCallback((before: string, after: string) => {
    const range = changedRange(before, after)
    if (!range) return
    if (highlightTimer.current) clearTimeout(highlightTimer.current)
    setHighlight(range)
    highlightTimer.current = setTimeout(() => setHighlight(null), HIGHLIGHT_DURATION)
  }, [])

  // ── 发送聊天（可带选中片段）─────────────────────────────────
  const sendChat = useCallback(
    async (message: string, selection?: SelectionSnapshot) => {
      if (!message.trim() || !canChat || chatBusy || !sessionId || activeChat.current || mutationLock.current) return

      const request = { controller: new AbortController(), sessionId }
      activeChat.current = request
      chatBaselineIds.current = new Set((data?.messages ?? []).map((entry) => entry.id))
      const isCurrent = () => activeChat.current === request &&
        currentSessionRef.current === sessionId && !request.controller.signal.aborted
      const aiId = `local-ai-${crypto.randomUUID()}`
      const patchMessage = (patch: (msg: ChatMessageView) => ChatMessageView) => {
        if (!isCurrent()) return
        setLive((previous) => previous.map((msg) => msg.id === aiId ? patch(msg) : msg))
      }
      let deltaBuffer = ''
      let renderTimer: ReturnType<typeof setTimeout> | null = null
      let completed = false
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
      const flushDelta = () => {
        if (renderTimer != null) clearTimeout(renderTimer)
        renderTimer = null
        const text = deltaBuffer
        deltaBuffer = ''
        if (text) patchMessage((msg) => ({ ...msg, content: msg.content + text }))
      }
      const fail = (note: string) => {
        if (isCurrent()) setChatError(note)
      }

      const beforeText = currentText
      const userContent = selection
        ? t('editor.selection.request', { text: selection.text, message })
        : message

      setLive([
        { id: `local-user-${Date.now()}`, role: 'user', content: userContent },
        { id: aiId, role: 'assistant', content: '', streaming: true, toolCalls: [] },
      ])
      setChatError(null)
      setStreaming(true)
      setLocalChatStartedAt(Date.now())
      setLocalChatPhase('waiting_for_model')

      try {
        const res = await fetch(`/api/sessions/${sessionId}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(selection ? { message, selection } : { message }),
          signal: request.controller.signal,
        })
        if (!isCurrent()) return

        if (!res.ok || !res.body) {
          let note = t('editor.error.request', { status: res.status })
          try {
            const errBody = (await res.json()) as { message?: string; error?: string }
            note = localizeDiagnosticError(t, errBody.error, note)
          } catch { /* 非 JSON 错误体 */ }
          fail(note)
          return
        }

        // ── SSE 消费：message_start/delta/tool_call/tool_result/message_complete/done
        reader = res.body.getReader()
        const decoder = new TextDecoder()
        let pending = ''

        const handleEvent = (event: string, raw: string) => {
          if (!isCurrent()) return
          let data: Record<string, unknown> = {}
          try {
            const payload: unknown = raw ? JSON.parse(raw) : {}
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return
            data = payload as Record<string, unknown>
          } catch { return }

          switch (event) {
            case 'activity': {
              if (data.phase === 'thinking') setLocalChatPhase('thinking')
              break
            }
            case 'reasoning': {
              if (typeof data.reasoningPreview !== 'string' ||
                typeof data.reasoningCharacters !== 'number' ||
                !Number.isFinite(data.reasoningCharacters) ||
                data.reasoningCharacters < 0) break
              const preview = data.reasoningPreview.slice(-REASONING_PREVIEW_LIMIT)
              const characters = Math.floor(data.reasoningCharacters)
              const truncated = data.reasoningTruncated === true ||
                data.reasoningPreview.length > preview.length
              // Bounded snapshots arrive at most every 200 ms. Never concatenate
              // this channel into the assistant body or the next chat request.
              patchMessage((msg) => ({
                ...msg,
                reasoningPreview: preview,
                reasoningCharacters: Math.max(msg.reasoningCharacters ?? 0, characters),
                reasoningTruncated: truncated,
              }))
              break
            }
            case 'delta': {
              const text = (data as DeltaData).text ?? ''
              if (typeof text === 'string' && text) {
                setLocalChatPhase('generating')
                deltaBuffer += text
                if (renderTimer == null) renderTimer = setTimeout(flushDelta, STREAM_RENDER_INTERVAL)
              }
              break
            }
            case 'tool_call': {
              flushDelta()
              setLocalChatPhase('applying_edits')
              const payload = data as ToolCallData
              const call: ToolCallView = {
                id: `tc-${++toolSeq.current}`,
                toolName: typeof payload.name === 'string' ? payload.name : undefined,
                oldString: typeof payload.arguments?.old_string === 'string' ? payload.arguments.old_string : '',
                newString: typeof payload.arguments?.new_string === 'string' ? payload.arguments.new_string : '',
                status: 'pending',
              }
              patchMessage((msg) => ({ ...msg, toolCalls: [...(msg.toolCalls ?? []), call] }))
              break
            }
            case 'tool_result': {
              setLocalChatPhase('applying_edits')
              const payload = data as ToolResultData
              if (payload.version_no != null) break // 落库确认帧：refresh 后整体呈现
              patchMessage((msg) => {
                const calls = [...(msg.toolCalls ?? [])]
                const idx = calls.map((c) => c.status).lastIndexOf('pending')
                if (idx === -1) return msg
                calls[idx] =
                  payload.ok === false
                    ? { ...calls[idx], status: 'failed' }
                    : { ...calls[idx], status: 'ok', diffSummary: payload.diff_summary }
                return { ...msg, toolCalls: calls }
              })
              break
            }
            case 'message_complete': {
              flushDelta()
              completed = true
              const payload = data as CompleteData
              if (payload.error) {
                fail(localizeDiagnosticError(
                  t,
                  payload.error,
                  t('editor.error.reply'),
                ))
              }
              break
            }
            case 'done':
              completed = true
              break
            default:
              break // message_start / done / 未知事件
          }
        }

        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (!isCurrent()) return
          pending += decoder.decode(value, { stream: true })
          const { completeText, remainder } = takeCompleteSSEText(pending)
          pending = remainder
          for (const evt of parseSSEChunk(completeText)) handleEvent(evt.event, evt.data)
        }
        pending += decoder.decode()
        if (pending.trim().length > 0) {
          for (const evt of parseSSEChunk(pending + '\n\n')) handleEvent(evt.event, evt.data)
        }
        if (!completed) fail(t('editor.error.interrupted'))
      } catch {
        if (!request.controller.signal.aborted) fail(t('editor.error.connection'))
      } finally {
        flushDelta()
        reader?.releaseLock()
        if (isCurrent()) {
          patchMessage((msg) => ({ ...msg, streaming: false }))
          // Keep the send lock through reconciliation, so a second click cannot race the refresh.
          const full = await refresh()
          if (isCurrent()) {
            if (full?.session.id === sessionId) {
              setLive([])
              flashChange(beforeText, latestTextOf(full))
            }
            setStreaming(false)
            setLocalChatStartedAt(null)
            setLocalChatPhase('waiting_for_model')
            activeChat.current = null
            chatBaselineIds.current = null
            emitSessionChanged(sessionId)
          }
        }
      }
    },
    [canChat, chatBusy, sessionId, currentText, data?.messages, refresh, flashChange, t],
  )

  // ── 恢复版本 ────────────────────────────────────────────────
  const restoreVersion = useCallback(
    async (versionNo: number) => {
      if (!sessionId) throw new Error(t('editor.error.noSession'))
      if (restoreInFlight.current || activeChat.current || chatBusy || mutationLock.current) return
      const requestId = crypto.randomUUID()
      restoreInFlight.current = requestId
      onMutationChange(true)
      try {
        const res = await fetch(`/api/sessions/${sessionId}/versions/${versionNo}/restore`, { method: 'POST' })
        if (!res.ok) {
          let note = t('editor.error.restore', { status: res.status })
          try {
            const errBody = (await res.json()) as { message?: string; error?: string }
            note = localizeDiagnosticError(t, errBody.error, note)
          } catch { /* 非 JSON 错误体 */ }
          throw new Error(note)
        }
        if (currentSessionRef.current !== sessionId) return
        const full = await refresh()
        if (currentSessionRef.current === sessionId && full?.session.id === sessionId) {
          flashChange(currentText, latestTextOf(full))
          emitSessionChanged(sessionId)
        }
      } finally {
        if (restoreInFlight.current === requestId) {
          restoreInFlight.current = null
          onMutationChange(false)
        }
      }
    },
    [sessionId, chatBusy, currentText, refresh, flashChange, onMutationChange, t],
  )

  const popoverSubmit = useCallback(
    (instruction: string, selection: SelectionSnapshot) => void sendChat(instruction, selection),
    [sendChat],
  )

  const suggestRevision = useCallback(
    async (message: string): Promise<string> => {
      if (!sessionId) throw new Error(t('editor.error.noSession'))
      suggestionController.current?.abort()
      const controller = new AbortController()
      suggestionController.current = controller
      try {
        const response = await fetch(
          `/api/sessions/${sessionId}/revision-suggestions`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message }),
            signal: controller.signal,
          },
        )
        const body = await response.json().catch(() => ({})) as {
          feedback?: string
          error?: string
        }
        if (!response.ok) {
          throw new Error(localizeDiagnosticError(
            t, body.error, t('editor.error.suggestion', { status: response.status }),
          ))
        }
        if (!body.feedback?.trim()) throw new Error(t('editor.error.emptySuggestion'))
        return body.feedback
      } finally {
        if (suggestionController.current === controller) suggestionController.current = null
      }
    },
    [sessionId, t],
  )

  const copyText = async () => {
    const copiedSession = sessionId
    try {
      await navigator.clipboard.writeText(currentText)
      if (currentSessionRef.current !== copiedSession) return
      setCopyState('copied')
    } catch {
      if (currentSessionRef.current !== copiedSession) return
      setCopyState('error')
    }
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopyState('idle'), 3000)
  }

  const sourceText = data?.session.source_text ?? ''

  return (
    <div className={`grid min-w-0 grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(19rem,0.45fr)] ${className}`}>
      {/* 最终译文 */}
      <Card
        title={t('editor.final.title')}
        className="overflow-hidden"
        actions={
          currentVersionNo != null ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {data?.final_evidence && (
                <Badge variant="outline">
                  {localizeEvidenceSummary(t, data.final_evidence.summary)}
                </Badge>
              )}
              <Badge variant="subtle">
                v{currentVersionNo} · {
                  currentVersion!.source === 'assemble'
                    ? t('version.source.assemble')
                    : currentVersion!.source === 'main_draft'
                      ? t('version.source.mainDraft')
                      : currentVersion!.source === 'edit'
                        ? t('version.source.edit')
                        : currentVersion!.source === 'revert'
                          ? t('version.source.revert')
                          : t('version.source.restore')
                }
              </Badge>
            </div>
          ) : undefined
        }
      >
        {currentText && (
          <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-line pb-3">
            <span className="mr-auto text-xs tabular-nums text-ink-4">
              {t('editor.final.characters', { count: formatNumber(characterCount) })}
            </span>
            {sourceText && (
              <Button size="sm" variant="ghost" aria-pressed={showSource} onClick={() => setShowSource((value) => !value)}>
                {t(showSource ? 'editor.source.hide' : 'editor.source.show')}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => void copyText()}>
              {t(copyState === 'copied' ? 'editor.final.copied' : 'editor.final.copy')}
            </Button>
            {copyState === 'error' && (
              <p role="alert" className="w-full text-xs text-cinnabar">{t('editor.final.copyError')}</p>
            )}
          </div>
        )}
        <div className={showSource && currentText && sourceText ? 'grid min-w-0 gap-5 xl:grid-cols-2' : ''}>
          {showSource && currentText && sourceText && (
            <section className="min-w-0 border-b border-line pb-4 xl:border-b-0 xl:border-r xl:pb-0 xl:pr-5" aria-label={t('editor.source.title')}>
              <h3 className="mb-3 text-xs font-medium text-ink-3">{t('editor.source.title')}</h3>
              <div className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-serif text-[0.9375rem] leading-8 text-ink-3 xl:max-h-[65vh]">
                {sourceText}
              </div>
            </section>
          )}
          <div className="min-w-0">
            {showSource && currentText && sourceText && (
              <h3 className="mb-3 text-xs font-medium text-pine">{t('editor.final.title')}</h3>
            )}
            <FinalTextPanel
              key={sessionId}
              text={currentText}
              emptyHint={data ? t('editor.final.defaultEmpty') : t('editor.final.waitingTask')}
              readonly={readonly}
              busy={chatBusy || mutating}
              highlight={highlight}
              onSubmitEdit={popoverSubmit}
            />
          </div>
        </div>
        {currentText && canChat && (
          <p className="mt-4 border-t border-line pt-3 text-xs leading-5 text-ink-4">{t('editor.final.selectionHint')}</p>
        )}
      </Card>

      {/* 右侧栏：对话修订 + 版本历史 */}
      <div className="flex min-w-0 flex-col gap-3">
        <Card title={t('editor.chat.title')} padded={false}>
          {chatError && (
            <p role="alert" className="mx-4 mt-3 rounded-md border border-cinnabar/20 bg-cinnabar/5 px-3 py-2 text-xs leading-5 text-cinnabar">
              {chatError}
            </p>
          )}
          <ChatPanel
            key={sessionId}
            messages={messages}
            streaming={chatBusy}
            remoteStreaming={remoteChatActive}
            activityStartedAt={chatStartedAt}
            activityPhase={chatPhase}
            canChat={canChat}
            disabled={mutating}
            disabledHint={disabledHint}
            onSend={(msg) => void sendChat(msg)}
            onSuggest={suggestRevision}
          />
        </Card>

        <details className="group overflow-hidden rounded-md border border-line bg-paper-raise">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-ink-2 hover:bg-paper-sink/50">
            <span className="text-ink-4 transition-transform group-open:rotate-90" aria-hidden>▸</span>
            <span className="min-w-0 flex-1">{t('editor.tools.summary')}</span>
            {versions.length > 0 && <Badge variant="subtle">{formatNumber(versions.length)}</Badge>}
          </summary>
          <VersionHistory
            key={sessionId}
            versions={currentVersion ? versions : []}
            currentVersionNo={currentVersionNo}
            busy={chatBusy || readonly || mutating}
            onRestore={restoreVersion}
          />
          <RevisionEvidence
            key={sessionId}
            sessionId={sessionId}
            patches={data?.patches ?? []}
            currentVersionId={currentVersion?.id ?? null}
            disabled={chatBusy || readonly || mutating}
            onBusyChange={onMutationChange}
            onChanged={refresh}
          />
        </details>

        <DisagreementMap
          key={sessionId}
          sessionId={sessionId}
          finalVersionId={currentVersion?.id ?? null}
          candidateRevision={candidateRevision}
          currentText={currentText}
          canAdopt={canChat}
          busy={chatBusy || mutating}
          onAdopt={popoverSubmit}
        />
      </div>
    </div>
  )
}
