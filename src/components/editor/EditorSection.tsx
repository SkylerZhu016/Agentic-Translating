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
import { parseSSEChunk } from '@/src/lib/contracts/sse'
import type { SessionState } from '@/src/lib/contracts/types'
import { emitSessionChanged, useSessionFull, type SessionFullResponse } from '@/src/components/coordinator'
import { Badge, Card } from '@/src/components/ui'
import { changedRange } from './changed-range'
import { ChatPanel } from './ChatPanel'
import { FinalTextPanel } from './FinalTextPanel'
import { VersionHistory } from './VersionHistory'
import type {
  ChatMessage,
  ChatMessageView,
  FinalVersion,
  SelectionSnapshot,
  ToolCallView,
} from './types'
import { RevisionEvidence } from './RevisionEvidence'
import { DisagreementMap } from './DisagreementMap'

/** 高亮停留时长（ms） */
const HIGHLIGHT_DURATION = 2600

const SOURCE_LABEL: Record<FinalVersion['source'], string> = {
  assemble: '组装',
  main_draft: '主 Agent 成稿',
  edit: '编辑',
  restore: '恢复',
  revert: '撤销',
}

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

export function EditorSection() {
  const { data, sessionId, candidateRevision, refresh } = useSessionFull()

  /** 本地流式叠加层：乐观用户消息 + 流式 AI 消息；服务端落库后清空 */
  const [live, setLive] = useState<ChatMessageView[]>([])
  const [streaming, setStreaming] = useState(false)
  const [localChatStartedAt, setLocalChatStartedAt] = useState<number | null>(null)
  const [localChatPhase, setLocalChatPhase] = useState<ChatActivityPhase>('waiting_for_model')
  const [highlight, setHighlight] = useState<{ start: number; end: number } | null>(null)

  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toolSeq = useRef(0)

  const sessionState = (data?.session.state ?? null) as SessionState | null
  const versions = useMemo(() => data?.versions ?? [], [data?.versions])
  const serverMessages = useMemo(() => (data?.messages ?? []).map(toView), [data?.messages])
  const messages = useMemo(() => [...serverMessages, ...live], [serverMessages, live])

  // ── 派生：当前版本 / 当前文本 ───────────────────────────────
  const currentVersion = useMemo(
    () => data?.finalVersion ?? null,
    [data?.finalVersion],
  )
  const currentText = currentVersion?.text ?? ''
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
    ? '统筹进行中，暂不可对话'
    : sessionState === 'done'
      ? '会话已完结'
      : '完成组装后即可对话修改'

  // ── 流式叠加层局部更新（最后一条 streaming 消息）────────────
  const patchStreamingMessage = useCallback((patch: (msg: ChatMessageView) => ChatMessageView) => {
    setLive((prev) => {
      const next = [...prev]
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].streaming) {
          next[i] = patch(next[i])
          return next
        }
      }
      return prev
    })
  }, [])

  // ── 编辑生效：对新旧文本求变更区间 → 滚动 + 高亮 ─────────────
  const flashChange = useCallback((before: string, after: string) => {
    const range = changedRange(before, after)
    if (!range) return
    if (highlightTimer.current) clearTimeout(highlightTimer.current)
    setHighlight(range)
    highlightTimer.current = setTimeout(() => setHighlight(null), HIGHLIGHT_DURATION)
  }, [])

  useEffect(() => () => {
    if (highlightTimer.current) clearTimeout(highlightTimer.current)
  }, [])

  // ── 发送聊天（可带选中片段）─────────────────────────────────
  const sendChat = useCallback(
    async (message: string, selection?: SelectionSnapshot) => {
      if (!canChat || streaming || !sessionId) return

      const beforeText = currentText
      const userContent = selection ? `针对选中文段「${selection.text}」：${message}` : message

      setLive([
        { id: `local-user-${Date.now()}`, role: 'user', content: userContent },
        { id: `local-ai-${Date.now()}`, role: 'assistant', content: '', streaming: true, toolCalls: [] },
      ])
      setStreaming(true)
      setLocalChatStartedAt(Date.now())
      setLocalChatPhase('waiting_for_model')

      try {
        const res = await fetch(`/api/sessions/${sessionId}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(selection ? { message, selection } : { message }),
        })

        if (!res.ok || !res.body) {
          let note = `请求失败（${res.status}）`
          try {
            const errBody = (await res.json()) as { message?: string; error?: string }
            note = errBody.message ?? errBody.error ?? note
          } catch { /* 非 JSON 错误体 */ }
          patchStreamingMessage((msg) => ({ ...msg, streaming: false, error: note }))
          return
        }

        // ── SSE 消费：message_start/delta/tool_call/tool_result/message_complete/done
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let pending = ''

        const handleEvent = (event: string, raw: string) => {
          let data: Record<string, unknown> = {}
          try {
            data = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
          } catch { /* 容错：忽略坏帧 */ }

          switch (event) {
            case 'activity': {
              if (data.phase === 'thinking') setLocalChatPhase('thinking')
              break
            }
            case 'delta': {
              const text = (data as DeltaData).text ?? ''
              if (text) {
                setLocalChatPhase('generating')
                patchStreamingMessage((msg) => ({ ...msg, content: msg.content + text }))
              }
              break
            }
            case 'tool_call': {
              setLocalChatPhase('applying_edits')
              const payload = data as ToolCallData
              const call: ToolCallView = {
                id: `tc-${++toolSeq.current}`,
                toolName: typeof payload.name === 'string' ? payload.name : undefined,
                oldString: typeof payload.arguments?.old_string === 'string' ? payload.arguments.old_string : '',
                newString: typeof payload.arguments?.new_string === 'string' ? payload.arguments.new_string : '',
                status: 'pending',
              }
              patchStreamingMessage((msg) => ({ ...msg, toolCalls: [...(msg.toolCalls ?? []), call] }))
              break
            }
            case 'tool_result': {
              setLocalChatPhase('applying_edits')
              const payload = data as ToolResultData
              if (payload.version_no != null) break // 落库确认帧：refresh 后整体呈现
              patchStreamingMessage((msg) => {
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
              const payload = data as CompleteData
              if (payload.error) {
                patchStreamingMessage((msg) => ({
                  ...msg,
                  streaming: false,
                  error: payload.message ?? payload.error ?? '本轮回复失败',
                }))
              }
              break
            }
            default:
              break // message_start / done / 未知事件
          }
        }

        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          pending += decoder.decode(value, { stream: true })
          const cut = pending.lastIndexOf('\n\n')
          if (cut === -1) continue
          const complete = pending.slice(0, cut + 2)
          pending = pending.slice(cut + 2)
          for (const evt of parseSSEChunk(complete)) handleEvent(evt.event, evt.data)
        }
        pending += decoder.decode()
        if (pending.trim().length > 0) {
          for (const evt of parseSSEChunk(pending + '\n\n')) handleEvent(evt.event, evt.data)
        }
      } catch {
        patchStreamingMessage((msg) => ({ ...msg, streaming: false, error: '连接中断，本轮回复可能未完成' }))
      } finally {
        patchStreamingMessage((msg) => ({ ...msg, streaming: false }))
        setStreaming(false)
        setLocalChatStartedAt(null)
        setLocalChatPhase('waiting_for_model')
        // 服务端为准重载（用户/AI 消息落库 + 可能的新版本），成功则撤下叠加层
        const full = await refresh()
        if (full) setLive([])
        flashChange(beforeText, latestTextOf(full))
        emitSessionChanged(sessionId)
      }
    },
    [canChat, streaming, sessionId, currentText, refresh, patchStreamingMessage, flashChange],
  )

  // ── 恢复版本 ────────────────────────────────────────────────
  const restoreVersion = useCallback(
    async (versionNo: number) => {
      if (!sessionId) throw new Error('暂无会话')
      const res = await fetch(`/api/sessions/${sessionId}/versions/${versionNo}/restore`, { method: 'POST' })
      if (!res.ok) {
        let note = `恢复失败（${res.status}）`
        try {
          const errBody = (await res.json()) as { message?: string }
          if (errBody.message) note = errBody.message
        } catch { /* 非 JSON 错误体 */ }
        throw new Error(note)
      }
      await refresh()
      emitSessionChanged(sessionId)
    },
    [sessionId, refresh],
  )

  const popoverSubmit = useCallback(
    (instruction: string, selection: SelectionSnapshot) => void sendChat(instruction, selection),
    [sendChat],
  )

  const suggestRevision = useCallback(
    async (message: string): Promise<string> => {
      if (!sessionId) throw new Error('暂无会话')
      const response = await fetch(
        `/api/sessions/${sessionId}/revision-suggestions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message }),
        },
      )
      let body: {
        feedback?: string
        message?: string
        error?: string
      } = {}
      try {
        body = await response.json()
      } catch {
        // 非 JSON 错误体由下方统一处理。
      }
      if (!response.ok) {
        throw new Error(
          body.message ?? body.error ?? `生成修订建议失败（${response.status}）`,
        )
      }
      if (!body.feedback?.trim()) throw new Error('模型没有返回可用建议')
      return body.feedback
    },
    [sessionId],
  )

  return (
    <div className="grid grid-cols-1 gap-5 lg:col-span-12 lg:grid-cols-12">
      {/* 最终译文 */}
      <Card
        overline="Final Text"
        title="最终译文"
        className="lg:col-span-7"
        actions={
          currentVersionNo != null ? (
            <div className="flex items-center gap-1.5">
              {data?.final_evidence && (
                <Badge variant="outline">{data.final_evidence.summary}</Badge>
              )}
              <Badge variant="subtle">
                v{currentVersionNo} · {SOURCE_LABEL[currentVersion!.source]}
              </Badge>
            </div>
          ) : undefined
        }
      >
        <FinalTextPanel
          text={currentText}
          emptyHint={
            data
              ? `最终译文将在工作流正式提交后显示。当前状态：${data.session.state}`
              : '创建任务后，正式提交的译文将在此显示。'
          }
          readonly={readonly}
          busy={chatBusy}
          highlight={highlight}
          onSubmitEdit={popoverSubmit}
        />
      </Card>

      {/* 右侧栏：对话修订 + 版本历史 */}
      <div className="flex flex-col gap-5 lg:col-span-5">
        <Card overline="Chat" title="对话修订" padded={false}>
          <ChatPanel
            messages={messages}
            streaming={chatBusy}
            remoteStreaming={remoteChatActive}
            activityStartedAt={chatStartedAt}
            activityPhase={chatPhase}
            canChat={canChat}
            disabledHint={disabledHint}
            onSend={(msg) => void sendChat(msg)}
            onSuggest={suggestRevision}
          />
        </Card>

        <Card overline="Versions" title="版本历史" padded={false}>
          <VersionHistory
            versions={currentVersion ? versions : []}
            currentVersionNo={currentVersionNo}
            onRestore={restoreVersion}
          />
          <RevisionEvidence
            sessionId={sessionId}
            patches={data?.patches ?? []}
            currentVersionId={currentVersion?.id ?? null}
            onChanged={refresh}
          />
        </Card>

        <DisagreementMap
          sessionId={sessionId}
          finalVersionId={currentVersion?.id ?? null}
          candidateRevision={candidateRevision}
          currentText={currentText}
          canAdopt={canChat}
          busy={chatBusy}
          onAdopt={(instruction, selection) => {
            void sendChat(instruction, selection)
          }}
        />
      </div>
    </div>
  )
}
