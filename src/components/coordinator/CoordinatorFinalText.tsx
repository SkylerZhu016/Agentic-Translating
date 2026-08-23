'use client'

// ---------------------------------------------------------------------------
// CoordinatorFinalText —— 最终译文区（TID final-text）
// 展示最新版本文本（.poem-text 排版：宋体、松行距、微字距）
// 数据以服务端为准：挂载自取 + 监听 session-bus 变更信号
// （编辑/选中交互归 Task 24，此处仅呈现）
// ---------------------------------------------------------------------------

import { TID } from '@/src/lib/testids'
import { useSessionFull } from './use-session'
import { useI18n } from '@/src/i18n/LocaleProvider'

export function CoordinatorFinalText() {
  const { t } = useI18n()
  const { data } = useSessionFull()
  const latest = data?.finalVersion ?? null

  if (!latest) {
    return (
      <div data-testid={TID.edit.finalText} className="poem-text min-h-56">
        <span className="text-ink-4">
          {t('coordinator.final.empty')}
        </span>
      </div>
    )
  }

  return (
    <div>
      <p className="mb-2 text-xs text-ink-4">
        {t('coordinator.final.version', {
          version: latest.version_no,
          source: latest.source === 'assemble'
            ? t('version.source.assemble')
            : latest.source === 'main_draft'
              ? t('version.source.mainDraft')
              : latest.source === 'edit'
                ? t('version.source.edit')
                : latest.source === 'revert'
                  ? t('version.source.revert')
                  : t('version.source.restore'),
        })}
      </p>
      <div data-testid={TID.edit.finalText} className="poem-text min-h-56">
        {latest.text}
      </div>
    </div>
  )
}
