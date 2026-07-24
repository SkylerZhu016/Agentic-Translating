'use client'

// ---------------------------------------------------------------------------
// VersionHistory —— 版本历史侧栏（append-only）
// 列表 v1 组装 / v2 编辑 / v3 恢复…+时间+摘要首行；当前版本高亮；
// 点击非当前版本 → 确认弹层 → restore API → 全文刷新为新版本。
// ---------------------------------------------------------------------------

import { useState } from 'react'
import { TID } from '@/src/lib/testids'
import { Badge, Button, Modal, Spinner } from '@/src/components/ui'
import { truncate, type FinalVersion } from './types'

export interface VersionHistoryProps {
  versions: FinalVersion[]
  currentVersionNo: number | null
  /** 父级执行 restore API + 刷新；抛错则弹层内展示 */
  onRestore: (versionNo: number) => Promise<void>
}

const SOURCE_META: Record<FinalVersion['source'], { label: string; variant: 'solid' | 'outline' | 'subtle' }> = {
  assemble: { label: '组装', variant: 'solid' },
  main_draft: { label: '主成稿', variant: 'solid' },
  edit: { label: '编辑', variant: 'outline' },
  restore: { label: '恢复', variant: 'subtle' },
  revert: { label: '撤销', variant: 'subtle' },
}

function formatTime(createdAt: string): string {
  // SQLite datetime('now') → "YYYY-MM-DD HH:MM:SS"，取 "MM-DD HH:MM"
  return createdAt.length >= 16 ? createdAt.slice(5, 16) : createdAt
}

export function VersionHistory({ versions, currentVersionNo, onRestore }: VersionHistoryProps) {
  const [pending, setPending] = useState<FinalVersion | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ordered = [...versions].sort((a, b) => b.version_no - a.version_no)

  const confirmRestore = async () => {
    if (!pending || restoring) return
    setRestoring(true)
    setError(null)
    try {
      await onRestore(pending.version_no)
      setPending(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '恢复失败，请重试')
    } finally {
      setRestoring(false)
    }
  }

  return (
    <div data-testid={TID.edit.versionHistory}>
      {ordered.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm leading-6 text-ink-4">
          尚无版本——组装完成后，每次修改与恢复都会在此留痕
        </p>
      ) : (
        <ol className="max-h-72 divide-y divide-line overflow-y-auto">
          {ordered.map((version) => {
            const isCurrent = version.version_no === currentVersionNo
            const meta = SOURCE_META[version.source]
            return (
              <li key={version.version_no}>
                <button
                  type="button"
                  data-testid={TID.edit.versionItem}
                  data-version-no={version.version_no}
                  data-current={isCurrent ? 'true' : 'false'}
                  disabled={isCurrent || restoring}
                  onClick={() => {
                    setError(null)
                    setPending(version)
                  }}
                  title={isCurrent ? '当前版本' : `恢复到 v${version.version_no}`}
                  className={[
                    'flex w-full items-start gap-3 px-5 py-2.5 text-left transition-colors duration-150',
                    isCurrent
                      ? 'cursor-default border-l-2 border-ink bg-paper-sink/70 pl-[1.125rem]'
                      : 'border-l-2 border-transparent pl-[1.125rem] hover:bg-paper-sink',
                    'disabled:cursor-default',
                  ].join(' ')}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="font-serif text-sm font-medium text-ink">v{version.version_no}</span>
                      <Badge variant={meta.variant}>{meta.label}</Badge>
                      {isCurrent && (
                        <span className="text-[0.6875rem] font-medium tracking-wide text-ink-3">当前</span>
                      )}
                      <span className="ml-auto shrink-0 text-[0.6875rem] tabular-nums text-ink-4">
                        {formatTime(version.created_at)}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-xs leading-5 text-ink-3">
                      {truncate(version.text.split('\n')[0] ?? '', 48)}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
      )}

      <Modal
        open={pending != null}
        onClose={() => {
          if (!restoring) setPending(null)
        }}
        title={pending ? `恢复到 v${pending.version_no}` : undefined}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setPending(null)} disabled={restoring}>
              取消
            </Button>
            <Button size="sm" onClick={confirmRestore} disabled={restoring}>
              {restoring ? <Spinner size="sm" /> : '确认恢复'}
            </Button>
          </>
        }
      >
        {pending && (
          <div>
            <p className="text-sm leading-6 text-ink-2">
              全文将回到 v{pending.version_no} 的内容；当前版本不会丢失——恢复会作为新版本追加到历史。
            </p>
            <blockquote className="mt-3 max-h-32 overflow-y-auto rounded-sm border border-line bg-paper px-3 py-2 poem-text-sm text-ink-3">
              {truncate(pending.text, 120)}
            </blockquote>
            {error && <p className="mt-2 text-xs leading-5 text-cinnabar">{error}</p>}
          </div>
        )}
      </Modal>
    </div>
  )
}
