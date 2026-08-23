import type { AppLocale } from './types'

type DateInput = Date | number | string

function toDate(value: DateInput) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new RangeError('Invalid date value')
  return date
}

export function formatDate(
  value: DateInput,
  locale: AppLocale,
  options: Intl.DateTimeFormatOptions = {},
) {
  return new Intl.DateTimeFormat(locale, options).format(toDate(value))
}

export function formatNumber(
  value: number,
  locale: AppLocale,
  options: Intl.NumberFormatOptions = {},
) {
  return new Intl.NumberFormat(locale, options).format(value)
}

export function formatCurrency(
  value: number,
  locale: AppLocale,
  currency = 'USD',
  options: Omit<Intl.NumberFormatOptions, 'style' | 'currency'> = {},
) {
  return new Intl.NumberFormat(locale, {
    ...options,
    style: 'currency',
    currency,
  }).format(value)
}

const DURATION_UNITS = [
  { unit: 'day', milliseconds: 86_400_000 },
  { unit: 'hour', milliseconds: 3_600_000 },
  { unit: 'minute', milliseconds: 60_000 },
  { unit: 'second', milliseconds: 1_000 },
] as const

export function formatDuration(
  milliseconds: number,
  locale: AppLocale,
  options: { maxParts?: number } = {},
) {
  if (!Number.isFinite(milliseconds)) throw new RangeError('Invalid duration value')

  const rounded = Math.round(milliseconds)
  let sign = rounded < 0 ? -1 : 1
  let remaining = Math.abs(rounded)
  const parts: string[] = []
  const maxParts = Math.max(1, Math.floor(options.maxParts ?? 2))

  for (const { unit, milliseconds: unitMilliseconds } of DURATION_UNITS) {
    const amount = Math.floor(remaining / unitMilliseconds)
    if (amount === 0) continue
    remaining %= unitMilliseconds
    parts.push(
      new Intl.NumberFormat(locale, {
        style: 'unit',
        unit,
        unitDisplay: 'short',
      }).format(amount * sign),
    )
    sign = 1
    if (parts.length === maxParts) break
  }

  if (parts.length === 0) {
    return new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: 'millisecond',
      unitDisplay: 'short',
    }).format(rounded)
  }

  return parts.join(locale === 'zh-CN' ? '' : ' ')
}
