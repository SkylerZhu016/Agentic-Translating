import { catalogs, zhCN } from './catalogs'
import { getPlaceholders } from './translate'
import type { AppLocale, MessageKey } from './types'

export interface CatalogParityIssue {
  locale: AppLocale
  key: string
  kind: 'missing-key' | 'extra-key' | 'placeholder-mismatch'
}

export function inspectCatalogParity(): CatalogParityIssue[] {
  const referenceKeys = Object.keys(zhCN) as MessageKey[]
  const referenceKeySet = new Set<string>(referenceKeys)
  const issues: CatalogParityIssue[] = []

  for (const locale of Object.keys(catalogs) as AppLocale[]) {
    const catalog = catalogs[locale] as Record<string, string>
    for (const key of referenceKeys) {
      if (!(key in catalog)) {
        issues.push({ locale, key, kind: 'missing-key' })
        continue
      }
      const expected = getPlaceholders(zhCN[key])
      const actual = getPlaceholders(catalog[key])
      if (expected.join('\u0000') !== actual.join('\u0000')) {
        issues.push({ locale, key, kind: 'placeholder-mismatch' })
      }
    }
    for (const key of Object.keys(catalog)) {
      if (!referenceKeySet.has(key)) issues.push({ locale, key, kind: 'extra-key' })
    }
  }

  return issues
}
