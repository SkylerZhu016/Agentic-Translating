export interface LaunchSpec {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string | undefined>
}

export type LaunchMode = 'development' | 'preview' | 'web-dev' | 'build'

export function desktopLaunchSpec(
  mode: LaunchMode,
  options?: {
    cwd?: string
    env?: Record<string, string | undefined>
    nodeExecutable?: string
    electronExecutable?: string
    forwardedArgs?: string[]
  },
): LaunchSpec

export function launch(mode: LaunchMode, forwardedArgs?: string[]): Promise<void>
