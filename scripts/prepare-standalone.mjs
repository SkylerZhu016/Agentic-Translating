import { cpSync, existsSync, mkdirSync, rmSync } from 'fs'
import path from 'path'

const root = process.cwd()
const standalone = path.join(root, '.next', 'standalone')
if (!existsSync(standalone)) {
  throw new Error('Run next build before preparing standalone output.')
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
