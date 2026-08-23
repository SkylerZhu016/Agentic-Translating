'use client'

// ---------------------------------------------------------------------------
// EditPopover —— 选中片段修改浮层（R4 核心交互）
// 定位：选区上方居中，视口边缘防溢出（空间不足翻到下方）；mousedown 拦截
// 以保住文本选区；Esc 关闭 / Enter 提交。
// ---------------------------------------------------------------------------

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { TID } from '@/src/lib/testids'
import { Button, Input } from '@/src/components/ui'
import { truncate } from './types'
import { useI18n } from '@/src/i18n/LocaleProvider'

export interface PopoverAnchor {
  top: number
  left: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface EditPopoverProps {
  /** 选区在视口中的包围盒（range.getBoundingClientRect） */
  anchor: PopoverAnchor
  /** 选中片段预览（未截断，组件内截 40 字） */
  preview: string
  /** 提交中（禁用输入与按钮） */
  busy?: boolean
  onSubmit: (instruction: string) => void
  onClose: () => void
  returnFocusRef?: RefObject<HTMLElement | null>
}

const POPOVER_WIDTH = 320
const VIEWPORT_MARGIN = 8
const ANCHOR_GAP = 10
/** 未测量前的高度估计（标签+预览+输入+按钮） */
const ESTIMATED_HEIGHT = 196

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

export function EditPopover({
  anchor,
  preview,
  busy = false,
  onSubmit,
  onClose,
  returnFocusRef,
}: EditPopoverProps) {
  const { t } = useI18n()
  const [instruction, setInstruction] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [panelHeight, setPanelHeight] = useState(ESTIMATED_HEIGHT)

  useLayoutEffect(() => {
    if (panelRef.current) {
      setPanelHeight(panelRef.current.offsetHeight)
    }
  }, [preview])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    const panel = panelRef.current
    const returnTarget = returnFocusRef?.current ?? (
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    )
    const focusable = () => Array.from(
      panel?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((element) => (
      element.getClientRects().length > 0 &&
      element.getAttribute('aria-hidden') !== 'true'
    ))

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const elements = focusable()
      if (elements.length === 0) {
        e.preventDefault()
        panel?.focus()
        return
      }
      const first = elements[0]
      const last = elements[elements.length - 1]
      const active = document.activeElement
      if (!panel?.contains(active)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      } else if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      queueMicrotask(() => {
        if (returnTarget?.isConnected) returnTarget.focus({ preventScroll: true })
      })
    }
  }, [onClose, returnFocusRef])

  const viewportWidth = typeof window === 'undefined' ? POPOVER_WIDTH : window.innerWidth
  const centerX = anchor.left + anchor.width / 2
  const left = clamp(centerX - POPOVER_WIDTH / 2, VIEWPORT_MARGIN, viewportWidth - POPOVER_WIDTH - VIEWPORT_MARGIN)
  const placeAbove = anchor.top - ANCHOR_GAP - panelHeight >= VIEWPORT_MARGIN
  const top = placeAbove ? anchor.top - ANCHOR_GAP : anchor.bottom + ANCHOR_GAP
  const caretLeft = clamp(centerX - left, 18, POPOVER_WIDTH - 18)

  const submit = () => {
    const value = instruction.trim()
    if (!value || busy) return
    onSubmit(value)
  }

  return (
    <div
      className="fixed z-40"
      style={{
        left,
        top,
        width: POPOVER_WIDTH,
        transform: placeAbove ? 'translateY(-100%)' : 'none',
      }}
      role="presentation"
      /* 拦截 mousedown，避免点击浮层时塌陷文本选区（快照已存，但保留可视反馈） */
      onMouseDown={(e) => e.preventDefault()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-label={t('editor.popover.title')}
        aria-modal="true"
        tabIndex={-1}
        data-testid={TID.edit.editPopover}
        className="animate-rise rounded-md border border-line-2 bg-paper-raise shadow-pop"
      >
        {/* 指向选区的墨线小箭 */}
        <span
          aria-hidden
          className="absolute h-2.5 w-2.5 rotate-45 border-line-2 bg-paper-raise"
          style={{
            left: caretLeft - 5,
            ...(placeAbove
              ? { bottom: -6, borderRightWidth: 1, borderBottomWidth: 1 }
              : { top: -6, borderLeftWidth: 1, borderTopWidth: 1 }),
          }}
        />

        <div className="px-3.5 pb-3 pt-2.5">
          <div className="flex items-start justify-between gap-2">
            <p className="overline-label pt-0.5">{t('editor.popover.title')}</p>
            <button
              type="button"
              aria-label={t('ui.modal.close')}
              onClick={onClose}
              className="-mr-1 rounded-xs px-1.5 text-xs leading-5 text-ink-4 transition-colors hover:bg-paper-sink hover:text-ink-2"
            >
              ✕
            </button>
          </div>

          {/* 片段预览：批注式左线 + 衬线引文（截 40 字） */}
          <blockquote className="mt-1.5 border-l-2 border-line-2 pl-2.5 font-serif text-[0.8125rem] leading-5 text-ink-2">
            「{truncate(preview, 40)}」
          </blockquote>

          <div className="mt-2.5">
            <Input
              ref={inputRef}
              testId={TID.edit.editInstruction}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  submit()
                }
              }}
              placeholder={t('editor.popover.placeholder')}
              aria-label={t('editor.popover.instruction')}
              disabled={busy}
              autoFocus
            />
          </div>

          <div className="mt-2.5 flex items-center justify-between">
            <span className="text-[0.6875rem] text-ink-4">{t('editor.popover.keyboardHint')}</span>
            <Button testId={TID.edit.editSubmit} size="sm" onClick={submit} disabled={busy || instruction.trim().length === 0}>
              {busy ? t('editor.popover.submitting') : t('editor.popover.submit')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
