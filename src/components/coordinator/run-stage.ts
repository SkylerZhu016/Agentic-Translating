'use client'

// ---------------------------------------------------------------------------
// runStageStream —— POST stages/[stage]/run 的 SSE 客户端
// 事件序（C1）：stage_start → stage_delta(orch/assemble) →
//   stage_complete | stage_error → done
// 解析复用契约层 parseSSEChunk（累积 buffer + 已处理计数跳过重放）
// ---------------------------------------------------------------------------

import { parseSSEChunk } from '@/src/lib/contracts/sse'
import type { Stage } from '@/src/lib/contracts/types'

export interface StageStreamHandlers {
  onStart?: (stage: Stage) => void
  onDelta?: (stage: Stage, content: string) => void
  onComplete?: (stage: Stage, rawText: string | null) => void
  onError?: (stage: Stage, message: string) => void
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
  let res: Response
  try {
    res = await fetch(`/api/sessions/${sessionId}/stages/${stage}/run`, {
      method: 'POST',
    })
  } catch (e) {
    handlers.onError?.(stage, e instanceof Error ? e.message : '网络错误')
    return
  }

  // 守卫类失败（409 前置未达成 / 404 会话不存在 等）以 JSON 返回
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    handlers.onError?.(stage, body?.error ?? `请求失败（HTTP ${res.status}）`)
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let rawBuffer = ''
  let processedEventCount = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      rawBuffer += decoder.decode(value, { stream: true })

      // parseSSEChunk 无状态：每次重解析累积 buffer，跳过已处理事件
      const events = parseSSEChunk(rawBuffer)
      for (let i = processedEventCount; i < events.length; i++) {
        const ev = events[i]
        const data = safeJson(ev.data)
        const evStage = (typeof data.stage === 'string' ? data.stage : stage) as Stage

        switch (ev.event) {
          case 'stage_start':
            handlers.onStart?.(evStage)
            break
          case 'stage_delta':
            handlers.onDelta?.(evStage, typeof data.content === 'string' ? data.content : '')
            break
          case 'stage_complete':
            handlers.onComplete?.(evStage, typeof data.raw_text === 'string' ? data.raw_text : null)
            break
          case 'stage_error':
            handlers.onError?.(
              evStage,
              typeof data.detail === 'string'
                ? data.detail
                : typeof data.error === 'string'
                  ? data.error
                  : '阶段运行失败',
            )
            break
          case 'done':
          default:
            break
        }
      }
      processedEventCount = events.length
    }
  } catch (e) {
    handlers.onError?.(stage, e instanceof Error ? e.message : '连接中断')
  } finally {
    reader.cancel().catch(() => {})
  }
}
