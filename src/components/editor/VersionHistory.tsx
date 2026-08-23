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
import { useI18n } from '@/src/i18n/LocaleProvider'

export interface VersionHistoryProps {
  versions: FinalVersion[]
  currentVersionNo: number | null
  /** 父级执行 restore API + 刷新；抛错则弹层内展示 */
  onRestore: (versionNo: number) => Promise<void>
}

const SOURCE_VARIANT: Record<FinalVersion['source'], 'solid' | 'outline' | 'subtle'> = {
  assemble: 'solid',
  main_draft: 'solid',
  edit: 'outline',
  restore: 'subtle',
  revert: 'subtle',
}

export function VersionHistory({ versions, currentVersionNo, onRestore }: VersionHistoryProps) {
  const { t, formatDate } = useI18n()
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
      setError(err instanceof Error ? err.message : t('versions.error.restore'))
    } finally {
      setRestoring(false)
    }
  }

  return (
    <div data-testid={TID.edit.versionHistory}>
      {ordered.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm leading-6 text-ink-4">
          {t('versions.empty')}
        </p>
      ) : (
        <ol className="max-h-72 divide-y divide-line overflow-y-auto">
          {ordered.map((version) => {
            const isCurrent = version.version_no === currentVersionNo
            const sourceLabel = version.source === 'assemble'
              ? t('version.source.assemble')
              : version.source === 'main_draft'
                ? t('version.source.mainDraft')
                : version.source === 'edit'
                  ? t('version.source.edit')
                  : version.source === 'revert'
                    ? t('version.source.revert')
                    : t('version.source.restore')
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
                  title={isCurrent
                    ? t('versions.currentTitle')
                    : t('versions.restoreTitle', { version: version.version_no })}
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
                      <Badge variant={SOURCE_VARIANT[version.source]}>{sourceLabel}</Badge>
                      {isCurrent && (
                        <span className="text-[0.6875rem] font-medium tracking-wide text-ink-3">{t('versions.current')}</span>
                      )}
                      <span className="ml-auto shrink-0 text-[0.6875rem] tabular-nums text-ink-4">
                        {formatDate(
                          version.created_at.includes('T')
                            ? version.created_at
                            : `${version.created_at.replace(' ', 'T')}Z`,
                          { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' },
                        )}
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
        title={pending ? t('versions.restoreTitle', { version: pending.version_no }) : undefined}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setPending(null)} disabled={restoring}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={confirmRestore} disabled={restoring}>
              {restoring ? <Spinner size="sm" /> : t('versions.restoreConfirm')}
            </Button>
          </>
        }
      >
        {pending && (
          <div>
            <p className="text-sm leading-6 text-ink-2">
              {t('versions.restoreDescription', { version: pending.version_no })}
            </p>
            <blockquote className="mt-3 max-h-32 overflow-y-auto rounded-sm border border-line bg-paper px-3 py-2 poem-text-sm text-ink-3">
              {truncate(pending.text, 120)}
            </blockquote>
            {error && <p role="alert" className="mt-2 text-xs leading-5 text-cinnabar">{error}</p>}
          </div>
        )}
      </Modal>
    </div>
  )
}
