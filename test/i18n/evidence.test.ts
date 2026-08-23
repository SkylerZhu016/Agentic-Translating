import { describe, expect, it } from 'vitest'
import { localizeEvidenceSummary, translate } from '@/src/i18n'
import type { AppLocale, MessageArgs, MessageKey, Translator } from '@/src/i18n'

function translator(locale: AppLocale): Translator {
  return <Key extends MessageKey>(key: Key, ...args: MessageArgs<Key>) => (
    translate(locale, key, ...args)
  )
}

describe('localized deterministic evidence summaries', () => {
  it('maps either stored locale form into the active Chinese locale', () => {
    const t = translator('zh-CN')
    expect(localizeEvidenceSummary(t, 'No deterministic constraint warnings were found.'))
      .toBe('未发现确定性约束警告')
    expect(localizeEvidenceSummary(t, '1 auxiliary warnings.'))
      .toBe('1 项辅助警告')
  })

  it('maps either stored locale form into the active English locale', () => {
    const t = translator('en')
    expect(localizeEvidenceSummary(t, '未发现确定性约束警告'))
      .toBe('No deterministic constraint warnings were found.')
    expect(localizeEvidenceSummary(t, '2 项辅助警告'))
      .toBe('2 auxiliary warnings.')
  })

  it('preserves unknown evidence text verbatim', () => {
    const t = translator('zh-CN')
    expect(localizeEvidenceSummary(t, 'Custom evidence note.'))
      .toBe('Custom evidence note.')
  })
})
