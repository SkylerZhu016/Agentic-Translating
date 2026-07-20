/**
 * run-artifacts.test.ts — tests for the txt artifact writer (Wave 3 Task 16)
 *
 * Covers:
 *   - writeRunArtifact creates nested dirs + writes file
 *   - writeRunArtifact fails gracefully (mock fs error)
 *   - readRunArtifact existing file → content
 *   - readRunArtifact missing file → null
 *   - deleteRunArtifacts removes dir
 *
 * The writer uses a module-level constant `RUNS_DIR = data/runs` resolved at
 * import time. We can't override the closure, so we write into the real
 * data/runs/ directory under a unique test-scoped subdirectory and clean up
 * before/after each test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

import {
  writeRunArtifact,
  readRunArtifact,
  deleteRunArtifacts,
  RUNS_DIR,
} from '../../src/lib/storage/run-artifacts'

// =============================================================================
// Suite
// =============================================================================

// Use a unique subdirectory under RUNS_DIR for each test session to avoid
// collisions with real run artifacts or other test runs.
const TEST_PREFIX = 'test-run-artifacts-' + process.pid + '-'

describe('run-artifacts — txt writer', () => {
  // Clean up any leftover test artifacts before/after the suite
  beforeEach(() => {
    cleanupTestArtifacts()
  })

  afterEach(() => {
    cleanupTestArtifacts()
  })

  function cleanupTestArtifacts(): void {
    try {
      if (!fs.existsSync(RUNS_DIR)) return
      const entries = fs.readdirSync(RUNS_DIR)
      for (const entry of entries) {
        if (entry.startsWith('test-run-artifacts-')) {
          try {
            fs.rmSync(path.join(RUNS_DIR, entry), { recursive: true, force: true })
          } catch { /* ok */ }
        }
      }
    } catch { /* ok */ }
  }

  function testSessionId(suffix: string): string {
    return TEST_PREFIX + suffix
  }

  // ── writeRunArtifact ───────────────────────────────────────────

  describe('writeRunArtifact', () => {
    it('creates nested dirs and writes the file with the given content', () => {
      const sessionId = testSessionId('basic')
      const kind = 'review'
      const content = '审查意见正文\n---\n注释部分'

      writeRunArtifact(sessionId, kind, content)

      const expectedPath = path.join(RUNS_DIR, sessionId, `${kind}.txt`)
      expect(fs.existsSync(expectedPath)).toBe(true)
      const written = fs.readFileSync(expectedPath, 'utf-8')
      expect(written).toBe(content)
    })

    it('creates the sessionId directory when it does not exist', () => {
      const sessionId = testSessionId('mkdir')
      // Pre-condition: directory does not exist
      const dir = path.join(RUNS_DIR, sessionId)
      expect(fs.existsSync(dir)).toBe(false)

      writeRunArtifact(sessionId, 'filter', 'filter output')

      expect(fs.existsSync(dir)).toBe(true)
      expect(fs.existsSync(path.join(dir, 'filter.txt'))).toBe(true)
    })

    it('overwrites existing file on re-write', () => {
      const sessionId = testSessionId('overwrite')
      writeRunArtifact(sessionId, 'assemble', 'first version')
      writeRunArtifact(sessionId, 'assemble', 'second version')

      const filePath = path.join(RUNS_DIR, sessionId, 'assemble.txt')
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('second version')
    })

    it('handles draft-{agent_key} kind convention', () => {
      const sessionId = testSessionId('drafts')
      writeRunArtifact(sessionId, 'draft-agent1', 'translation draft 1')
      writeRunArtifact(sessionId, 'draft-agent2', 'translation draft 2')

      const dir = path.join(RUNS_DIR, sessionId)
      expect(fs.existsSync(path.join(dir, 'draft-agent1.txt'))).toBe(true)
      expect(fs.existsSync(path.join(dir, 'draft-agent2.txt'))).toBe(true)
      expect(fs.readFileSync(path.join(dir, 'draft-agent1.txt'), 'utf-8'))
        .toBe('translation draft 1')
    })

    it('does NOT throw when fs.writeFileSync fails (fails gracefully)', () => {
      const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
        throw new Error('EACCES: permission denied')
      })
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      expect(() => writeRunArtifact(testSessionId('fail-write'), 'review', 'content')).not.toThrow()
      expect(warnSpy).toHaveBeenCalled()

      spy.mockRestore()
      warnSpy.mockRestore()
    })

    it('does NOT throw when fs.mkdirSync fails (fails gracefully)', () => {
      const spy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
        throw new Error('ENOSPC: no space left on device')
      })
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      expect(() => writeRunArtifact(testSessionId('fail-mkdir'), 'review', 'content')).not.toThrow()
      expect(warnSpy).toHaveBeenCalled()

      spy.mockRestore()
      warnSpy.mockRestore()
    })
  })

  // ── readRunArtifact ────────────────────────────────────────────

  describe('readRunArtifact', () => {
    it('returns the file content when the artifact exists', () => {
      const sessionId = testSessionId('read-ok')
      const kind = 'orchestrate'
      const content = '编排方案正文'
      // Seed
      writeRunArtifact(sessionId, kind, content)

      const result = readRunArtifact(sessionId, kind)
      expect(result).toBe(content)
    })

    it('returns null when the file does not exist', () => {
      const result = readRunArtifact(testSessionId('no-such-kind'), 'review')
      expect(result).toBeNull()
    })

    it('returns null when the session directory does not exist', () => {
      const result = readRunArtifact('definitely_no_such_session_xyz', 'review')
      expect(result).toBeNull()
    })

    it('returns null when fs.readFileSync throws (graceful)', () => {
      const sessionId = testSessionId('read-err')
      // First, create the file so existsSync returns true
      writeRunArtifact(sessionId, 'filter', 'orig')
      // Then make readFileSync throw
      const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
        throw new Error('EIO: I/O error')
      })

      const result = readRunArtifact(sessionId, 'filter')
      expect(result).toBeNull()

      spy.mockRestore()
    })
  })

  // ── deleteRunArtifacts ─────────────────────────────────────────

  describe('deleteRunArtifacts', () => {
    it('removes the session directory and all artifacts inside', () => {
      const sessionId = testSessionId('del')
      writeRunArtifact(sessionId, 'review', 'r')
      writeRunArtifact(sessionId, 'filter', 'f')
      writeRunArtifact(sessionId, 'assemble', 'a')

      const dir = path.join(RUNS_DIR, sessionId)
      expect(fs.existsSync(dir)).toBe(true)

      deleteRunArtifacts(sessionId)

      expect(fs.existsSync(dir)).toBe(false)
    })

    it('does NOT throw when the session directory does not exist', () => {
      expect(() => deleteRunArtifacts('never_existed_xyz_123')).not.toThrow()
    })

    it('does NOT throw when fs.rmSync fails (graceful)', () => {
      const sessionId = testSessionId('rm-err')
      // Seed a directory so existsSync returns true
      writeRunArtifact(sessionId, 'review', 'x')
      const spy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
        throw new Error('EPERM: operation not permitted')
      })
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      expect(() => deleteRunArtifacts(sessionId)).not.toThrow()
      expect(warnSpy).toHaveBeenCalled()

      spy.mockRestore()
      warnSpy.mockRestore()
    })

    it('does NOT delete sibling session directories', () => {
      const sessionIdA = testSessionId('sibling-a')
      const sessionIdB = testSessionId('sibling-b')
      writeRunArtifact(sessionIdA, 'review', 'a')
      writeRunArtifact(sessionIdB, 'review', 'b')

      deleteRunArtifacts(sessionIdA)

      expect(fs.existsSync(path.join(RUNS_DIR, sessionIdA))).toBe(false)
      // sess_b must still exist
      expect(fs.existsSync(path.join(RUNS_DIR, sessionIdB))).toBe(true)
      expect(readRunArtifact(sessionIdB, 'review')).toBe('b')
    })
  })
})
