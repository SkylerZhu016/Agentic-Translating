import type { ChildProcess } from 'node:child_process'

export const DESKTOP_PORT: number
export const DESKTOP_RUNTIME_ENV: string
export const SYSTEM_NODE_ENV: string
export const NEXT_DIST_DIR_ENV: string
export const NEXT_DEV_SERVER_ENV: string
export const STARTUP_NONCE_ENV: string

export type RuntimeEnvironment = Record<string, string | undefined>

export type DesktopRuntimeKind = 'packaged' | 'preview' | 'development'

export interface DesktopRuntime {
  kind: DesktopRuntimeKind
  root: string
  command: string
  args: string[]
  migrationsDir: string
  nodeEnv: 'production' | 'development'
  distDir: string | null
  electronRunAsNode: boolean
}

export class DesktopRuntimeError extends Error {
  constructor(code: string, message: string, details?: Record<string, unknown>)
  code: string
  details: Record<string, unknown>
}

export function resolveDesktopRuntime(options: {
  isPackaged: boolean
  cwd: string
  resourcesPath: string
  electronExecutable: string
  env?: RuntimeEnvironment
}): DesktopRuntime

export function serverEntryFor(runtime: DesktopRuntime): string
export function sanitizeRuntimeEnvironment(env?: RuntimeEnvironment): RuntimeEnvironment

export function createServerEnvironment(
  runtime: DesktopRuntime,
  options: {
    baseEnv?: RuntimeEnvironment
    port?: number
    userData: string
    secret: string
    startupNonce: string
    packagedNodePath?: string
  },
): RuntimeEnvironment

export function isReadyHealthPayload(
  response: { ok?: boolean } | null | undefined,
  payload: unknown,
  expectedNonce: string,
): boolean

export function assertPortAvailable(port: number, host?: string): Promise<void>

export function waitForManagedServer(
  child: ChildProcess,
  options: {
    url: string
    logFile: string
    expectedNonce: string
    fetchImpl?: typeof fetch
    timeoutMs?: number
    intervalMs?: number
  },
): Promise<Record<string, unknown>>

export function stopManagedServer(
  child: ChildProcess | null,
  options?: {
    platform?: NodeJS.Platform
    spawnImpl?: typeof import('node:child_process').spawn
    port?: number
    host?: string
    portAvailableImpl?: typeof assertPortAvailable
    helperTimeoutMs?: number
    killTimeoutMs?: number
  },
): Promise<void>
