export type ElectronLocale = 'zh-CN' | 'en'

export const ELECTRON_LOCALES: readonly ElectronLocale[]
export const electronCatalogs: Record<ElectronLocale, Record<string, string>>

export function normalizeElectronLocale(value: unknown): ElectronLocale
export function createElectronTranslator(
  locale: unknown,
): (key: string, values?: Record<string, string | number>) => string
export function assertElectronCatalogParity(): {
  missing: string[]
  extra: string[]
}
