const { contextBridge, ipcRenderer } = require('electron')

const closeHandlers = new Set()
ipcRenderer.on('agentic:prepare-close', async (_event, { requestId }) => {
  let ok = false
  try {
    const results = await Promise.all(
      Array.from(closeHandlers, (handler) => Promise.resolve().then(handler)),
    )
    ok = results.every((result) => result === true)
  } catch {
    // Only an acknowledgement crosses IPC; draft contents and save errors stay
    // in the renderer. A failed flush keeps the native close guard in control.
  }
  ipcRenderer.send('agentic:prepare-close-result', { requestId, ok })
})

contextBridge.exposeInMainWorld('agenticDesktop', {
  onPrepareClose: (handler) => {
    if (typeof handler !== 'function') throw new TypeError('A close handler is required.')
    closeHandlers.add(handler)
    return () => closeHandlers.delete(handler)
  },
  selectFiles: () => ipcRenderer.invoke('agentic:select-files'),
  selectFolder: () => ipcRenderer.invoke('agentic:select-folder'),
  exportBatch: (batchId, includeAudit) =>
    ipcRenderer.invoke('agentic:export-batch', batchId, includeAudit),
  openDataDirectory: () => ipcRenderer.invoke('agentic:open-data-dir'),
  openDiagnosticLogs: () => ipcRenderer.invoke('agentic:open-diagnostic-logs'),
  setLocale: (locale) => ipcRenderer.invoke('agentic:set-locale', locale),
})
