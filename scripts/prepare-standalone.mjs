import { cpSync, existsSync, mkdirSync, rmSync } from 'fs'
import path from 'path'

const root = process.cwd()
const standalone = path.join(root, '.next', 'standalone')
if (!existsSync(standalone)) {
  throw new Error('Run next build before preparing standalone output.')
}

const forbiddenTopLevelEntries = [
  '.omo',
  'data',
  'dist-electron',
  '迭代文档',
  'test',
  'e2e',
  'playwright-report',
  'test-results',
  'FSBP_Test',
]

for (const entry of forbiddenTopLevelEntries) {
  const target = path.resolve(standalone, entry)
  if (path.dirname(target) !== path.resolve(standalone)) {
    throw new Error(`Refusing to clean unexpected standalone path: ${target}`)
  }
  rmSync(target, { recursive: true, force: true })
}

const staticSource = path.join(root, '.next', 'static')
const staticTarget = path.join(standalone, '.next', 'static')
mkdirSync(path.dirname(staticTarget), { recursive: true })
rmSync(staticTarget, { recursive: true, force: true })
cpSync(staticSource, staticTarget, { recursive: true })

const publicSource = path.join(root, 'public')
if (existsSync(publicSource)) {
  cpSync(publicSource, path.join(standalone, 'public'), { recursive: true })
}

// Migrations are runtime assets, not traced JavaScript dependencies. Keep them
// in a stable top-level directory so desktop and Docker builds use the same path.
const migrationsSource = path.join(root, 'src', 'lib', 'db', 'migrations')
const migrationsTarget = path.join(standalone, 'migrations')
rmSync(migrationsTarget, { recursive: true, force: true })
cpSync(migrationsSource, migrationsTarget, { recursive: true })

// electron-builder rebuilds native modules for Electron after Next creates the
// standalone tree. Refresh that module in the tree before packaging.
const nativeSource = path.join(root, 'node_modules', 'better-sqlite3')
const nativeTarget = path.join(
  standalone,
  'node_modules',
  'better-sqlite3',
)
if (existsSync(nativeSource)) {
  rmSync(nativeTarget, { recursive: true, force: true })
  cpSync(nativeSource, nativeTarget, { recursive: true })
}
