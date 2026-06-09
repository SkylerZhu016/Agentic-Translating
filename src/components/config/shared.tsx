'use client'

// ---------------------------------------------------------------------------
// 配置面板共享原语 —— Field / Select / Toggle / Skeleton / Toast 栈
// 复用任务 20 基础组件（Input/Textarea 同语言描边），不引入新视觉语汇
// ---------------------------------------------------------------------------

import {
  useCallback,
  useRef,
  useState,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react'
import { Toast } from '@/src/components/ui'

// ── Field：标签 + 控件 + 提示/错误 ──────────────────────────────

export interface FieldProps {
  label: string
  /** 灰色辅助说明 */
  hint?: string
  /** 校验错误（可见且阻止提交的语义由调用方保证） */
  error?: string | null
  children: ReactNode
}

export function Field({ label, hint, error, children }: FieldProps) {
  return (
    <div>
      <span className="mb-1.5 block text-xs font-medium text-ink-2">{label}</span>
      {children}
      {error != null ? (
        <p role="alert" className="mt-1 text-xs font-medium text-ink">
          {error}
        </p>
      ) : hint != null ? (
        <p className="mt-1 text-xs leading-5 text-ink-4">{hint}</p>
      ) : null}
    </div>
  )
}

// ── Select：与 Input 同一描边语言的原生下拉 ─────────────────────

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  testId?: string
}

export function Select({ testId, className = '', children, ...rest }: SelectProps) {
  return (
    <select
      data-testid={testId}
      className={[
        'h-9 w-full rounded-sm border border-line bg-paper-raise px-2.5 text-sm text-ink transition-colors duration-150',
        'hover:border-line-2 focus:border-ink focus:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      ].join(' ')}
      {...rest}
    >
      {children}
    </select>
  )
}

// ── Toggle：墨色开关（role=switch） ─────────────────────────────

export interface ToggleProps {
  checked: boolean
  onChange: (next: boolean) => void
  testId?: string
  ariaLabel?: string
}

export function Toggle({ checked, onChange, testId, ariaLabel }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      data-testid={testId}
      onClick={() => onChange(!checked)}
      className={[
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-150',
        checked ? 'border-ink bg-ink' : 'border-line-2 bg-paper-sink',
      ].join(' ')}
    >
      <span
        aria-hidden
        className={[
          'inline-block h-3.5 w-3.5 rounded-full transition-transform duration-150',
          checked ? 'translate-x-[1.125rem] bg-paper' : 'translate-x-0.5 bg-ink-4',
        ].join(' ')}
      />
    </button>
  )
}

// ── Skeleton：加载骨架块 ────────────────────────────────────────

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-sm bg-paper-sink ${className}`} />
}

// ── Toast 栈：面板内本地状态，自动消退 ──────────────────────────

export interface ToastItem {
  id: number
  title: string
  message?: string
  tone?: 'default' | 'inverted'
}

export type NotifyFn = (
  title: string,
  opts?: { message?: string; tone?: 'default' | 'inverted' },
) => void

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const idRef = useRef(0)

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id))
  }, [])

  const push: NotifyFn = useCallback((title, opts) => {
    idRef.current += 1
    const id = idRef.current
    setToasts((list) => [...list, { id, title, message: opts?.message, tone: opts?.tone }])
    setTimeout(() => {
      setToasts((list) => list.filter((t) => t.id !== id))
    }, 3600)
  }, [])

  return { toasts, push, dismiss }
}

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[]
  onDismiss: (id: number) => void
}) {
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2">
      {toasts.map((t) => (
        <Toast
          key={t.id}
          tone={t.tone ?? 'default'}
          title={t.title}
          message={t.message}
          onClose={() => onDismiss(t.id)}
        />
      ))}
    </div>
  )
}
