'use client'

// ---------------------------------------------------------------------------
// CoordinatorFinalText —— 最终译文区（TID final-text）
// 展示最新版本文本（.poem-text 排版：宋体、松行距、微字距）
// 数据以服务端为准：挂载自取 + 监听 session-bus 变更信号
// （编辑/选中交互归 Task 24，此处仅呈现）
// ---------------------------------------------------------------------------

import { TID } from '@/src/lib/testids'
import { useSessionFull } from './use-session'

export function CoordinatorFinalText() {
  const { data } = useSessionFull()
  const latest = data?.finalVersion ?? null

  if (!latest) {
    return (
      <div data-testid={TID.edit.finalText} className="poem-text min-h-56">
        <span className="text-ink-4">
          译文将在组装完成后呈现于此——宋体、松行距、微字距，适合中文长读。
        </span>
      </div>
    )
  }

  return (
    <div>
      <p className="mb-2 text-xs text-ink-4">
        版本 v{latest.version_no} ·{' '}
        {latest.source === 'assemble' ? '组装' : latest.source === 'edit' ? '编辑' : '恢复'}
      </p>
      <div data-testid={TID.edit.finalText} className="poem-text min-h-56">
        {latest.text}
      </div>
    </div>
  )
}
