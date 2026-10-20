'use client'

import { memo, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useI18n } from '@/src/i18n/LocaleProvider'

/** A visual height limit does not limit text layout. Keep the mounted text bounded too. */
export const TEXT_WINDOW_CHARACTERS = 8000
export const TEXT_STREAM_RENDER_INTERVAL_MS = 100

export interface TextWindow {
  start: number
  end: number
  text: string
}

/** null follows the tail. A numeric anchor remains stable as new text arrives. */
export function getTextWindow(
  text: string,
  anchor: number | null,
  requestedLimit = TEXT_WINDOW_CHARACTERS,
): TextWindow {
  const limit = Math.min(
    TEXT_WINDOW_CHARACTERS,
    Math.max(2, Math.floor(Number.isFinite(requestedLimit) ? requestedLimit : TEXT_WINDOW_CHARACTERS)),
  )
  let start = anchor == null
    ? Math.max(0, text.length - limit)
    : Math.max(0, Math.min(Math.floor(anchor), Math.max(0, text.length - 1)))
  // Avoid rendering half of an emoji at either edge of a window.
  if (start > 0 && isLowSurrogate(text.charCodeAt(start))) start += 1
  let end = Math.min(text.length, start + limit)
  if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1
  return { start, end, text: text.slice(start, end) }
}

function isHighSurrogate(value: number) {
  return value >= 0xd800 && value <= 0xdbff
}

function isLowSurrogate(value: number) {
  return value >= 0xdc00 && value <= 0xdfff
}

function useBatchedText(text: string, streaming: boolean) {
  const [renderedText, setRenderedText] = useState(text)
  const latest = useRef(text)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  latest.current = text

  useEffect(() => {
    if (!streaming) {
      if (timer.current != null) clearTimeout(timer.current)
      timer.current = null
      setRenderedText(text)
      return
    }
    if (timer.current != null) return
    timer.current = setTimeout(() => {
      timer.current = null
      setRenderedText(latest.current)
    }, TEXT_STREAM_RENDER_INTERVAL_MS)
  }, [text, streaming])

  useEffect(() => () => {
    if (timer.current != null) clearTimeout(timer.current)
  }, [])

  return streaming ? renderedText : text
}

export interface BoundedTextProps {
  text: string
  streaming?: boolean
  textClassName?: string
  viewportClassName?: string
  className?: string
  /** The input itself is a rolling preview. Preserve its current slice while reading. */
  tailPreview?: boolean
  /** Omit for an incomplete preview, such as provider reasoning. */
  downloadFileName?: string
  /** Explicit parent "jump to latest" requests, independent of ongoing output. */
  followRequest?: number
  onFollowChange?: (following: boolean) => void
}

export const BoundedText = memo(function BoundedText({
  text,
  streaming = false,
  textClassName = 'text-sm leading-6 text-ink-2',
  viewportClassName = 'max-h-80',
  className = '',
  tailPreview = false,
  downloadFileName,
  followRequest = 0,
  onFollowChange,
}: BoundedTextProps) {
  const { t } = useI18n()
  const displayedText = useBatchedText(text, streaming)
  const [anchor, setAnchor] = useState<number | null>(() => streaming ? null : 0)
  const [following, setFollowing] = useState(streaming)
  const [frozenPreview, setFrozenPreview] = useState<string | null>(null)
  const followingRef = useRef(streaming)
  const viewport = useRef<HTMLDivElement>(null)
  const previousFollowRequest = useRef(followRequest)
  const scrollToTop = useRef(false)
  const visibleText = tailPreview && !following && frozenPreview != null
    ? frozenPreview
    : displayedText
  const window = getTextWindow(visibleText, anchor)
  const isWindowed = visibleText.length > TEXT_WINDOW_CHARACTERS
  const canResumeLatest = !following && (streaming || frozenPreview != null)

  const changeFollowing = (next: boolean) => {
    followingRef.current = next
    setFollowing(next)
    if (tailPreview) setFrozenPreview(next ? null : visibleText)
    onFollowChange?.(next)
  }

  useEffect(() => {
    if (anchor != null && anchor > 0 && anchor >= displayedText.length && !frozenPreview) {
      // Reset an invalid range after replacement. Final whitespace cleanup must
      // not move a reader whose earlier range is still available.
      setAnchor(streaming ? null : 0)
      followingRef.current = streaming
      setFollowing(streaming)
      setFrozenPreview(null)
      scrollToTop.current = !streaming
    }
    const element = viewport.current
    if (!element) return
    if (followingRef.current) element.scrollTop = element.scrollHeight
    else if (scrollToTop.current) element.scrollTop = 0
    scrollToTop.current = false
  }, [displayedText, window.start, window.end, streaming, anchor, frozenPreview])

  useEffect(() => {
    if (followRequest === previousFollowRequest.current) return
    previousFollowRequest.current = followRequest
    setAnchor(null)
    followingRef.current = true
    setFollowing(true)
    setFrozenPreview(null)
    const element = viewport.current
    if (element) element.scrollTop = element.scrollHeight
  }, [followRequest])

  const showRange = (start: number) => {
    changeFollowing(false)
    scrollToTop.current = true
    setAnchor(start)
  }

  const followLatest = () => {
    changeFollowing(true)
    setAnchor(null)
    const element = viewport.current
    if (element) element.scrollTop = element.scrollHeight
  }

  const download = () => {
    if (!downloadFileName) return
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = downloadFileName
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className={`min-w-0 ${className}`} data-bounded-text>
      <div
        ref={viewport}
        tabIndex={isWindowed ? 0 : undefined}
        data-text-viewport
        onScroll={(event) => {
          const element = event.currentTarget
          const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 32
          if (!atBottom && followingRef.current) {
            setAnchor(window.start)
            changeFollowing(false)
          } else if (atBottom && window.end >= visibleText.length && streaming) {
            setAnchor(null)
            changeFollowing(true)
          }
        }}
        className={`overflow-y-auto overscroll-contain pr-1 ${viewportClassName}`}
      >
        <div
          data-text-content
          data-visible-start={window.start}
          data-visible-end={window.end}
          className={`whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${textClassName}`}
        >
          {window.text}
          {streaming && following && window.end === visibleText.length && (
            <span className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-current align-[-2px]" aria-hidden />
          )}
        </div>
      </div>
      {(isWindowed || canResumeLatest) && (
        <div data-text-controls className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line/70 pt-2 text-[0.6875rem] leading-5 text-ink-3">
          {isWindowed && (
            <>
              <span className="tabular-nums">
                {t('textWindow.range', { start: window.start + 1, end: window.end, total: visibleText.length })}
              </span>
              <button type="button" className="text-pine hover:underline disabled:text-ink-4 disabled:no-underline" disabled={window.start === 0} onClick={() => showRange(0)}>
                {t('textWindow.start')}
              </button>
              <button type="button" className="text-pine hover:underline disabled:text-ink-4 disabled:no-underline" disabled={window.start === 0} onClick={() => showRange(Math.max(0, window.start - TEXT_WINDOW_CHARACTERS))}>
                {t('textWindow.earlier')}
              </button>
              <button type="button" className="text-pine hover:underline disabled:text-ink-4 disabled:no-underline" disabled={window.end === visibleText.length} onClick={() => showRange(window.end)}>
                {t('textWindow.later')}
              </button>
            </>
          )}
          {canResumeLatest && (
            <button type="button" className="font-medium text-pine hover:underline" onClick={followLatest}>
              {t('textWindow.latest')}
            </button>
          )}
          {isWindowed && downloadFileName && (
            <button type="button" className="ml-auto text-pine hover:underline" onClick={download}>
              {streaming ? t('textWindow.downloadReceived') : t('textWindow.download')}
            </button>
          )}
        </div>
      )}
    </div>
  )
})

interface CollapsibleTextProps extends BoundedTextProps {
  title: ReactNode
  description?: ReactNode
  meta?: ReactNode
}

/** Closed sections contain no text viewport, including during streaming updates. */
export const CollapsibleText = memo(function CollapsibleText({
  title,
  description,
  meta,
  className = '',
  ...textProps
}: CollapsibleTextProps) {
  const [open, setOpen] = useState(false)
  const contentId = useId()
  return (
    <div className={className} data-collapsible-text>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => {
          const next = !open
          setOpen(next)
          if (next) textProps.onFollowChange?.(false)
        }}
        className="flex w-full items-center gap-2 rounded-sm py-1 text-left text-xs font-medium leading-5 text-ink-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pine/30"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={`h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden>
          <path d="m6 3 5 5-5 5" />
        </svg>
        <span>{title}</span>
        {meta && <span className="ml-auto font-normal tabular-nums text-ink-4">{meta}</span>}
      </button>
      {open && (
        <div id={contentId} className="mt-2">
          {description && <p className="mb-2 text-[0.6875rem] leading-5 text-ink-4">{description}</p>}
          <BoundedText {...textProps} />
        </div>
      )}
    </div>
  )
})
