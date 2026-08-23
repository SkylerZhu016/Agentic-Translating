import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const root = process.cwd()
const requestedRoots = process.argv.slice(2)
const scanRoots = requestedRoots.length
  ? requestedRoots.map((entry) => path.resolve(root, entry))
  : [path.join(root, '.next', 'standalone')]

const forbiddenSegments = new Set([
  '.omo',
  'dist-electron',
  '迭代文档',
  'playwright-report',
  'test-results',
])
const forbiddenNames = new Set([
  '.development-secret-key',
  'app.db',
  'app.db-shm',
  'app.db-wal',
  'desktop-secret.bin',
])
const sensitivePatterns = [
  /(?:^|["'=:,\s])sk-[A-Za-z0-9_-]{20,}/g,
  /AGENTIC_SECRET_KEY\s*=\s*[^\s]+/g,
]

let fileCount = 0
const violations = []

try {
  const tracked = execFileSync(
    'git',
    ['ls-files', '--', '迭代文档/**'],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  ).trim()
  if (tracked) violations.push(`local iteration documents are tracked:\n${tracked}`)
} catch {
  // Packaged staging directories are not Git worktrees; filesystem scanning
  // below remains the authoritative release check there.
}

function scan(directory, relativeBase = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = path.join(relativeBase, entry.name)
    const segments = relative.split(path.sep)
    const absolute = path.join(directory, entry.name)
    let metadata
    try {
      // lstat is deliberate: stat/read-first handling would follow symlinks and
      // Windows junctions before the release boundary can reject them.
      metadata = lstatSync(absolute)
    } catch {
      violations.push(`uninspectable path: ${relative}`)
      continue
    }
    if (entry.isSymbolicLink() || metadata.isSymbolicLink()) {
      violations.push(`symbolic link or junction: ${relative}`)
      continue
    }
    const fsbpIndex = segments.indexOf('FSBP_Test')
    const isPrivateFsbpPath =
      fsbpIndex >= 0 &&
      ['private', 'results', 'cache'].includes(segments[fsbpIndex + 1])
    if (
      segments.some((segment) => forbiddenSegments.has(segment)) ||
      segments[1] === 'data' ||
      isPrivateFsbpPath ||
      (fsbpIndex >= 0 && /\.local\./i.test(entry.name))
    ) {
      violations.push(`forbidden path: ${relative}`)
      continue
    }
    if (entry.isDirectory()) {
      scan(absolute, relative)
      continue
    }
    if (!entry.isFile()) continue
    fileCount += 1
    if (forbiddenNames.has(entry.name)) {
      violations.push(`forbidden file: ${relative}`)
    }
    const size = metadata.size
    if (size <= 2 * 1024 * 1024 && /\.(?:js|mjs|cjs|json|txt|md|env)$/i.test(entry.name)) {
      const text = readFileSync(absolute, 'utf8')
      for (const pattern of sensitivePatterns) {
        pattern.lastIndex = 0
        if (pattern.test(text)) {
          violations.push(`possible credential in: ${relative}`)
        }
      }
    }
  }
}

for (const scanRoot of scanRoots) {
  if (!existsSync(scanRoot)) {
    throw new Error(`Release tree does not exist: ${scanRoot}`)
  }
  const scanRootMetadata = lstatSync(scanRoot)
  if (scanRootMetadata.isSymbolicLink()) {
    violations.push(`symbolic link or junction: ${path.basename(scanRoot)}`)
    continue
  }
  if (!scanRootMetadata.isDirectory()) {
    violations.push(`release root is not a directory: ${path.basename(scanRoot)}`)
    continue
  }
  scan(scanRoot, path.basename(scanRoot))
}

if (violations.length) {
  throw new Error(`Release tree verification failed:\n${violations.join('\n')}`)
}

console.log(`Release tree verified: ${fileCount} files across ${scanRoots.length} root(s).`)
