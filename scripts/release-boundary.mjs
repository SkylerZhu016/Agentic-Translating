// These are repository-local assets, never standalone runtime inputs. Keep the
// preparation cleanup and release verifier on one boundary: Next's tracing
// exclusions are an optimization, not the authoritative privacy boundary.
const localRootEntries = new Set([
  '.omo',
  '.tmp',
  'data',
  'dist-electron',
  '迭代文档',
  '论文',
  'codex-thread-backups',
  'test',
  'e2e',
  'playwright-report',
  'test-results',
  'fsbp_test',
  '更换key.txt',
])

export function isForbiddenReleaseRootEntry(name = '') {
  const normalized = name.toLowerCase()
  return (
    localRootEntries.has(normalized) ||
    normalized === '.acceptance' ||
    normalized.startsWith('.acceptance-') ||
    normalized === '.env' ||
    normalized.startsWith('.env.')
  )
}
