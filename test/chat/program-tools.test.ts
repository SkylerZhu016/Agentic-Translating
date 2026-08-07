// ---------------------------------------------------------------------------
// Programming tool executors — file_read / file_edit / run_command
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { executeProgrammaticTool } from '../../src/lib/chat/program-tools'

let workDir: string
let prevCwd: string

beforeAll(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'prog-tools-'))
  prevCwd = process.cwd()
  process.chdir(workDir)
})

afterAll(() => {
  process.chdir(prevCwd)
  // cmd.exe child handles may linger briefly after taskkill — retry
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(workDir, { recursive: true, force: true })
      break
    } catch {
      // eslint-disable-next-line no-undef
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400)
    }
  }
})

function writeSample(name: string, content: string): string {
  const p = path.join(workDir, name)
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, content, 'utf8')
  return name
}

describe('file_read', () => {
  it('reads a file with 1-based line numbers', async () => {
    writeSample('sample.txt', 'line one\nline two\nline three\n')
    const r = await executeProgrammaticTool('file_read', { path: 'sample.txt' })
    expect(r.ok).toBe(true)
    expect(r.content).toContain('1: line one')
    expect(r.content).toContain('2: line two')
    expect(r.content).toContain('3: line three')
  })

  it('respects start_line/end_line ranges', async () => {
    const r = await executeProgrammaticTool('file_read', {
      path: 'sample.txt',
      start_line: 2,
      end_line: 2,
    })
    expect(r.ok).toBe(true)
    expect(r.content).toContain('2: line two')
    expect(r.content).not.toContain('1: line one')
    expect(r.content).not.toContain('3: line three')
  })

  it('rejects paths escaping the project root', async () => {
    const r = await executeProgrammaticTool('file_read', { path: '../secret.txt' })
    expect(r.ok).toBe(false)
    expect(r.content).toContain('escapes')
  })

  it('reports missing files', async () => {
    const r = await executeProgrammaticTool('file_read', { path: 'nope.txt' })
    expect(r.ok).toBe(false)
  })
})

describe('file_edit', () => {
  it('replaces a unique verbatim match', async () => {
    writeSample('edit-a.txt', 'alpha\nbeta\ngamma\n')
    const r = await executeProgrammaticTool('file_edit', {
      path: 'edit-a.txt',
      old_string: 'beta',
      new_string: 'BETA',
    })
    expect(r.ok).toBe(true)
    expect(readFileSync(path.join(workDir, 'edit-a.txt'), 'utf8')).toBe('alpha\nBETA\ngamma\n')
  })

  it('rejects ambiguous (multi-occurrence) matches and leaves the file unchanged', async () => {
    writeSample('edit-b.txt', 'dup\ndup\n')
    const r = await executeProgrammaticTool('file_edit', {
      path: 'edit-b.txt',
      old_string: 'dup',
      new_string: 'x',
    })
    expect(r.ok).toBe(false)
    expect(r.content).toContain('multiple')
    expect(readFileSync(path.join(workDir, 'edit-b.txt'), 'utf8')).toBe('dup\ndup\n')
  })

  it('rejects not-found matches', async () => {
    writeSample('edit-c.txt', 'only text\n')
    const r = await executeProgrammaticTool('file_edit', {
      path: 'edit-c.txt',
      old_string: 'absent',
      new_string: 'x',
    })
    expect(r.ok).toBe(false)
    expect(r.content).toContain('not found')
  })

  it('replace_all swaps every occurrence', async () => {
    writeSample('edit-d.txt', 'a,b,a,c,a\n')
    const r = await executeProgrammaticTool('file_edit', {
      path: 'edit-d.txt',
      old_string: 'a',
      new_string: 'Z',
      replace_all: true,
    })
    expect(r.ok).toBe(true)
    expect(readFileSync(path.join(workDir, 'edit-d.txt'), 'utf8')).toBe('Z,b,Z,c,Z\n')
  })

  it('preserves CRLF line endings', async () => {
    writeSample('edit-e.txt', 'one\r\ntwo\r\n')
    const r = await executeProgrammaticTool('file_edit', {
      path: 'edit-e.txt',
      old_string: 'one\ntwo',
      new_string: 'ONE\ntwo',
    })
    expect(r.ok).toBe(true)
    expect(readFileSync(path.join(workDir, 'edit-e.txt'), 'utf8')).toBe('ONE\r\ntwo\r\n')
  })
})

describe('run_command', () => {
  it('returns stdout for a successful command', async () => {
    const r = await executeProgrammaticTool('run_command', { command: 'node -p 6*7' })
    expect(r.ok).toBe(true)
    expect(r.content).toContain('42')
  })

  it('returns the exit code for a failing command', async () => {
    const r = await executeProgrammaticTool('run_command', {
      command: 'exit 3',
    })
    expect(r.ok).toBe(false)
    expect(r.content).toContain('with code 3')
  })

  it('kills commands that exceed the timeout', async () => {
    const r = await executeProgrammaticTool('run_command', {
      command: 'ping -n 60 127.0.0.1',
      timeout_ms: 1000,
    })
    expect(r.ok).toBe(false)
    expect(r.content).toContain('timed out')
  })
})

describe('unknown tool', () => {
  it('returns a stable ignored message', async () => {
    const r = await executeProgrammaticTool('nope_tool', {})
    expect(r.ok).toBe(false)
    expect(r.content).toBe('Unknown tool — ignored.')
  })
})
