import { describe, expect, it } from 'vitest'
import {
  catalogs,
  inspectCatalogParity,
  interpolateMessage,
  translate,
} from '@/src/i18n'

describe('i18n catalogs', () => {
  it('keeps every locale on the same keys and placeholder contract', () => {
    expect(inspectCatalogParity()).toEqual([])
    expect(Object.keys(catalogs.en)).toHaveLength(Object.keys(catalogs['zh-CN']).length)
  })

  it('looks up messages by locale and interpolates typed values', () => {
    expect(translate('zh-CN', 'nav.workspace')).toBe('工作台')
    expect(translate('en', 'nav.workspace')).toBe('Workspace')
    expect(translate('zh-CN', 'common.itemCount', { count: 3 })).toBe('共 3 项')
    expect(translate('en', 'common.itemCount', { count: 3 })).toBe('3 items')
  })

  it('leaves an unresolved runtime placeholder visible', () => {
    expect(interpolateMessage('{known} {missing}', { known: 'value' }))
      .toBe('value {missing}')
  })
})
