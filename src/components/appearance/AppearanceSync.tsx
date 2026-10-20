'use client'

import { useEffect } from 'react'
import { subscribeAppearance } from '@/src/lib/appearance/client'

/** Keep other windows in sync even when the settings panel is not mounted. */
export function AppearanceSync() {
  useEffect(() => subscribeAppearance(() => {}), [])
  return null
}
