'use client'

import { useSyncExternalStore } from 'react'
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  isAppearanceThemeId,
  normalizeAccent,
  normalizePreference,
  parseAppearancePreference,
  resolveAppearance,
  type AppearancePreference,
  type AppearanceThemeId,
} from './core'

interface AppearanceSnapshot {
  themeId: AppearanceThemeId
  customAccent: string | null
  effectiveAccent: string
  persistenceError: boolean
}

function snapshotFor(preference: AppearancePreference, persistenceError: boolean): AppearanceSnapshot {
  const resolved = resolveAppearance(preference)
  return {
    themeId: preference.themeId,
    customAccent: resolved.customAccent,
    effectiveAccent: resolved.effectiveAccent,
    persistenceError,
  }
}

const serverSnapshot = snapshotFor(DEFAULT_APPEARANCE, false)
let preference: AppearancePreference = { ...DEFAULT_APPEARANCE, accents: {} }
let currentSnapshot = serverSnapshot
let initialized = false
let listening = false
const listeners = new Set<() => void>()

function paint(value: AppearancePreference) {
  if (typeof document === 'undefined') return
  const { theme, variables } = resolveAppearance(value)
  for (const [name, color] of Object.entries(variables)) {
    document.documentElement.style.setProperty(name, color)
  }
  document.documentElement.dataset.appearance = theme.id
}

function publish(value: AppearancePreference, persistenceError: boolean) {
  preference = value
  paint(value)
  currentSnapshot = snapshotFor(value, persistenceError)
  for (const listener of listeners) listener()
}

function handleStorage(event: StorageEvent) {
  if (event.key !== APPEARANCE_STORAGE_KEY && event.key !== null) return
  // Ignore same-origin sessionStorage events, while keeping blocked-storage
  // environments usable through the in-memory preference.
  try {
    if (event.storageArea && event.storageArea !== window.localStorage) return
  } catch {
    return
  }
  publish(parseAppearancePreference(event.key === null ? null : event.newValue), false)
}

export function initializeAppearance() {
  if (typeof window === 'undefined') return
  if (!initialized) {
    initialized = true
    try {
      publish(parseAppearancePreference(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)), false)
    } catch {
      publish(preference, true)
    }
  }
  if (!listening) {
    window.addEventListener('storage', handleStorage)
    listening = true
  }
}

/** Return a copy so callers cannot mutate the current preference by accident. */
export function readPreference(): AppearancePreference {
  initializeAppearance()
  return { ...preference, accents: { ...preference.accents } }
}

export function applyPreference(value: AppearancePreference) {
  initializeAppearance()
  const next = normalizePreference(value)
  let persistenceError = false
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(next))
    } catch {
      persistenceError = true
    }
  }
  publish(next, persistenceError)
}

export function setTheme(themeId: AppearanceThemeId) {
  if (!isAppearanceThemeId(themeId)) return
  const current = readPreference()
  applyPreference({ ...current, themeId })
}

export function setAccent(value: string): boolean {
  const color = normalizeAccent(value)
  if (!color) return false
  const current = readPreference()
  applyPreference({
    ...current,
    accents: { ...current.accents, [current.themeId]: color },
  })
  return true
}

export function resetAccent() {
  const current = readPreference()
  delete current.accents[current.themeId]
  applyPreference(current)
}

export function subscribeAppearance(listener: () => void) {
  listeners.add(listener)
  initializeAppearance()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && listening && typeof window !== 'undefined') {
      window.removeEventListener('storage', handleStorage)
      listening = false
    }
  }
}

export function useAppearance() {
  const snapshot = useSyncExternalStore(
    subscribeAppearance,
    () => currentSnapshot,
    () => serverSnapshot,
  )
  return { ...snapshot, setTheme, setAccent, resetAccent }
}
