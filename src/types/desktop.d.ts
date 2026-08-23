import type { BatchInputFile } from '@/src/lib/batch/runner'

export {}

declare global {
  interface Window {
    agenticDesktop?: {
      selectFiles: () => Promise<{
        canceled: boolean
        files: BatchInputFile[]
        error?: string
      }>
      selectFolder: () => Promise<{
        canceled: boolean
        files: BatchInputFile[]
        error?: string
      }>
      exportBatch: (
        batchId: string,
        includeAudit: boolean,
      ) => Promise<{
        canceled: boolean
        outputDirectory?: string
      }>
      openDataDirectory: () => Promise<string>
      openDiagnosticLogs: () => Promise<string>
      setLocale: (locale: 'zh-CN' | 'en') => Promise<'zh-CN' | 'en'>
    }
  }
}
