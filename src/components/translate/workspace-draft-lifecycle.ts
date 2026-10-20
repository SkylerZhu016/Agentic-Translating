'use client'

import type { BuiltinDirection, WorkspaceDraft } from '@/src/lib/contracts/vnext'

export interface WorkspaceDraftRecovery {
  draft: WorkspaceDraft
  recoverableDraft: WorkspaceDraft | null
  presetLookupError: string | null
}

interface WorkspaceDraftGuard {
  hasUnsavedChanges: () => boolean
  flush: () => Promise<void>
  recovery?: () => WorkspaceDraftRecovery
}

let currentGuard: WorkspaceDraftGuard | null = null
let preparation: Promise<boolean> | null = null
const detachedGuards = new Set<WorkspaceDraftGuard>()
let detachedPreparation: Promise<void> | null = null
const failureListeners = new Set<(message: string) => void>()

export function onWorkspaceDraftFailure(listener: (message: string) => void) {
  failureListeners.add(listener)
  return () => { failureListeners.delete(listener) }
}

export function detachedWorkspaceDraftDirection(): BuiltinDirection | null {
  for (const guard of detachedGuards) {
    const snapshot = guard.recovery?.()
    if (snapshot) return snapshot.draft.direction
  }
  return null
}

/** A failed interactive draft can be handed back to a mounted workbench.
 * Keep its old guard until the new owner has actually hydrated the fields. */
export async function recoverDetachedWorkspaceDraft(direction: BuiltinDirection) {
  await waitForDetachedWorkspaceDrafts().catch(() => undefined)
  const owners = [...detachedGuards].filter(
    (guard) => guard.recovery?.().draft.direction === direction,
  )
  const snapshot = owners.at(-1)?.recovery?.()
  if (!snapshot) return null
  return {
    ...snapshot,
    release: () => {
      for (const guard of owners) detachedGuards.delete(guard)
    },
  }
}

/** SPA history traversal cannot be cancelled. Finish its draft before a new
 * workbench reads that direction, and keep failed drafts available for retry. */
export function waitForDetachedWorkspaceDrafts(): Promise<void> {
  if (detachedPreparation) return detachedPreparation
  if (detachedGuards.size === 0) return Promise.resolve()
  const request = (async () => {
    for (const guard of detachedGuards) {
      await guard.flush()
      if (guard.hasUnsavedChanges()) throw new Error('workspace_draft_save_pending')
      detachedGuards.delete(guard)
    }
  })()
  detachedPreparation = request
  const clear = () => {
    if (detachedPreparation === request) detachedPreparation = null
  }
  void request.then(clear, clear)
  return request
}

/** One workbench owns the draft. Other pages can use the same exit contract. */
export function registerWorkspaceDraftGuard(guard: WorkspaceDraftGuard) {
  currentGuard = guard
  return () => {
    if (currentGuard === guard) currentGuard = null
    if (!guard.hasUnsavedChanges()) return
    detachedGuards.add(guard)
    void waitForDetachedWorkspaceDrafts().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'workspace_draft_save_failed'
      for (const listener of failureListeners) listener(message)
    })
  }
}

export function hasPendingWorkspaceDraft() {
  return detachedGuards.size > 0 || (currentGuard?.hasUnsavedChanges() ?? false)
}

/** False keeps navigation/the desktop window open; the owner shows its error. */
export function prepareWorkspaceNavigation(): Promise<boolean> {
  if (preparation) return preparation
  const request = (async () => {
    try {
      await waitForDetachedWorkspaceDrafts()
      const guard = currentGuard
      if (!guard || !guard.hasUnsavedChanges()) return true
      await guard.flush()
      return !guard.hasUnsavedChanges()
    } catch {
      return false
    }
  })()
  preparation = request
  void request.then(() => {
    if (preparation === request) preparation = null
  })
  return request
}
