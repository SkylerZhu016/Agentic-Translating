import type { zhCN } from './catalogs/zh-CN'

export const SUPPORTED_LOCALES = ['zh-CN', 'en'] as const

export type AppLocale = (typeof SUPPORTED_LOCALES)[number]
export type MessageKey = keyof typeof zhCN
export type InterpolationValue = string | number

type PlaceholderNames<Template extends string> =
  Template extends `${string}{${infer Name}}${infer Rest}`
    ? Name | PlaceholderNames<Rest>
    : never

export type MessageKeyWithoutValues = {
  [Key in MessageKey]: [PlaceholderNames<(typeof zhCN)[Key]>] extends [never]
    ? Key
    : never
}[MessageKey]

export type MessageValues<Key extends MessageKey> = Record<
  PlaceholderNames<(typeof zhCN)[Key]>,
  InterpolationValue
>

export type MessageArgs<Key extends MessageKey> =
  [PlaceholderNames<(typeof zhCN)[Key]>] extends [never]
    ? [values?: never]
    : [values: MessageValues<Key>]

export type Translator = <Key extends MessageKey>(
  key: Key,
  ...args: MessageArgs<Key>
) => string
