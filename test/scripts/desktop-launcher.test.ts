import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { desktopLaunchSpec } from '../../scripts/launch-desktop.mjs'
import { resolveNextDistDir } from '../../next.config'

describe('desktop source launcher', () => {
  const cwd = path.resolve('D:/workspace')
  const nodeExecutable = path.resolve('C:/node/node.exe')
  const electronExecutable = path.resolve('D:/workspace/node_modules/electron/dist/electron.exe')

  it('starts Electron in source development mode without a build step', () => {
    const spec = desktopLaunchSpec('development', {
      cwd,
      nodeExecutable,
      electronExecutable,
      env: {
        PATH: 'bin',
        OPENAI_API_KEY: 'do-not-forward',
        E2E_TEST: 'true',
        ELECTRON_RUN_AS_NODE: '1',
        AGENTIC_DESKTOP_STARTUP_NONCE: 'stale-start',
      },
    })

    expect(spec.command).toBe(electronExecutable)
    expect(spec.args).toEqual([cwd])
    expect(spec.env.AGENTIC_DESKTOP_RUNTIME).toBe('development')
    expect(spec.env.AGENTIC_SYSTEM_NODE_EXECUTABLE).toBe(nodeExecutable)
    expect(spec.env.AGENTIC_NEXT_DIST_DIR).toBe('.next-electron-dev')
    expect(spec.env.AGENTIC_NEXT_DEV_SERVER).toBe('1')
    expect(spec.env.OPENAI_API_KEY).toBeUndefined()
    expect(spec.env.E2E_TEST).toBeUndefined()
    expect(spec.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(spec.env.AGENTIC_DESKTOP_STARTUP_NONCE).toBeUndefined()
  })

  it('keeps standalone preview explicit and does not invoke a build', () => {
    const spec = desktopLaunchSpec('preview', {
      cwd,
      nodeExecutable,
      electronExecutable,
      env: { PATH: 'bin', AGENTIC_NEXT_DIST_DIR: '.next-web-dev' },
    })

    expect(spec.args).toEqual([cwd])
    expect(spec.env.AGENTIC_DESKTOP_RUNTIME).toBe('preview')
    expect(spec.env.AGENTIC_NEXT_DIST_DIR).toBeUndefined()
    expect(spec.env.AGENTIC_NEXT_DEV_SERVER).toBeUndefined()
    expect(spec.args.join(' ')).not.toContain('build')
  })

  it('gives web development its own Next cache', () => {
    const spec = desktopLaunchSpec('web-dev', {
      cwd,
      nodeExecutable,
      env: { PATH: 'bin' },
    })

    expect(spec.command).toBe(nodeExecutable)
    expect(spec.args).toEqual([
      path.join(cwd, 'node_modules', 'next', 'dist', 'bin', 'next'),
      'dev',
      '--hostname',
      '127.0.0.1',
    ])
    expect(spec.env.AGENTIC_NEXT_DIST_DIR).toBe('.next-web-dev')
    expect(spec.env.AGENTIC_NEXT_DEV_SERVER).toBe('1')
  })

  it('forwards web hostname and port arguments without overriding an explicit host', () => {
    const spec = desktopLaunchSpec('web-dev', {
      cwd,
      nodeExecutable,
      env: { PATH: 'bin' },
      forwardedArgs: ['--hostname', '0.0.0.0', '--port', '4040'],
    })

    expect(spec.args).toEqual([
      path.join(cwd, 'node_modules', 'next', 'dist', 'bin', 'next'),
      'dev',
      '--hostname',
      '0.0.0.0',
      '--port',
      '4040',
    ])
  })

  it('pins production builds to .next and clears test-only Electron state', () => {
    const spec = desktopLaunchSpec('build', {
      cwd,
      nodeExecutable,
      env: {
        PATH: 'bin',
        AGENTIC_NEXT_DIST_DIR: '.next-electron-dev',
        AGENTIC_NEXT_DEV_SERVER: '1',
        E2E_TEST: 'true',
        ELECTRON_RUN_AS_NODE: '1',
        OPENAI_API_KEY: 'do-not-build-with-this',
      },
    })

    expect(spec.args).toEqual([
      path.join(cwd, 'node_modules', 'next', 'dist', 'bin', 'next'),
      'build',
    ])
    expect(spec.env.AGENTIC_NEXT_DIST_DIR).toBeUndefined()
    expect(spec.env.AGENTIC_NEXT_DEV_SERVER).toBeUndefined()
    expect(spec.env.E2E_TEST).toBeUndefined()
    expect(spec.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(spec.env.OPENAI_API_KEY).toBeUndefined()
  })

  it('allows only the three owned Next cache directories', () => {
    expect(resolveNextDistDir(undefined, false)).toBe('.next')
    expect(resolveNextDistDir('.next-web-dev', false)).toBe('.next')
    expect(resolveNextDistDir('.next-web-dev', true)).toBe('.next-web-dev')
    expect(resolveNextDistDir('.next-electron-dev', true)).toBe('.next-electron-dev')
    expect(() => resolveNextDistDir('../shared-output', true)).toThrow(
      'Unsupported AGENTIC_NEXT_DIST_DIR',
    )
  })
})
