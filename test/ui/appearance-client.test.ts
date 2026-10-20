import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APPEARANCE_STORAGE_KEY } from '@/src/lib/appearance/core'

function browser(initial: string | null = null, blocked = false) {
  let saved = initial
  const styles: Record<string, string> = {}
  const dataset: Record<string, string> = {}
  const handlers = new Set<(event: Partial<StorageEvent>) => void>()
  const storage = {
    getItem() {
      if (blocked) throw new Error('storage disabled')
      return saved
    },
    setItem(_key: string, value: string) {
      if (blocked) throw new Error('storage disabled')
      saved = value
    },
  }
  vi.stubGlobal('window', {
    localStorage: storage,
    addEventListener(_name: string, handler: (event: Partial<StorageEvent>) => void) { handlers.add(handler) },
    removeEventListener(_name: string, handler: (event: Partial<StorageEvent>) => void) { handlers.delete(handler) },
  })
  vi.stubGlobal('document', {
    documentElement: {
      dataset,
      style: { setProperty(name: string, value: string) { styles[name] = value } },
    },
  })
  return {
    styles, dataset,
    saved: () => saved,
    event(event: Partial<StorageEvent>) {
      for (const handler of handlers) handler({ storageArea: storage as unknown as Storage, ...event })
    },
  }
}

beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())

describe('appearance browser persistence', () => {
  it('retains separate theme accents and resets only the current theme', async () => {
    const env = browser()
    const appearance = await import('@/src/lib/appearance/client')
    expect(appearance.setAccent('#f00')).toBe(true)
    appearance.setTheme('violet')
    appearance.setAccent('#135')
    appearance.setTheme('blue')
    expect(appearance.readPreference().accents).toEqual({ blue: '#FF0000', violet: '#113355' })
    appearance.resetAccent()
    expect(appearance.readPreference().accents).toEqual({ violet: '#113355' })
    expect(JSON.parse(env.saved()!)).toEqual(appearance.readPreference())
  })

  it('restores a saved theme and applies it immediately', async () => {
    const env = browser(JSON.stringify({ version: 1, themeId: 'coral', accents: { coral: '#654321' } }))
    const appearance = await import('@/src/lib/appearance/client')
    appearance.initializeAppearance()
    expect(env.dataset.appearance).toBe('coral')
    expect(env.styles['--color-pine']).toBe('#654321')
    appearance.setTheme('graphite')
    expect(env.dataset.appearance).toBe('graphite')
    expect(JSON.parse(env.saved()!).themeId).toBe('graphite')
  })

  it('remains usable in memory when storage is disabled', async () => {
    const env = browser(null, true)
    const appearance = await import('@/src/lib/appearance/client')
    appearance.initializeAppearance()
    appearance.setTheme('violet')
    expect(appearance.setAccent('#fff')).toBe(true)
    expect(env.dataset.appearance).toBe('violet')
    expect(appearance.readPreference().accents.violet).toBe('#FFFFFF')
    expect(env.styles['--color-pine']).not.toBe('#FFFFFF')
  })

  it('rejects invalid color input without changing saved or applied values', async () => {
    const env = browser()
    const appearance = await import('@/src/lib/appearance/client')
    appearance.setTheme('coral')
    const previous = env.saved()
    const accent = env.styles['--color-pine']
    expect(appearance.setAccent('url(https://example.com)')).toBe(false)
    expect(env.saved()).toBe(previous)
    expect(env.styles['--color-pine']).toBe(accent)
  })

  it('tracks localStorage updates and clearing from another window', async () => {
    const env = browser()
    const appearance = await import('@/src/lib/appearance/client')
    const changed = vi.fn()
    const unsubscribe = appearance.subscribeAppearance(changed)
    env.event({ key: APPEARANCE_STORAGE_KEY, newValue: '{"version":1,"themeId":"graphite","accents":{}}' })
    expect(env.dataset.appearance).toBe('graphite')
    const calls = changed.mock.calls.length
    env.event({ key: 'unrelated-key', newValue: 'other' })
    expect(changed).toHaveBeenCalledTimes(calls)
    env.event({ key: null, newValue: null })
    expect(env.dataset.appearance).toBe('blue')
    unsubscribe()
  })
})
