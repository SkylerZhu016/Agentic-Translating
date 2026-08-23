import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  DESKTOP_PORT,
  DESKTOP_RUNTIME_ENV,
  NEXT_DIST_DIR_ENV,
  NEXT_DEV_SERVER_ENV,
  sanitizeRuntimeEnvironment,
  STARTUP_NONCE_ENV,
  stopManagedServer,
  SYSTEM_NODE_ENV,
} from '../electron/runtime.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function desktopLaunchSpec(mode, {
  cwd = root,
  env = process.env,
  nodeExecutable = process.execPath,
  electronExecutable,
  forwardedArgs = [],
} = {}) {
  if (mode === 'web-dev') {
    const webEnv = {
      ...env,
      [NEXT_DIST_DIR_ENV]: '.next-web-dev',
      [NEXT_DEV_SERVER_ENV]: '1',
    }
    delete webEnv[DESKTOP_RUNTIME_ENV]
    delete webEnv[SYSTEM_NODE_ENV]
    delete webEnv.ELECTRON_RUN_AS_NODE
    delete webEnv[STARTUP_NONCE_ENV]
    const hasHostname = forwardedArgs.some((value) =>
      value === '--hostname' ||
      value === '-H' ||
      value.startsWith('--hostname='),
    )
    return {
      command: nodeExecutable,
      args: [
        path.join(cwd, 'node_modules', 'next', 'dist', 'bin', 'next'),
        'dev',
        ...(hasHostname ? [] : ['--hostname', '127.0.0.1']),
        ...forwardedArgs,
      ],
      cwd,
      env: webEnv,
    }
  }

  if (mode === 'build') {
    const buildEnv = { ...sanitizeRuntimeEnvironment(env) }
    delete buildEnv[NEXT_DIST_DIR_ENV]
    delete buildEnv[NEXT_DEV_SERVER_ENV]
    delete buildEnv[DESKTOP_RUNTIME_ENV]
    delete buildEnv[SYSTEM_NODE_ENV]
    delete buildEnv.ELECTRON_RUN_AS_NODE
    delete buildEnv.E2E_TEST
    delete buildEnv[STARTUP_NONCE_ENV]
    return {
      command: nodeExecutable,
      args: [
        path.join(cwd, 'node_modules', 'next', 'dist', 'bin', 'next'),
        'build',
        ...forwardedArgs,
      ],
      cwd,
      env: buildEnv,
    }
  }

  if (mode !== 'development' && mode !== 'preview') {
    throw new Error(`Unknown desktop launch mode: ${mode}`)
  }
  if (!electronExecutable) {
    throw new Error('Electron executable is required for desktop launch.')
  }

  const desktopEnv = {
    ...sanitizeRuntimeEnvironment(env),
    [DESKTOP_RUNTIME_ENV]: mode,
    [SYSTEM_NODE_ENV]: nodeExecutable,
  }
  delete desktopEnv.ELECTRON_RUN_AS_NODE
  delete desktopEnv.E2E_TEST
  delete desktopEnv[STARTUP_NONCE_ENV]
  if (mode === 'development') {
    desktopEnv[NEXT_DIST_DIR_ENV] = '.next-electron-dev'
    desktopEnv[NEXT_DEV_SERVER_ENV] = '1'
  } else {
    delete desktopEnv[NEXT_DIST_DIR_ENV]
    delete desktopEnv[NEXT_DEV_SERVER_ENV]
  }

  return {
    command: electronExecutable,
    args: [cwd],
    cwd,
    env: desktopEnv,
  }
}

function signalExitCode(signal) {
  return signal === 'SIGINT' ? 130 : 143
}

function managedPortFor(mode, forwardedArgs) {
  if (mode === 'development' || mode === 'preview') return DESKTOP_PORT
  if (mode !== 'web-dev') return undefined
  for (let index = 0; index < forwardedArgs.length; index += 1) {
    const value = forwardedArgs[index]
    if (value === '--port' || value === '-p') {
      const parsed = Number(forwardedArgs[index + 1])
      return Number.isInteger(parsed) ? parsed : 3000
    }
    if (value.startsWith('--port=')) {
      const parsed = Number(value.slice('--port='.length))
      return Number.isInteger(parsed) ? parsed : 3000
    }
  }
  return 3000
}

export async function launch(mode, forwardedArgs = []) {
  const require = createRequire(import.meta.url)
  const electronExecutable =
    mode === 'development' || mode === 'preview'
      ? require('electron')
      : undefined
  const spec = desktopLaunchSpec(mode, { electronExecutable, forwardedArgs })
  const managedPort = managedPortFor(mode, forwardedArgs)
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: 'inherit',
    windowsHide: false,
    shell: false,
  })
  process.exitCode = await new Promise((resolve) => {
    let settled = false
    let stopping = false
    const finish = (code) => {
      if (settled) return
      settled = true
      process.removeListener('SIGINT', onSigint)
      process.removeListener('SIGTERM', onSigterm)
      resolve(code)
    }
    const stopForSignal = async (signal) => {
      if (stopping || settled) return
      stopping = true
      try {
        await stopManagedServer(child, { port: managedPort })
        finish(signalExitCode(signal))
      } catch (error) {
        console.error(
          `Failed to clean up the launched process tree: ${error instanceof Error ? error.message : String(error)}`,
        )
        finish(1)
      }
    }
    const onSigint = () => void stopForSignal('SIGINT')
    const onSigterm = () => void stopForSignal('SIGTERM')
    process.once('SIGINT', onSigint)
    process.once('SIGTERM', onSigterm)
    child.once('error', (error) => {
      console.error(error instanceof Error ? error.message : String(error))
      finish(1)
    })
    child.once('exit', (code) => {
      if (!stopping) finish(code ?? 1)
    })
  })
}

const isMain = process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url

if (isMain) {
  const flag = process.argv[2]
  const mode = flag === '--web-dev'
    ? 'web-dev'
    : flag === '--preview'
      ? 'preview'
      : flag === '--build'
        ? 'build'
        : 'development'
  const forwardedArgs = flag?.startsWith('--')
    ? process.argv.slice(3)
    : process.argv.slice(2)
  await launch(mode, forwardedArgs)
}
