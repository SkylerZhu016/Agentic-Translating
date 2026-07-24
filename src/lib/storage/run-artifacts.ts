// ---------------------------------------------------------------------------
// Run Artifact Txt Writer
//
// Writes intermediate stage outputs to data/runs/{sessionId}/{kind}.txt
// as a human-readable fallback. The DB raw_output column is the truth
// source; txt artifacts are best-effort only and never read back by
// orchestration logic.
//
// kind convention:
//   - 4 stages → 'review' | 'filter' | 'orchestrate' | 'assemble'
//   - drafts   → 'draft-{agent_key}'
// ---------------------------------------------------------------------------

import path from 'path'
import fs from 'fs'

export const RUNS_DIR = path.resolve(
  process.env.AGENTIC_DATA_DIR ?? path.join(process.cwd(), 'data'),
  'runs',
)

function safeSegment(value: string): string {
  const normalized = value
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\.\.+/g, '.')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120)
  return normalized || 'unnamed'
}

function artifactPath(sessionId: string, kind: string): string {
  const dir = path.resolve(RUNS_DIR, safeSegment(sessionId))
  const filePath = path.resolve(dir, `${safeSegment(kind)}.txt`)
  if (
    !dir.startsWith(`${RUNS_DIR}${path.sep}`) ||
    !filePath.startsWith(`${dir}${path.sep}`)
  ) {
    throw new Error('Unsafe run artifact path')
  }
  return filePath
}

/**
 * Write a run artifact to disk as {sessionId}/{kind}.txt.
 * Never throws — on failure logs a warning and continues.
 */
export function writeRunArtifact(
  sessionId: string,
  kind: string,
  content: string,
): void {
  try {
    const filePath = artifactPath(sessionId, kind)
    const dir = path.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(filePath, content, 'utf-8')
  } catch (err) {
    console.warn('Failed to write run artifact:', err)
  }
}

/**
 * Read a run artifact from disk.
 * Returns null if the file does not exist or cannot be read.
 */
export function readRunArtifact(
  sessionId: string,
  kind: string,
): string | null {
  try {
    const filePath = artifactPath(sessionId, kind)
    if (!fs.existsSync(filePath)) {
      return null
    }
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Delete all artifacts for a given session.
 * Never throws — on failure logs a warning and continues.
 */
export function deleteRunArtifacts(sessionId: string): void {
  try {
    const dir = path.dirname(artifactPath(sessionId, 'placeholder'))
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  } catch (err) {
    console.warn('Failed to delete run artifacts:', err)
  }
}
