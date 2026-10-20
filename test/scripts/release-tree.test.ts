import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import nextConfig from '../../next.config'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)
const prepareScript = path.join(repoRoot, 'scripts', 'prepare-standalone.mjs')
const verifyScript = path.join(repoRoot, 'scripts', 'verify-release-tree.mjs')
const temporaryRoots: string[] = []
const localReleaseFixtures = [
  '.tmp/draft.txt',
  '.acceptance/private.txt',
  '.acceptance-data/runs/stage.txt',
  '.acceptance-next-round/result.txt',
  'codex-thread-backups/thread.md',
  '论文/thesis.docx',
  '.env',
  '.env.local',
  '更换key.txt',
]
const require = createRequire(import.meta.url)
const picomatch = require('picomatch') as (
  pattern: string,
) => (value: string) => boolean

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'agentic-release-tree-'))
  temporaryRoots.push(root)
  return root
}

function write(root: string, relative: string, content = 'fixture'): void {
  const target = path.join(root, relative)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
}

function isUnavailableLinkError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false
  return ['EACCES', 'EPERM', 'ENOSYS'].includes(String(error.code))
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('standalone release-tree boundary', () => {
  it('applies local-data exclusions to application routes but not next-server', () => {
    const excludes = nextConfig.outputFileTracingExcludes ?? {}
    const matchesApplicationRoute = picomatch('/**')

    expect(excludes['/**']).toEqual(expect.arrayContaining([
      './.omo/**/*',
      './data/**/*',
      './迭代文档/**/*',
      './FSBP_Test/**/*',
    ]))
    expect(matchesApplicationRoute('/')).toBe(true)
    expect(matchesApplicationRoute('/api/health/ready')).toBe(true)
    expect(matchesApplicationRoute('/config')).toBe(true)
    expect(matchesApplicationRoute('next-server')).toBe(false)
    expect(excludes['*']).toBeUndefined()
    expect(excludes['/*']).toBeUndefined()
  })

  it('scrubs traced runtime data while preserving required release assets', () => {
    const root = temporaryRoot()
    write(root, '.next/standalone/package.json', '{}')
    write(root, '.next/standalone/.omo/cache/private.txt')
    write(root, '.next/standalone/data/app.db')
    write(root, '.next/standalone/FSBP_Test/private/round/private.txt')
    for (const fixture of localReleaseFixtures) {
      write(root, fixture, 'source fixture must remain')
      write(root, `.next/standalone/${fixture}`, 'traced local fixture')
    }
    write(root, '.next/standalone/runtime-assets/dictionary.bin')
    write(root, '.next/standalone/node_modules/example-package/test/runtime-fixture.json', '{}')
    write(root, '.next/static/chunks/app.js')
    write(root, 'public/icon.svg', '<svg/>')
    write(root, '.next/standalone/public/stale.txt')
    write(root, 'src/lib/db/migrations/0001_fixture.sql', 'SELECT 1;')

    const result = spawnSync(process.execPath, [prepareScript], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    })

    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(path.join(root, '.next', 'standalone', '.omo'))).toBe(false)
    expect(existsSync(path.join(root, '.next', 'standalone', 'data'))).toBe(false)
    expect(existsSync(
      path.join(root, '.next', 'standalone', 'FSBP_Test'),
    )).toBe(false)
    for (const fixture of localReleaseFixtures) {
      expect(existsSync(path.join(root, '.next', 'standalone', fixture))).toBe(false)
      expect(readFileSync(path.join(root, fixture), 'utf8')).toBe('source fixture must remain')
    }
    expect(existsSync(path.join(root, '.next/standalone/runtime-assets/dictionary.bin'))).toBe(true)
    expect(readFileSync(path.join(root, '.next/standalone/public/icon.svg'), 'utf8')).toBe('<svg/>')
    expect(existsSync(path.join(root, '.next/standalone/public/stale.txt'))).toBe(false)
    expect(existsSync(path.join(
      root, '.next/standalone/node_modules/example-package/test/runtime-fixture.json',
    ))).toBe(true)
    expect(existsSync(path.join(
      root,
      '.next',
      'standalone',
      '.next',
      'static',
      'chunks',
      'app.js',
    ))).toBe(true)
    expect(existsSync(path.join(
      root,
      '.next',
      'standalone',
      'migrations',
      '0001_fixture.sql',
    ))).toBe(true)
    const verification = spawnSync(process.execPath, [verifyScript], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    })
    expect(verification.status, verification.stderr).toBe(0)
  })

  it.each([
    '.omo',
    'data',
    '.tmp',
    '.acceptance',
    '.acceptance-data',
    '.acceptance-next-round',
    'codex-thread-backups',
    '论文',
    '.env',
    '.env.local',
    '更换key.txt',
    'FSBP_Test',
  ])(
    'rejects a release tree containing %s',
    (entry) => {
      const root = temporaryRoot()
      const releaseRoot = path.join(root, 'release')
      const relative = entry.startsWith('.env') || entry === '更换key.txt'
        ? entry
        : `${entry}/private.txt`
      write(releaseRoot, relative, 'synthetic local fixture')

      const result = spawnSync(process.execPath, [verifyScript, releaseRoot], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
      })

      expect(result.status).not.toBe(0)
      expect(`${result.stdout}\n${result.stderr}`).toContain('forbidden path:')
    },
  )

  for (const kind of ['build-root', 'cleanup-target', 'public-target'] as const) {
    it(`refuses a linked ${kind} without deleting the source directory`, (context) => {
      const root = temporaryRoot()
      const source = path.join(root, '.tmp')
      write(source, 'keep.txt', 'source fixture must remain')
      write(root, '.next/static/chunks/app.js')
      write(root, 'public/keep.txt', 'public runtime asset')
      mkdirSync(path.join(root, '.next'), { recursive: true })
      const standalone = path.join(root, '.next', 'standalone')
      if (kind !== 'build-root') mkdirSync(standalone, { recursive: true })
      const link = kind === 'build-root'
        ? standalone
        : path.join(standalone, kind === 'cleanup-target' ? '.tmp' : 'public')
      try {
        symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir')
      } catch (error) {
        if (isUnavailableLinkError(error)) {
          context.skip()
          return
        }
        throw error
      }

      const result = spawnSync(process.execPath, [prepareScript], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
      })
      expect(result.status).not.toBe(0)
      expect(`${result.stdout}\n${result.stderr}`).toContain('Refusing to')
      expect(readFileSync(path.join(source, 'keep.txt'), 'utf8')).toBe('source fixture must remain')
    })
  }

  it('rejects a file symbolic link without reading its target', (context) => {
    const root = temporaryRoot()
    const releaseRoot = path.join(root, 'release')
    const target = path.join(root, 'outside-secret.txt')
    writeFileSync(target, `sk-${'x'.repeat(24)}`, 'utf8')
    mkdirSync(releaseRoot, { recursive: true })

    try {
      symlinkSync(target, path.join(releaseRoot, 'linked.txt'), 'file')
    } catch (error) {
      if (isUnavailableLinkError(error)) {
        context.skip()
        return
      }
      throw error
    }

    const result = spawnSync(process.execPath, [verifyScript, releaseRoot], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    })
    const output = `${result.stdout}\n${result.stderr}`

    expect(result.status).not.toBe(0)
    expect(output).toContain(
      `symbolic link or junction: ${path.join('release', 'linked.txt')}`,
    )
    expect(output).not.toContain('possible credential in:')
  })

  it.runIf(process.platform === 'win32')(
    'rejects a Windows junction without traversing it',
    (context) => {
      const root = temporaryRoot()
      const releaseRoot = path.join(root, 'release')
      const target = path.join(root, 'outside-directory')
      write(target, '.omo/private.txt')
      mkdirSync(releaseRoot, { recursive: true })

      try {
        symlinkSync(target, path.join(releaseRoot, 'linked-directory'), 'junction')
      } catch (error) {
        if (isUnavailableLinkError(error)) {
          context.skip()
          return
        }
        throw error
      }

      const result = spawnSync(process.execPath, [verifyScript, releaseRoot], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
      })
      const output = `${result.stdout}\n${result.stderr}`

      expect(result.status).not.toBe(0)
      expect(output).toContain(
        `symbolic link or junction: ${path.join('release', 'linked-directory')}`,
      )
      expect(output).not.toContain('forbidden path:')
    },
  )

  it('keeps release verification inside the standalone build command', () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> }

    expect(packageJson.scripts['build:standalone']).toBe(
      'npm run build && node scripts/prepare-standalone.mjs && node scripts/verify-release-tree.mjs && node scripts/smoke-standalone.mjs',
    )
    expect(packageJson.scripts['verify:standalone-smoke']).toBe(
      'node scripts/smoke-standalone.mjs',
    )

    const packageWin = readFileSync(
      path.join(repoRoot, 'scripts', 'package-win.mjs'),
      'utf8',
    )
    expect(packageWin.indexOf('scripts/verify-release-tree.mjs')).toBeGreaterThan(-1)
    expect(packageWin.indexOf('scripts/smoke-standalone.mjs')).toBeGreaterThan(
      packageWin.indexOf('scripts/verify-release-tree.mjs'),
    )
  })
})
