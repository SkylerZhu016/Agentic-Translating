import { catalogs } from './catalogs'
import type {
  AppLocale,
  InterpolationValue,
  MessageArgs,
  MessageKey,
} from './types'

const PLACEHOLDER_PATTERN = /\{([A-Za-z0-9_]+)\}/g

export function interpolateMessage(
  template: string,
  values?: Record<string, InterpolationValue>,
) {
  if (!values) return template
  return template.replace(PLACEHOLDER_PATTERN, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
  )
}

export function translate<Key extends MessageKey>(
  locale: AppLocale,
  key: Key,
  ...args: MessageArgs<Key>
) {
  const template: string = catalogs[locale][key]
  return interpolateMessage(
    template,
    args[0] as Record<string, InterpolationValue> | undefined,
  )
}

export function getPlaceholders(template: string) {
  return [...template.matchAll(PLACEHOLDER_PATTERN)]
    .map((match) => match[1])
    .filter((name, index, names) => names.indexOf(name) === index)
    .sort()
}
