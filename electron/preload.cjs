const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('agenticDesktop', {
  selectFiles: () => ipcRenderer.invoke('agentic:select-files'),
  selectFolder: () => ipcRenderer.invoke('agentic:select-folder'),
  exportBatch: (batchId, includeAudit) =>
    ipcRenderer.invoke('agentic:export-batch', batchId, includeAudit),
  openDataDirectory: () => ipcRenderer.invoke('agentic:open-data-dir'),
  openDiagnosticLogs: () => ipcRenderer.invoke('agentic:open-diagnostic-logs'),
  setLocale: (locale) => ipcRenderer.invoke('agentic:set-locale', locale),
})
