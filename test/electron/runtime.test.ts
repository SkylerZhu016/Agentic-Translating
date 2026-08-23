import { EventEmitter } from 'node:events'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createServerEnvironment,
  DESKTOP_RUNTIME_ENV,
  resolveDesktopRuntime,
  sanitizeRuntimeEnvironment,
  SYSTEM_NODE_ENV,
  STARTUP_NONCE_ENV,
  stopManagedServer,
  waitForManagedServer,
} from '../../electron/runtime.mjs'

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  pid = 1234
  kill = vi.fn(() => true)
}

describe('Electron runtime selection', () => {
  it('uses source Next dev and an isolated cache without reading standalone', () => {
    const cwd = path.resolve('D:/workspace')
    const runtime = resolveDesktopRuntime({
      isPackaged: false,
      cwd,
      resourcesPath: path.resolve('D:/resources'),
      electronExecutable: path.resolve('D:/Electron.exe'),
      env: { [SYSTEM_NODE_ENV]: path.resolve('C:/node/node.exe') },
    })

    expect(runtime.kind).toBe('development')
    expect(runtime.root).toBe(cwd)
    expect(runtime.args).toEqual([
      path.join(cwd, 'node_modules', 'next', 'dist', 'bin', 'next'),
      'dev',
      '--hostname',
      '127.0.0.1',
      '--port',
      '3210',
    ])
    expect(runtime.distDir).toBe('.next-electron-dev')
    expect(runtime.migrationsDir).toBe(
      path.join(cwd, 'src', 'lib', 'db', 'migrations'),
    )
  })

  it('selects standalone only for explicit preview or a packaged app', () => {
    const cwd = path.resolve('D:/workspace')
    const systemNode = path.resolve('C:/node/node.exe')
    const preview = resolveDesktopRuntime({
      isPackaged: false,
      cwd,
      resourcesPath: path.resolve('D:/resources'),
      electronExecutable: path.resolve('D:/Electron.exe'),
      env: {
        [SYSTEM_NODE_ENV]: systemNode,
        [DESKTOP_RUNTIME_ENV]: 'preview',
      },
    })
    const packaged = resolveDesktopRuntime({
      isPackaged: true,
      cwd,
      resourcesPath: path.resolve('D:/resources'),
      electronExecutable: path.resolve('D:/Electron.exe'),
      env: {},
    })

    expect(preview.kind).toBe('preview')
    expect(preview.args[0]).toBe(path.join(cwd, '.next', 'standalone', 'server.js'))
    expect(packaged.kind).toBe('packaged')
    expect(packaged.args[0]).toBe(path.resolve('D:/resources', 'app', 'server.js'))
    expect(packaged.electronRunAsNode).toBe(true)
  })

  it('does not forward provider credentials and injects only the desktop secret', () => {
    expect(sanitizeRuntimeEnvironment({
      PATH: 'bin',
      OPENAI_API_KEY: 'provider-secret',
      NEWAPI_KEY: 'provider-secret-2',
      NEWAPI_TOKEN: 'provider-token',
    })).toEqual({ PATH: 'bin' })

    const runtime = resolveDesktopRuntime({
      isPackaged: false,
      cwd: path.resolve('D:/workspace'),
      resourcesPath: path.resolve('D:/resources'),
      electronExecutable: path.resolve('D:/Electron.exe'),
      env: { [SYSTEM_NODE_ENV]: path.resolve('C:/node/node.exe') },
    })
    const env = createServerEnvironment(runtime, {
      baseEnv: {
        PATH: 'bin',
        OPENAI_API_KEY: 'provider-secret',
        E2E_TEST: 'true',
        [SYSTEM_NODE_ENV]: path.resolve('C:/node/node.exe'),
      },
      userData: path.resolve('D:/data'),
      secret: 'safe-storage-secret',
      startupNonce: 'nonce-123',
    })

    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env[SYSTEM_NODE_ENV]).toBeUndefined()
    expect(env.AGENTIC_SECRET_KEY).toBe('safe-storage-secret')
    expect(env[STARTUP_NONCE_ENV]).toBe('nonce-123')
    expect(env.E2E_TEST).toBeUndefined()
    expect(env.AGENTIC_MIGRATIONS_DIR).toContain(
      path.join('src', 'lib', 'db', 'migrations'),
    )
  })
})

describe('Electron readiness gate', () => {
  it('requires an HTTP success payload with ready exactly true', async () => {
    const child = new FakeChild()
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ready: true, startupNonce: 'stale-server' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ready: true,
          migrationVersion: 16,
          startupNonce: 'current-start',
        }),
      })

    await expect(waitForManagedServer(child as never, {
      url: 'http://127.0.0.1:3210/api/health/ready',
      logFile: 'desktop-server.log',
      expectedNonce: 'current-start',
      fetchImpl: fetchImpl as never,
      timeoutMs: 1_000,
      intervalMs: 0,
    })).resolves.toMatchObject({
      ready: true,
      migrationVersion: 16,
      startupNonce: 'current-start',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('fails immediately when the child exits before readiness', async () => {
    const child = new FakeChild()
    const pendingFetch = vi.fn(() => new Promise(() => {}))
    const readiness = waitForManagedServer(child as never, {
      url: 'http://127.0.0.1:3210/api/health/ready',
      logFile: 'D:/data/logs/desktop-server.log',
      expectedNonce: 'current-start',
      fetchImpl: pendingFetch as never,
      timeoutMs: 10_000,
      intervalMs: 250,
    })
    queueMicrotask(() => {
      child.exitCode = 1
      child.emit('exit', 1, null)
    })

    await expect(readiness).rejects.toMatchObject({
      code: 'server_exited',
      details: { logFile: 'D:/data/logs/desktop-server.log' },
    })
  })

  it('waits for the managed child to exit during cleanup', async () => {
    const child = new FakeChild()
    child.kill.mockImplementation(() => {
      queueMicrotask(() => {
        child.exitCode = 0
        child.emit('exit', 0, null)
      })
      return true
    })

    await stopManagedServer(child as never, { platform: 'linux' })
    expect(child.kill).toHaveBeenCalledOnce()
    expect(child.exitCode).toBe(0)
  })

  it('uses taskkill for the complete Windows process tree and confirms exit', async () => {
    const child = new FakeChild()
    const killer = new FakeChild()
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => {
        killer.exitCode = 0
        killer.emit('exit', 0, null)
        child.exitCode = 0
        child.emit('exit', 0, null)
      })
      return killer
    })

    await stopManagedServer(child as never, {
      platform: 'win32',
      spawnImpl: spawnImpl as never,
    })
    expect(spawnImpl).toHaveBeenCalledWith(
      'taskkill.exe',
      ['/pid', '1234', '/t', '/f'],
      expect.objectContaining({ windowsHide: true }),
    )
    expect(child.exitCode).toBe(0)
  })

  it('falls back to a direct kill when taskkill cannot be spawned', async () => {
    const child = new FakeChild()
    child.kill.mockImplementation(() => {
      queueMicrotask(() => {
        child.exitCode = 0
        child.emit('exit', 0, null)
      })
      return true
    })
    const killer = new FakeChild()
    killer.pid = undefined as never
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => killer.emit('error', new Error('spawn ENOENT')))
      return killer
    })
    const portAvailableImpl = vi.fn(async () => undefined)

    await stopManagedServer(child as never, {
      platform: 'win32',
      spawnImpl: spawnImpl as never,
      port: 3210,
      portAvailableImpl,
    })

    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(portAvailableImpl).toHaveBeenCalledWith(3210, '127.0.0.1')
  })

  it('rejects a nonzero taskkill when the parent dies but a descendant keeps the port', async () => {
    const child = new FakeChild()
    const killer = new FakeChild()
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => {
        killer.exitCode = 1
        killer.emit('exit', 1, null)
        child.exitCode = 0
        child.emit('exit', 0, null)
      })
      return killer
    })
    const portAvailableImpl = vi.fn(async () => {
      throw new Error('EADDRINUSE')
    })

    await expect(stopManagedServer(child as never, {
      platform: 'win32',
      spawnImpl: spawnImpl as never,
      port: 3210,
      portAvailableImpl,
    })).rejects.toMatchObject({
      code: 'server_stop_failed',
      details: { port: 3210 },
    })
  })

  it('fails closed when a timed-out taskkill helper cannot itself be stopped', async () => {
    const child = new FakeChild()
    const killer = new FakeChild()
    killer.pid = 5678
    const spawnImpl = vi.fn(() => killer)

    await expect(stopManagedServer(child as never, {
      platform: 'win32',
      spawnImpl: spawnImpl as never,
      port: 3210,
      helperTimeoutMs: 1,
      killTimeoutMs: 1,
    })).rejects.toMatchObject({
      code: 'taskkill_helper_stop_failed',
      details: { helperPid: 5678, targetPid: 1234 },
    })

    expect(killer.kill).toHaveBeenNthCalledWith(1)
    expect(killer.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
    expect(child.kill).not.toHaveBeenCalled()
  })
})
