'use client'

// ---------------------------------------------------------------------------
// runStageStream —— POST stages/[stage]/run 的 SSE 客户端
// 事件序（C1）：stage_start → stage_delta(orch/assemble) →
//   stage_complete | stage_error → done
// 解析复用契约层 parseSSEChunk（仅保留尚未结束的帧）
// ---------------------------------------------------------------------------

import { parseSSEChunk, takeCompleteSSEText } from '@/src/lib/contracts/sse'
import type { Stage } from '@/src/lib/contracts/types'
import type { ReasoningPreview } from '@/src/lib/llm/reasoning-preview'

export interface StageStreamHandlers {
  signal?: AbortSignal
  onStart?: (stage: Stage) => void
  onDelta?: (stage: Stage, content: string) => void
  onAnnotation?: (stage: Stage, content: string) => void
  onReasoning?: (stage: Stage, preview: ReasoningPreview) => void
  onReset?: (stage: Stage) => void
  onComplete?: (stage: Stage, rawText: string | null) => void
  onError?: (stage: Stage, message: string) => void
  localizeError?: (value: unknown, fallback: string) => string
  messages?: {
    network: string
    request: (status: number) => string
    stage: string
    connection: string
  }
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text)
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export async function runStageStream(
  sessionId: string,
  stage: Stage,
  handlers: StageStreamHandlers,
): Promise<void> {
  if (handlers.signal?.aborted) return
  const errorText = (value: unknown, fallback: string) =>
    handlers.localizeError?.(value, fallback)
      ?? (value instanceof Error
        ? value.message
        : typeof value === 'string'
          ? value
          : fallback)
  let res: Response
  try {
    res = await fetch(`/api/sessions/${sessionId}/stages/${stage}/run`, {
      method: 'POST',
      signal: handlers.signal,
    })
  } catch (e) {
    if (handlers.signal?.aborted) return
    handlers.onError?.(
      stage,
      errorText(e, handlers.messages?.network ?? '网络错误'),
    )
    return
  }
  if (handlers.signal?.aborted) return

  // 守卫类失败（409 前置未达成 / 404 会话不存在 等）以 JSON 返回
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    if (handlers.signal?.aborted) return
    handlers.onError?.(
      stage,
      errorText(
        body?.error,
        handlers.messages?.request(res.status) ?? `请求失败（HTTP ${res.status}）`,
      ),
    )
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let rawBuffer = ''
  let sawTerminalEvent = false

  const flush = () => {
    const { completeText, remainder } = takeCompleteSSEText(rawBuffer)
    rawBuffer = remainder
    for (const ev of parseSSEChunk(completeText)) {
      if (handlers.signal?.aborted) return
      const data = safeJson(ev.data)
      const evStage = (typeof data.stage === 'string' ? data.stage : stage) as Stage

      switch (ev.event) {
        case 'stage_start':
        case 'stage.started':
          handlers.onStart?.(evStage)
          break
        case 'stage_delta':
        case 'stage.delta':
          handlers.onDelta?.(
            evStage,
            typeof data.content === 'string'
              ? data.content : typeof data.delta === 'string' ? data.delta : '',
          )
          break
        case 'stage_annotation':
        case 'stage.annotation':
          handlers.onAnnotation?.(
            evStage,
            typeof data.content === 'string'
              ? data.content : typeof data.delta === 'string' ? data.delta : '',
          )
          break
        case 'stage_reasoning':
        case 'stage.reasoning':
        case 'stage.reasoning.completed':
          handlers.onReasoning?.(evStage, {
            reasoningPreview: typeof data.reasoningPreview === 'string'
              ? data.reasoningPreview.slice(-4_000) : '',
            reasoningCharacters: typeof data.reasoningCharacters === 'number'
              ? Math.max(0, data.reasoningCharacters) : 0,
            reasoningTruncated: data.reasoningTruncated === true,
          })
          break
        case 'stage_reset':
        case 'stage.reset':
          handlers.onReset?.(evStage)
          break
        case 'stage_complete':
        case 'stage.completed':
          sawTerminalEvent = true
          handlers.onComplete?.(evStage, typeof data.raw_text === 'string' ? data.raw_text : null)
          break
        case 'stage_error':
        case 'stage.failed':
          sawTerminalEvent = true
          handlers.onError?.(
            evStage,
            errorText(
              typeof data.error === 'string' ? data.error : data.detail,
              handlers.messages?.stage ?? '阶段运行失败',
            ),
          )
          break
        case 'done':
          sawTerminalEvent = true
          break
        default:
          break
      }
    }
  }

  try {
    for (;;) {
      if (handlers.signal?.aborted) return
      const { done, value } = await reader.read()
      if (handlers.signal?.aborted) return
      if (done) break
      rawBuffer += decoder.decode(value, { stream: true })
      flush()
    }
    rawBuffer += decoder.decode()
    flush()
    if (handlers.signal?.aborted) return
    // A clean transport EOF can still cut a frame or end before the protocol's
    // completion/failure marker. Keep that visible instead of implying success.
    if (rawBuffer.trim() || !sawTerminalEvent) {
      handlers.onError?.(
        stage,
        handlers.messages?.connection ?? '连接中断',
      )
    }
  } catch (e) {
    if (handlers.signal?.aborted) return
    handlers.onError?.(
      stage,
      errorText(e, handlers.messages?.connection ?? '连接中断'),
    )
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
