export function readRunningWork(options: {
  url: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<boolean>

export function createWindowCloseHandler(options: {
  canQuit: () => boolean
  hasRunningWork: () => Promise<boolean>
  chooseAction: (activity: 'running' | 'unknown') => Promise<'hide' | 'cancel' | 'quit'>
  prepareToQuit?: () => Promise<void>
  onPreparationFailed?: () => Promise<boolean>
  quit: () => void
  hide: () => void
  onError?: (error: unknown) => void
}): (event: { preventDefault(): void }) => void
import type { IpcMain, WebContents } from 'electron'

export function prepareRendererForClose(
  webContents: WebContents,
  ipcMain: IpcMain,
  options?: { timeoutMs?: number },
): Promise<void>
