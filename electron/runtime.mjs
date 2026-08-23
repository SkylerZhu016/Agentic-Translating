import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import path from 'node:path'

export const DESKTOP_PORT = 3210
export const DESKTOP_RUNTIME_ENV = 'AGENTIC_DESKTOP_RUNTIME'
export const SYSTEM_NODE_ENV = 'AGENTIC_SYSTEM_NODE_EXECUTABLE'
export const NEXT_DIST_DIR_ENV = 'AGENTIC_NEXT_DIST_DIR'
export const NEXT_DEV_SERVER_ENV = 'AGENTIC_NEXT_DEV_SERVER'
export const STARTUP_NONCE_ENV = 'AGENTIC_DESKTOP_STARTUP_NONCE'

const DEV_DIST_DIR = '.next-electron-dev'
const CREDENTIAL_ENV_PATTERN = /(?:^|_)(?:API_?KEY|KEY|TOKEN|AUTHORIZATION|PASSWORD|SECRET(?:_KEY)?)$/i

export class DesktopRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'DesktopRuntimeError'
    this.code = code
    this.details = details
  }
}

export function resolveDesktopRuntime({
  isPackaged,
  cwd,
  resourcesPath,
  electronExecutable,
  env = process.env,
}) {
  if (isPackaged) {
    const root = path.join(resourcesPath, 'app')
    return {
      kind: 'packaged',
      root,
      command: electronExecutable,
      args: [path.join(root, 'server.js')],
      migrationsDir: path.join(root, 'migrations'),
      nodeEnv: 'production',
      distDir: null,
      electronRunAsNode: true,
    }
  }

  const systemNode = env[SYSTEM_NODE_ENV]
  if (!systemNode || !path.isAbsolute(systemNode)) {
    throw new DesktopRuntimeError(
      'system_node_missing',
      'The source desktop must be launched with the repository launcher.',
    )
  }

  if (env[DESKTOP_RUNTIME_ENV] === 'preview') {
    const root = path.join(cwd, '.next', 'standalone')
    return {
      kind: 'preview',
      root,
      command: systemNode,
      args: [path.join(root, 'server.js')],
      migrationsDir: path.join(root, 'migrations'),
      nodeEnv: 'production',
      distDir: null,
      electronRunAsNode: false,
    }
  }

  return {
    kind: 'development',
    root: cwd,
    command: systemNode,
    args: [
      path.join(cwd, 'node_modules', 'next', 'dist', 'bin', 'next'),
      'dev',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(DESKTOP_PORT),
    ],
    migrationsDir: path.join(cwd, 'src', 'lib', 'db', 'migrations'),
    nodeEnv: 'development',
    distDir: DEV_DIST_DIR,
    electronRunAsNode: false,
  }
}

export function serverEntryFor(runtime) {
  return runtime.args[0]
}

export function sanitizeRuntimeEnvironment(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !CREDENTIAL_ENV_PATTERN.test(name)),
  )
}

export function createServerEnvironment(runtime, {
  baseEnv = process.env,
  port = DESKTOP_PORT,
  userData,
  secret,
  startupNonce,
  packagedNodePath,
}) {
  const env = {
    ...sanitizeRuntimeEnvironment(baseEnv),
    HOSTNAME: '127.0.0.1',
    PORT: String(port),
    NODE_ENV: runtime.nodeEnv,
    AGENTIC_DESKTOP: '1',
    AGENTIC_DATA_DIR: userData,
    AGENTIC_MIGRATIONS_DIR: runtime.migrationsDir,
    AGENTIC_SECRET_KEY: secret,
    [STARTUP_NONCE_ENV]: startupNonce,
  }
  delete env[SYSTEM_NODE_ENV]
  delete env[DESKTOP_RUNTIME_ENV]
  delete env.E2E_TEST

  if (runtime.distDir) {
    env[NEXT_DIST_DIR_ENV] = runtime.distDir
    env[NEXT_DEV_SERVER_ENV] = '1'
  } else {
    delete env[NEXT_DIST_DIR_ENV]
    delete env[NEXT_DEV_SERVER_ENV]
  }

  if (runtime.electronRunAsNode) env.ELECTRON_RUN_AS_NODE = '1'
  else delete env.ELECTRON_RUN_AS_NODE

  if (packagedNodePath) env.NODE_PATH = packagedNodePath
  return env
}

export function isReadyHealthPayload(response, payload, expectedNonce) {
  return Boolean(
    response?.ok &&
      payload &&
      typeof payload === 'object' &&
      payload.ready === true &&
      typeof expectedNonce === 'string' &&
      expectedNonce.length > 0 &&
      payload.startupNonce === expectedNonce,
  )
}

export async function assertPortAvailable(port, host = '127.0.0.1') {
  await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.unref()
    probe.once('error', (error) => {
      reject(
        new DesktopRuntimeError(
          'port_unavailable',
          `Local port ${port} is already in use.`,
          { port, cause: error },
        ),
      )
    })
    probe.listen({ host, port, exclusive: true }, () => {
      probe.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  })
}

function childFailure(child, logFile) {
  let onError
  let onExit
  const promise = new Promise((_, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      reject(
        new DesktopRuntimeError(
          'server_exited',
          `The local service exited before it became ready (code ${child.exitCode ?? 'unknown'}, signal ${child.signalCode ?? 'none'}). See ${logFile}`,
          {
            code: child.exitCode,
            signal: child.signalCode,
            logFile,
          },
        ),
      )
      return
    }
    onError = (error) => {
      reject(
        new DesktopRuntimeError(
          'server_spawn_failed',
          `The local service could not start. See ${logFile}`,
          { logFile, cause: error },
        ),
      )
    }
    onExit = (code, signal) => {
      reject(
        new DesktopRuntimeError(
          'server_exited',
          `The local service exited before it became ready (code ${code ?? 'unknown'}, signal ${signal ?? 'none'}). See ${logFile}`,
          { code, signal, logFile },
        ),
      )
    }
    child.once('error', onError)
    child.once('exit', onExit)
  })
  return {
    promise,
    cleanup() {
      if (onError) child.off('error', onError)
      if (onExit) child.off('exit', onExit)
    },
  }
}

async function pollReady(url, {
  expectedNonce,
  fetchImpl,
  timeoutMs,
  intervalMs,
}) {
  const deadline = Date.now() + timeoutMs
  let lastFailure = 'not_ready'
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(url, {
        cache: 'no-store',
        signal: AbortSignal.timeout(Math.min(1_500, timeoutMs)),
      })
      const payload = await response.json().catch(() => null)
      if (isReadyHealthPayload(response, payload, expectedNonce)) return payload
      lastFailure = `health_${response.status}: ${JSON.stringify(payload)}`
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new DesktopRuntimeError(
    'health_timeout',
    `The local service did not become ready: ${lastFailure}`,
    { lastFailure },
  )
}

export async function waitForManagedServer(child, {
  url,
  logFile,
  expectedNonce,
  fetchImpl = fetch,
  timeoutMs = 120_000,
  intervalMs = 250,
}) {
  const failure = childFailure(child, logFile)
  try {
    return await Promise.race([
      pollReady(url, { expectedNonce, fetchImpl, timeoutMs, intervalMs }),
      failure.promise,
    ])
  } catch (error) {
    if (error instanceof DesktopRuntimeError && !error.details.logFile) {
      throw new DesktopRuntimeError(
        error.code,
        `${error.message} See ${logFile}`,
        { ...error.details, logFile },
      )
    }
    throw error
  } finally {
    failure.cleanup()
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise((resolve) => {
    const finish = (value) => {
      clearTimeout(timer)
      child.off('exit', onExit)
      child.off('error', onError)
      resolve(value)
    }
    const onExit = () => finish(true)
    const onError = () => finish(false)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

export async function stopManagedServer(child, {
  platform = process.platform,
  spawnImpl = spawn,
  port,
  host = '127.0.0.1',
  portAvailableImpl = assertPortAvailable,
  helperTimeoutMs = 3_000,
  killTimeoutMs = 1_000,
} = {}) {
  if (!child) return

  const confirmPortReleased = async (context) => {
    if (!Number.isInteger(port) || port <= 0) {
      if (context.taskkillSucceeded) return
      throw new DesktopRuntimeError(
        'server_stop_unconfirmed',
        `Managed process ${child.pid ?? 'unknown'} exited, but descendant cleanup could not be confirmed.`,
        context,
      )
    }
    try {
      await portAvailableImpl(port, host)
    } catch (error) {
      throw new DesktopRuntimeError(
        'server_stop_failed',
        `Managed process cleanup did not release ${host}:${port}.`,
        { ...context, port, host, cause: error },
      )
    }
  }

  if (child.exitCode !== null || child.signalCode !== null) {
    await confirmPortReleased({
      pid: child.pid,
      parentAlreadyExited: true,
      taskkillSucceeded: false,
    })
    return
  }
  if (!Number.isInteger(child.pid)) {
    child.kill()
    await confirmPortReleased({
      pid: null,
      processNeverStarted: true,
      taskkillSucceeded: false,
    })
    return
  }

  if (platform === 'win32') {
    let killer = null
    let killerError = null
    let killerCompleted = false
    try {
      killer = spawnImpl('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      killer.once('error', (error) => {
        killerError = error
      })
      killerCompleted = await waitForExit(killer, helperTimeoutMs)
    } catch (error) {
      killerError = error
    }
    if (
      !killerCompleted &&
      killer &&
      Number.isInteger(killer.pid) &&
      killer.exitCode === null &&
      killer.signalCode === null
    ) {
      killer.kill()
      killerCompleted = await waitForExit(killer, killTimeoutMs)
      if (!killerCompleted) {
        killer.kill('SIGKILL')
        killerCompleted = await waitForExit(killer, killTimeoutMs)
      }
      if (!killerCompleted) {
        throw new DesktopRuntimeError(
          'taskkill_helper_stop_failed',
          `Timed-out taskkill helper ${killer.pid} could not be stopped; refusing to continue with parent cleanup.`,
          { helperPid: killer.pid, targetPid: child.pid },
        )
      }
    }
    const taskkillExitCode = killer?.exitCode ?? null
    const taskkillSucceeded = Boolean(
      killerCompleted &&
      taskkillExitCode === 0,
    )
    let childStopped =
      child.exitCode !== null || child.signalCode !== null
    if (taskkillSucceeded && !childStopped) {
      childStopped = await waitForExit(child, 3_000)
    }
    if (!childStopped) {
      child.kill('SIGKILL')
      childStopped = await waitForExit(child, 3_000)
    }
    if (childStopped) {
      await confirmPortReleased({
        pid: child.pid,
        taskkillExitCode,
        taskkillError: killerError,
        taskkillSucceeded,
      })
      return
    }
    throw new DesktopRuntimeError(
      'server_stop_failed',
      `Failed to stop managed process tree ${child.pid}; taskkill exit ${taskkillExitCode ?? 'unknown'}${killerError ? ` (${killerError.message})` : ''}.`,
      {
        pid: child.pid,
        taskkillExitCode,
        taskkillError: killerError,
      },
    )
  }

  child.kill()
  if (await waitForExit(child, 2_000)) {
    await confirmPortReleased({ pid: child.pid, taskkillSucceeded: true })
    return
  }
  child.kill('SIGKILL')
  if (await waitForExit(child, 3_000)) {
    await confirmPortReleased({ pid: child.pid, taskkillSucceeded: true })
    return
  }
  throw new DesktopRuntimeError(
    'server_stop_failed',
    `Failed to stop managed process ${child.pid}.`,
    { pid: child.pid },
  )
}
