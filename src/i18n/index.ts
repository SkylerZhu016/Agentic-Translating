export { AppLoadingFallback } from './AppLoadingFallback'
export { inspectCatalogParity } from './catalog-parity'
export { catalogs, en, zhCN } from './catalogs'
export {
  diagnosticMessageKey,
  localizeDiagnosticError,
  type DiagnosticErrorCode,
} from './diagnostic'
export {
  formatCurrency,
  formatDate,
  formatDuration,
  formatNumber,
} from './formatters'
export { localizeEvidenceSummary } from './evidence'
export {
  normalizeLocale,
  readStoredLocale,
  resolveLocale,
  UI_LOCALE_SETTING_KEY,
  writeStoredLocale,
  type LocaleStorage,
} from './locale'
export { LocaleProvider, useI18n } from './LocaleProvider'
export { getPlaceholders, interpolateMessage, translate } from './translate'
export {
  SUPPORTED_LOCALES,
  type AppLocale,
  type InterpolationValue,
  type MessageArgs,
  type MessageKey,
  type MessageKeyWithoutValues,
  type MessageValues,
  type Translator,
} from './types'
