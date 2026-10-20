import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'fs'
import path from 'path'
import { isForbiddenReleaseRootEntry } from './release-boundary.mjs'

const root = path.resolve(process.cwd())
const standalone = path.join(root, '.next', 'standalone')
if (!existsSync(standalone)) {
  throw new Error('Run next build before preparing standalone output.')
}

// Resolve the actual build root before any recursive deletion. A junction at
// either build directory would otherwise redirect cleanup into a source tree.
for (const directory of [path.join(root, '.next'), standalone]) {
  const metadata = lstatSync(directory)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Refusing to prepare a linked or invalid build directory: ${directory}`)
  }
}
const expectedStandalone = path.join(realpathSync(root), '.next', 'standalone')
if (path.relative(expectedStandalone, realpathSync(standalone)) !== '') {
  throw new Error(`Refusing to prepare standalone outside the build root: ${standalone}`)
}

function ownedStandalonePath(relative) {
  const target = path.resolve(standalone, relative)
  const relativeTarget = path.relative(standalone, target)
  if (
    !relativeTarget ||
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTarget)
  ) {
    throw new Error(`Refusing to clean unexpected standalone path: ${target}`)
  }
  let current = standalone
  for (const segment of relativeTarget.split(path.sep)) {
    current = path.join(current, segment)
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`Refusing to clean through a symbolic link or junction: ${current}`)
      }
    } catch (error) {
      if (error?.code === 'ENOENT') break
      throw error
    }
  }
  return target
}

function removeStandaloneOutput(relative) {
  const target = ownedStandalonePath(relative)
  rmSync(target, { recursive: true, force: true })
}

// Enumerate only direct output entries, including future .acceptance-* fixture
// directories. Source directories and unknown runtime assets remain untouched.
for (const entry of readdirSync(standalone)) {
  if (isForbiddenReleaseRootEntry(entry)) removeStandaloneOutput(entry)
}

const staticSource = path.join(root, '.next', 'static')
const staticTarget = ownedStandalonePath(path.join('.next', 'static'))
mkdirSync(path.dirname(staticTarget), { recursive: true })
removeStandaloneOutput(path.join('.next', 'static'))
cpSync(staticSource, staticTarget, { recursive: true })

const publicSource = path.join(root, 'public')
if (existsSync(publicSource)) {
  const publicTarget = ownedStandalonePath('public')
  // Replace the generated copy rather than merging into stale output, whose
  // nested links could otherwise redirect writes outside the build tree.
  removeStandaloneOutput('public')
  cpSync(publicSource, publicTarget, { recursive: true })
}

// Migrations are runtime assets, not traced JavaScript dependencies. Keep them
// in a stable top-level directory so desktop and Docker builds use the same path.
const migrationsSource = path.join(root, 'src', 'lib', 'db', 'migrations')
const migrationsTarget = ownedStandalonePath('migrations')
removeStandaloneOutput('migrations')
cpSync(migrationsSource, migrationsTarget, { recursive: true })

// electron-builder rebuilds native modules for Electron after Next creates the
// standalone tree. Refresh that module in the tree before packaging.
const nativeSource = path.join(root, 'node_modules', 'better-sqlite3')
const nativeRelative = path.join(
  'node_modules',
  'better-sqlite3',
)
if (existsSync(nativeSource)) {
  const nativeTarget = ownedStandalonePath(nativeRelative)
  removeStandaloneOutput(nativeRelative)
  cpSync(nativeSource, nativeTarget, { recursive: true })
}
