import type { HTMLAttributes, ReactNode } from 'react'

// ---------------------------------------------------------------------------
// Toast — 呈现型通知条（无全局状态；挂载/堆叠由使用方负责）
// tone: default 纸面 / inverted 墨面
// ---------------------------------------------------------------------------

type ToastTone = 'default' | 'inverted'

export interface ToastProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: ToastTone
  title: ReactNode
  /** 补充说明 */
  message?: ReactNode
  /** 右侧操作位（如撤销按钮） */
  action?: ReactNode
  /** 提供时渲染关闭钮 */
  onClose?: () => void
  /** 透传为 data-testid（C6 约定） */
  testId?: string
}

const toneClass: Record<ToastTone, string> = {
  default: 'border-line bg-paper-raise text-ink shadow-pop',
  inverted: 'border-ink bg-ink text-paper shadow-pop',
}

export function Toast({
  tone = 'default',
  title,
  message,
  action,
  onClose,
  testId,
  className = '',
  ...rest
}: ToastProps) {
  return (
    <div
      role="status"
      data-testid={testId}
      className={[
        'pointer-events-auto flex w-full max-w-sm animate-rise items-start gap-3 rounded-md border px-4 py-3',
        toneClass[tone],
        className,
      ].join(' ')}
      {...rest}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-5">{title}</p>
        {message != null && (
          <p className={tone === 'inverted' ? 'mt-0.5 text-xs leading-5 text-paper/70' : 'mt-0.5 text-xs leading-5 text-ink-3'}>
            {message}
          </p>
        )}
      </div>
      {action != null && <div className="shrink-0">{action}</div>}
      {onClose != null && (
        <button
          type="button"
          aria-label="关闭通知"
          onClick={onClose}
          className={tone === 'inverted' ? 'shrink-0 text-paper/70 hover:text-paper' : 'shrink-0 text-ink-3 hover:text-ink'}
        >
          ✕
        </button>
      )}
    </div>
  )
}
