export const APPEARANCE_STORAGE_KEY = 'agentic-translating.appearance.v1'

export type AppearanceThemeId = 'blue' | 'violet' | 'coral' | 'graphite'

export interface AppearanceTheme {
  id: AppearanceThemeId
  nameKey: `appearance.theme.${AppearanceThemeId}`
  colors: {
    paper: string
    surface: string
    panel: string
    accent: string
    ink: string
    ink2: string
    ink3: string
    ink4: string
    line: string
    lineStrong: string
  }
}

export const APPEARANCE_THEMES: readonly AppearanceTheme[] = [
  {
    id: 'blue',
    nameKey: 'appearance.theme.blue',
    colors: {
      paper: '#F3F6FC', surface: '#FFFFFF', panel: '#E9EEFF', accent: '#4263EB',
      ink: '#202A44', ink2: '#475572', ink3: '#626F89', ink4: '#727F96',
      line: '#DCE3F0', lineStrong: '#B5C1D8',
    },
  },
  {
    id: 'violet',
    nameKey: 'appearance.theme.violet',
    colors: {
      paper: '#F6F4FA', surface: '#FFFFFF', panel: '#EEE8FF', accent: '#7A5AF5',
      ink: '#302A3E', ink2: '#5B506D', ink3: '#756880', ink4: '#82758D',
      line: '#E4DEEC', lineStrong: '#C6BCD3',
    },
  },
  {
    id: 'coral',
    nameKey: 'appearance.theme.coral',
    colors: {
      paper: '#F7F4F0', surface: '#FFFEFC', panel: '#FAEAE4', accent: '#B9503F',
      ink: '#352D29', ink2: '#65534C', ink3: '#7C6B62', ink4: '#8A776D',
      line: '#E8DED6', lineStrong: '#CEBFB3',
    },
  },
  {
    id: 'graphite',
    nameKey: 'appearance.theme.graphite',
    colors: {
      paper: '#F4F4F5', surface: '#FFFFFF', panel: '#E9E9ED', accent: '#34363D',
      ink: '#25262B', ink2: '#50515C', ink3: '#6D6E79', ink4: '#7C7D88',
      line: '#E1E1E6', lineStrong: '#BFBFC8',
    },
  },
]

export interface AppearancePreference {
  version: 1
  themeId: AppearanceThemeId
  accents: Partial<Record<AppearanceThemeId, string>>
}

export const DEFAULT_APPEARANCE: AppearancePreference = {
  version: 1,
  themeId: 'blue',
  accents: {},
}

export function isAppearanceThemeId(value: unknown): value is AppearanceThemeId {
  return APPEARANCE_THEMES.some((theme) => theme.id === value)
}

/** Only literal hexadecimal colors cross the preference-to-CSS boundary. */
export function normalizeAccent(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 32) return null
  const color = value.trim()
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) return null
  const expanded = color.length === 4
    ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
    : color
  return expanded.toUpperCase()
}

export function normalizePreference(value: unknown): AppearancePreference {
  if (!value || typeof value !== 'object') return { ...DEFAULT_APPEARANCE, accents: {} }
  const input = value as Record<string, unknown>
  if (input.version !== 1) return { ...DEFAULT_APPEARANCE, accents: {} }
  const accents: AppearancePreference['accents'] = {}
  if (input.accents && typeof input.accents === 'object' && !Array.isArray(input.accents)) {
    const values = input.accents as Record<string, unknown>
    for (const { id } of APPEARANCE_THEMES) {
      const color = normalizeAccent(values[id])
      if (color) accents[id] = color
    }
  }
  return {
    version: 1,
    themeId: isAppearanceThemeId(input.themeId) ? input.themeId : 'blue',
    accents,
  }
}

export function parseAppearancePreference(serialized: string | null): AppearancePreference {
  try {
    return normalizePreference(serialized ? JSON.parse(serialized) : null)
  } catch {
    return { ...DEFAULT_APPEARANCE, accents: {} }
  }
}

function rgb(color: string): number[] {
  return [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16))
}

function luminance(color: string): number {
  const channels = rgb(color).map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

export function colorContrast(first: string, second: string): number {
  const a = normalizeAccent(first)
  const b = normalizeAccent(second)
  if (!a || !b) return 0
  const l1 = luminance(a)
  const l2 = luminance(b)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

/**
 * The existing UI uses one accent both as text on light panels and as a button
 * behind white text. Preserve its hue, reducing brightness only when required.
 */
export function accessibleAccent(color: string, theme: AppearanceTheme): string {
  const normalized = normalizeAccent(color) ?? theme.colors.accent
  const surfaces = ['#FFFFFF', theme.colors.paper, theme.colors.surface, theme.colors.panel]
  const readable = (candidate: string, minimum: number) =>
    surfaces.every((surface) => colorContrast(candidate, surface) >= minimum)
  if (readable(normalized, 4.5)) return normalized
  const channels = rgb(normalized)
  const darken = (factor: number) => `#${channels
    .map((channel) => Math.floor(channel * factor).toString(16).padStart(2, '0'))
    .join('')}`.toUpperCase()
  let low = 0
  let high = 1
  for (let index = 0; index < 24; index += 1) {
    const middle = (low + high) / 2
    if (readable(darken(middle), 4.55)) low = middle
    else high = middle
  }
  return darken(low)
}

export function resolveAppearance(value: AppearancePreference) {
  const preference = normalizePreference(value)
  const theme = APPEARANCE_THEMES.find((entry) => entry.id === preference.themeId)!
  const customAccent = preference.accents[theme.id] ?? null
  const effectiveAccent = accessibleAccent(customAccent ?? theme.colors.accent, theme)
  const colors = theme.colors
  return {
    theme,
    customAccent,
    effectiveAccent,
    variables: {
      '--color-paper': colors.paper,
      '--color-paper-raise': colors.surface,
      '--color-paper-sink': colors.panel,
      '--color-ink': colors.ink,
      '--color-ink-2': colors.ink2,
      '--color-ink-3': colors.ink3,
      '--color-ink-4': colors.ink4,
      '--color-line': colors.line,
      '--color-line-2': colors.lineStrong,
      '--color-pine': effectiveAccent,
      '--color-moss': effectiveAccent,
    },
  }
}
