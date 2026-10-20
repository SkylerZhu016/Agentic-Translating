import { randomUUID } from 'node:crypto'

export async function readRunningWork({
  url,
  fetchImpl = fetch,
  timeoutMs = 3_000,
}) {
  const response = await fetchImpl(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error('activity_unavailable')
  const payload = await response.json()
  if (typeof payload?.hasRunningWork !== 'boolean') {
    throw new Error('activity_invalid')
  }
  return payload.hasRunningWork
}

// Electron's close event cannot wait for an async listener. Cancel it before
// the first await, then either quit explicitly or keep the window available.
export function createWindowCloseHandler({
  canQuit,
  hasRunningWork,
  chooseAction,
  prepareToQuit = async () => {},
  onPreparationFailed = async () => false,
  quit,
  hide,
  onError = console.error,
}) {
  let pending = false
  return function onClose(event) {
    if (canQuit()) return
    event.preventDefault()
    if (pending) return
    pending = true
    void (async () => {
      try {
        const prepareAndQuit = async () => {
          try {
            await prepareToQuit()
          } catch {
            if (canQuit() || !(await onPreparationFailed())) return
          }
          if (!canQuit()) quit()
        }
        let activity = 'running'
        let running = true
        try {
          running = await hasRunningWork()
        } catch {
          activity = 'unknown'
        }
        if (!running) {
          if (!canQuit()) await prepareAndQuit()
          return
        }
        if (canQuit()) return
        const action = await chooseAction(activity)
        if (canQuit()) return
        if (action === 'hide') hide()
        else if (action === 'quit') await prepareAndQuit()
      } catch (error) {
        onError(error)
      } finally {
        pending = false
      }
    })()
  }
}
export function prepareRendererForClose(webContents, ipcMain, {
  timeoutMs = 8_000,
} = {}) {
  if (webContents.isDestroyed()) {
    return Promise.reject(new Error('renderer_unavailable'))
  }
  const requestId = randomUUID()
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer)
      ipcMain.removeListener('agentic:prepare-close-result', onResult)
      webContents.removeListener('destroyed', onUnavailable)
      webContents.removeListener('render-process-gone', onUnavailable)
      if (error) reject(error)
      else resolve()
    }
    const onResult = (event, result) => {
      if (event.sender !== webContents || result?.requestId !== requestId) return
      finish(result.ok === true ? null : new Error('draft_save_failed'))
    }
    const onUnavailable = () => finish(new Error('renderer_unavailable'))
    const timer = setTimeout(() => finish(new Error('draft_save_timeout')), timeoutMs)
    ipcMain.on('agentic:prepare-close-result', onResult)
    webContents.once('destroyed', onUnavailable)
    webContents.once('render-process-gone', onUnavailable)
    try {
      webContents.send('agentic:prepare-close', { requestId })
    } catch (error) {
      finish(error)
    }
  })
}
