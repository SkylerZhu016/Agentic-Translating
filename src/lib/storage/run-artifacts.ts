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

export const RUNS_DIR = path.resolve(process.cwd(), 'data', 'runs')

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
    const dir = path.join(RUNS_DIR, sessionId)
    fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, `${kind}.txt`)
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
    const filePath = path.join(RUNS_DIR, sessionId, `${kind}.txt`)
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
    const dir = path.join(RUNS_DIR, sessionId)
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  } catch (err) {
    console.warn('Failed to delete run artifacts:', err)
  }
}
