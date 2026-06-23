'use client'

// ---------------------------------------------------------------------------
// FinalTextPanel —— 最终译文展示区（R4 交互入口）
// .poem-text 排版最新版本；coordinating 中只读（data-readonly + 锁徽章，
// 不触发 popover）；选中非空片段 → EditPopover（快照选区坐标/文本，提交走
// 聊天工具路径）；编辑完成后平滑滚动到变更处并短暂高亮。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react'
import { TID } from '@/src/lib/testids'
import { EditPopover, type PopoverAnchor } from './EditPopover'
import type { SelectionSnapshot } from './types'

export interface FinalTextPanelProps {
  /** 当前最新版本全文（空串 → 占位提示） */
  text: string
  /** coordinating 中只读：锁徽章 + 禁用 popover */
  readonly: boolean
  /** 聊天请求进行中（抑制新 popover） */
  busy?: boolean
  /** 变更高亮区间（新文本偏移）；出现即平滑滚动定位 */
  highlight: { start: number; end: number } | null
  onSubmitEdit: (instruction: string, selection: SelectionSnapshot) => void
}

interface PopoverState {
  snapshot: SelectionSnapshot
  anchor: PopoverAnchor
}

/** 读取 window 选区并换算为相对容器起点的字符偏移 */
function readSelection(container: HTMLElement): { snapshot: SelectionSnapshot; range: Range; anchor: PopoverAnchor } | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null

  const range = selection.getRangeAt(0)
  if (!container.contains(range.commonAncestorContainer)) return null

  const text = range.toString()
  if (text.trim().length === 0) return null

  const preRange = range.cloneRange()
  preRange.selectNodeContents(container)
  preRange.setEnd(range.startContainer, range.startOffset)
  const start = preRange.toString().length

  return {
    snapshot: { text, start, end: start + text.length },
    range: range.cloneRange(),
    anchor: range.getBoundingClientRect(),
  }
}

export function FinalTextPanel({ text, readonly, busy = false, highlight, onSubmitEdit }: FinalTextPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const markRef = useRef<HTMLSpanElement>(null)
  const rangeRef = useRef<Range | null>(null)
  const [popover, setPopover] = useState<PopoverState | null>(null)

  const closePopover = useCallback(() => {
    rangeRef.current = null
    setPopover(null)
  }, [])

  // ── 选中检测（鼠标 / Shift+键盘）────────────────────────────
  const inspectSelection = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    // E25：只读（coordinating）或请求进行中不触发 popover
    if (readonly || busy) return

    // 等选区稳定后再读
    window.setTimeout(() => {
      const result = readSelection(container)
      if (!result) return
      rangeRef.current = result.range
      setPopover({ snapshot: result.snapshot, anchor: result.anchor })
    }, 0)
  }, [readonly, busy])

  // ── 点击 popover 容器之外 → 关闭 ────────────────────────────
  useEffect(() => {
    if (!popover) return
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      if (target.closest(`[data-testid="${TID.edit.editPopover}"]`)) return
      if (containerRef.current?.contains(target)) return // 容器内重新选择，由 mouseup 处理
      closePopover()
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [popover, closePopover])

  // ── 滚动/缩放时跟随选区重锚（选区已失效则关闭）──────────────
  useEffect(() => {
    if (!popover) return
    const reanchor = () => {
      const range = rangeRef.current
      if (!range || !range.startContainer.isConnected) {
        closePopover()
        return
      }
      const rect = range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) {
        closePopover()
        return
      }
      setPopover((prev) => (prev ? { ...prev, anchor: rect } : prev))
    }
    window.addEventListener('scroll', reanchor, true)
    window.addEventListener('resize', reanchor)
    return () => {
      window.removeEventListener('scroll', reanchor, true)
      window.removeEventListener('resize', reanchor)
    }
  }, [popover, closePopover])

  // ── 文本被替换后关闭 popover（选区已失效）───────────────────
  useEffect(() => {
    closePopover()
  }, [text, closePopover])

  // ── 变更高亮：平滑滚动到变更片段 ────────────────────────────
  useEffect(() => {
    if (!highlight) return
    markRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [highlight])

  const submitEdit = useCallback(
    (instruction: string) => {
      if (!popover) return
      const { snapshot } = popover
      closePopover()
      window.getSelection()?.removeAllRanges()
      onSubmitEdit(instruction, snapshot)
    },
    [popover, closePopover, onSubmitEdit],
  )

  // ── 渲染正文（含高亮切分）───────────────────────────────────
  const renderBody = () => {
    if (text.length === 0) {
      return (
        <span className="text-ink-4">
          译文将在组装完成后呈现于此——宋体、松行距、微字距，适合中文长读。
        </span>
      )
    }
    if (!highlight) return text

    const start = Math.max(0, Math.min(highlight.start, text.length))
    const end = Math.max(start, Math.min(highlight.end, text.length))
    return (
      <>
        {text.slice(0, start)}
        <span ref={markRef} className="edit-flash">
          {text.slice(start, end)}
        </span>
        {text.slice(end)}
      </>
    )
  }

  return (
    <div className="relative">
      {readonly && (
        <div className="pointer-events-none absolute right-0 top-0 z-10 inline-flex items-center gap-1.5 rounded-xs border border-line-2 bg-paper-raise/90 px-2 py-1 text-[0.6875rem] font-medium tracking-wide text-ink-3">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3 w-3" aria-hidden>
            <rect x="5" y="11" width="14" height="9" rx="1.5" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
          统筹中 · 只读
        </div>
      )}

      <div
        ref={containerRef}
        data-testid={TID.edit.finalText}
        data-readonly={readonly ? 'true' : 'false'}
        aria-readonly={readonly}
        onMouseUp={inspectSelection}
        onKeyUp={(e) => {
          if (e.shiftKey || e.key === 'Shift') inspectSelection()
        }}
        className={[
          'poem-text min-h-56 outline-none',
          readonly ? 'cursor-default text-ink-2' : '',
        ].join(' ')}
      >
        {renderBody()}
      </div>

      {popover && (
        <EditPopover
          anchor={popover.anchor}
          preview={popover.snapshot.text}
          busy={busy}
          onSubmit={submitEdit}
          onClose={closePopover}
        />
      )}
    </div>
  )
}
