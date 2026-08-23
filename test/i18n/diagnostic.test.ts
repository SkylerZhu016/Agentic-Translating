import { describe, expect, it } from 'vitest'
import { localizeDiagnosticError } from '@/src/i18n/diagnostic'
import { translate } from '@/src/i18n/translate'
import type { Translator } from '@/src/i18n/types'

describe('diagnostic error localization', () => {
  it('maps stable error codes without exposing persisted server language', () => {
    const en = ((key, ...args) => translate('en', key, ...args)) as Translator
    expect(localizeDiagnosticError(en, 'translation_agent_failed', 'fallback'))
      .toBe('The translation Agent call failed. Try again shortly.')
    expect(localizeDiagnosticError(
      en,
      JSON.stringify({
        error: 'legacy_stage_error_redacted',
        message: '该历史统筹错误的原始详情已隐藏。',
      }),
      'fallback',
    )).toBe(
      'The original details for this historical coordination error are hidden.',
    )
  })

  it('uses the caller fallback for unknown values', () => {
    const zh = ((key, ...args) => translate('zh-CN', key, ...args)) as Translator
    expect(localizeDiagnosticError(zh, 'provider-private-message', '请重试'))
      .toBe('请重试')
  })
})
