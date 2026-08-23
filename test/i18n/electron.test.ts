import { describe, expect, it } from 'vitest'
import {
  assertElectronCatalogParity,
  createElectronTranslator,
  normalizeElectronLocale,
} from '../../electron/i18n.mjs'

describe('Electron locale catalog', () => {
  it('keeps the native-dialog catalogs in parity', () => {
    expect(assertElectronCatalogParity()).toEqual({ missing: [], extra: [] })
  })

  it('normalizes system locales and interpolates native messages', () => {
    expect(normalizeElectronLocale('zh-Hans-CN')).toBe('zh-CN')
    expect(normalizeElectronLocale('en-US')).toBe('en')
    expect(createElectronTranslator('en')('file.tooMany', { limit: 500 }))
      .toBe('The selection exceeds 500 files')
    expect(createElectronTranslator('zh-CN')('credential.reset.detail', {
      directory: 'D:\\backup',
    })).toBe('恢复备份：D:\\backup')
  })
})
