import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '@/src/i18n'
import { OutputBudgetField, OutputBudgetHint, parseOutputBudget } from '@/src/components/config/OutputBudgetField'

vi.mock('next/navigation', () => ({ usePathname: () => '/config' }))

function renderField(value: string, locale: 'en' | 'zh-CN' = 'zh-CN') {
  return renderToStaticMarkup(createElement(LocaleProvider, {
    initialLocale: locale,
    children: createElement(OutputBudgetField, { value, role: '主编', onChange: vi.fn() }),
  }))
}

describe('output budget input', () => {
  it.each(['', ' ', '\t'])('treats blank %j as the application default', (value) => {
    expect(parseOutputBudget(value)).toBeNull()
  })

  it.each(['1', '32768', ' 4096 ', '0008192'])('accepts a positive integer %j', (value) => {
    expect(parseOutputBudget(value)).toBe(Number(value))
  })

  it.each(['0', '-1', '1.5', '1e4', 'NaN', 'Infinity', 'abc', '+4096', '9_000', '9007199254740992'])(
    'rejects invalid or imprecise values %j',
    (value) => {
      expect(parseOutputBudget(value)).toBeUndefined()
      const markup = renderField(value)
      expect(markup).toContain('aria-invalid="true"')
      expect(markup).toContain('role="alert"')
      expect(markup).toContain('请输入大于 0 的整数')
    },
  )

  it('keeps an accessible role-specific label and shows the app default in the placeholder', () => {
    const markup = renderField('32768')
    expect(markup).toContain('主编输出预算（token）')
    expect(markup).toContain('aria-invalid="false"')
    expect(markup).not.toContain('DeepSeek')
    expect(renderField('')).toContain('应用默认：4096')
    expect(renderField('', 'en')).toContain('App default: 4096')
  })

  it('explains the shared reasoning budget and the actual application fallback', () => {
    const markup = renderToStaticMarkup(createElement(LocaleProvider, {
      initialLocale: 'zh-CN',
      children: createElement(OutputBudgetHint),
    }))
    expect(markup).toContain('思考与正文共用此额度')
    expect(markup).toContain('当前为 4096 token')
    expect(markup.match(/DeepSeek 长思考可尝试 32768/g)).toHaveLength(1)
    expect(markup).not.toContain('服务商默认')
  })
})
