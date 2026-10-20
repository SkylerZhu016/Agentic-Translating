import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { APPEARANCE_BOOTSTRAP_SOURCE } from '@/src/lib/appearance/bootstrap'
import {
  APPEARANCE_THEMES,
  accessibleAccent,
  colorContrast,
  normalizeAccent,
  normalizePreference,
  parseAppearancePreference,
  resolveAppearance,
} from '@/src/lib/appearance/core'

function runBootstrap(serialized: string | null, blocked = false) {
  const variables: Record<string, string> = {}
  const root = {
    style: { setProperty(name: string, value: string) { variables[name] = value } },
    dataset: {} as Record<string, string>,
  }
  const context = vm.createContext({
    document: { documentElement: root },
    localStorage: {
      getItem() {
        if (blocked) throw new Error('storage disabled')
        return serialized
      },
    },
  })
  vm.runInContext(APPEARANCE_BOOTSTRAP_SOURCE, context)
  return { variables, themeId: root.dataset.appearance }
}

describe('appearance preferences and first-paint initialization', () => {
  it('accepts only literal hex colors and canonicalizes short forms', () => {
    expect(normalizeAccent(' #a3f ')).toBe('#AA33FF')
    expect(normalizeAccent('#12AbEf')).toBe('#12ABEF')
    for (const value of ['white', 'rgb(1,2,3)', '#FFFF', '#12345678', 'var(--x)', 'url(https://example.com)', '#fff; color:red', '</script>', null]) {
      expect(normalizeAccent(value)).toBeNull()
    }
  })

  it('uses the default for corrupt and unsupported saved values', () => {
    for (const serialized of ['{', 'null', '[]', '{"version":2,"themeId":"coral"}']) {
      expect(parseAppearancePreference(serialized)).toEqual({ version: 1, themeId: 'blue', accents: {} })
    }
    expect(normalizePreference({
      version: 1,
      themeId: 'unknown',
      accents: { blue: '#f0f', violet: 'var(--x)', alien: '#000000' },
    })).toEqual({ version: 1, themeId: 'blue', accents: { blue: '#FF00FF' } })
  })

  it.each(APPEARANCE_THEMES)('keeps white buttons and all $id light surfaces readable', (theme) => {
    for (const input of ['#FFFFFF', '#FFFF00', '#00FF00', '#00FFFF', '#FF0000', '#0000FF', '#000000', '#777777', '#FDF6E3', theme.colors.accent]) {
      const effective = accessibleAccent(input, theme)
      expect(normalizeAccent(effective)).toBe(effective)
      for (const surface of ['#FFFFFF', theme.colors.paper, theme.colors.surface, theme.colors.panel]) {
        expect(colorContrast(effective, surface)).toBeGreaterThanOrEqual(4.5)
      }
    }
    expect(accessibleAccent('#000000', theme)).toBe('#000000')
  })

  it('applies identical values before first paint and after hydration', () => {
    for (const theme of APPEARANCE_THEMES) {
      for (const custom of [null, '#FFF', '#FfFf00', '#00FF00', '#123456', '#000', 'var(--hostile)']) {
        const serialized = JSON.stringify({
          version: 1,
          themeId: theme.id,
          accents: custom ? { [theme.id]: custom } : {},
        })
        const resolved = resolveAppearance(parseAppearancePreference(serialized))
        expect(runBootstrap(serialized)).toEqual({
          themeId: theme.id,
          variables: resolved.variables,
        })
      }
    }
  })

  it('keeps first paint safe for bad data, blocked storage and unsupported versions', () => {
    const fallback = resolveAppearance(parseAppearancePreference(null))
    for (const serialized of ['{', 'null', '[]', '{"version":2,"themeId":"coral","accents":{"blue":"#fff"}}']) {
      expect(runBootstrap(serialized)).toEqual({ themeId: 'blue', variables: fallback.variables })
    }
    expect(runBootstrap('{"version":1,"themeId":"coral"}', true)).toEqual({
      themeId: 'blue', variables: fallback.variables,
    })
    expect(APPEARANCE_BOOTSTRAP_SOURCE).not.toContain('</script')
  })
})
