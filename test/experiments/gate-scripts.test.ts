import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const MERGE = path.join(ROOT, 'scripts', 'merge-gate-shards.mjs')
const BUILD_BLIND = path.join(ROOT, 'scripts', 'build-round3-conversation-blind.mjs')
const VALIDATE_VERDICT = path.join(ROOT, 'scripts', 'validate-gate-verdict.mjs')
const RUN_GATE = path.join(ROOT, 'scripts', 'run-round3-conversation-gate.mjs')
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentic-gate-test-'))
  tempDirs.push(dir)
  return dir
}

function runNode(script: string, args: string[]): Promise<{
  code: number | null
  stdout: string
  stderr: string
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

describe('round-3 experiment artifact guards', () => {
  it('fails shard merging when any configured shard is missing', async () => {
    const dir = tempDir()
    const configPath = path.join(dir, 'config.json')
    writeJson(configPath, { outputDir: dir, selectedIds: ['a', 'b'] })

    const result = await runNode(MERGE, [`--config=${configPath}`])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('manifest-a.json')
  })

  it('merges exactly one terminal result per shard, including recorded failures', async () => {
    const dir = tempDir()
    const ids = ['a', 'b']
    const configPath = path.join(dir, 'config.json')
    writeJson(configPath, {
      outputDir: dir,
      experimentSlug: 'guard-test',
      selectedIds: ids,
    })
    for (const [index, id] of ids.entries()) {
      writeJson(path.join(dir, `manifest-${id}.json`), {
        experimentId: `shard-${id}`,
        sampleIds: ids,
        expectedCount: 2,
        promptBundleVersion: 21,
        model: 'worker',
        revisionStrategy: 'isolated_suggestion',
        directBaselineLabel: 'configured-label',
        directBaselineModels: [index === 0 ? 'GPT' : 'Codex GPT'],
        directBaselineSourceLabels: [index === 0 ? 'GPT via API' : 'Codex GPT'],
        sourceHashes: { [id]: `hash-${id}` },
        runs: { [id]: { batchId: `batch-${id}` } },
      })
      writeFileSync(
        path.join(dir, `results-${id}.jsonl`),
        `${JSON.stringify({ sampleId: id, status: index === 0 ? 'complete' : 'failed' })}\n`,
        'utf8',
      )
    }

    const result = await runNode(MERGE, [`--config=${configPath}`])
    expect(result.code).toBe(0)
    const records = readFileSync(path.join(dir, 'results.jsonl'), 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
    expect(records.map((record) => record.sampleId)).toEqual(ids)
    expect(records.map((record) => record.status)).toEqual(['complete', 'failed'])
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    expect(manifest.directBaselineModels).toEqual(['GPT', 'Codex GPT'])
    expect(manifest.directBaselineSourceLabels).toEqual(['GPT via API', 'Codex GPT'])
    expect(manifest.sourceHashes).toEqual({ a: 'hash-a', b: 'hash-b' })
  })

  it('keeps system failures out of quality pairs and records actual provenance', async () => {
    const dir = tempDir()
    writeJson(path.join(dir, 'manifest.json'), {
      experimentId: 'blind-guard',
      expectedCount: 2,
      sampleIds: ['complete', 'failed'],
      directBaselineLabel: 'misleading-config-label',
    })
    const complete = {
      sampleId: 'complete',
      status: 'complete',
      direction: 'en_to_zh',
      category: 'literary',
      promptBundleVersion: 21,
      revisionCount: 2,
      sourceText: 'source one',
      taskBrief: '',
      directText: 'direct one',
      directBaselineModel: 'Codex GPT',
      finalText: 'workflow one',
      sessionId: 's1',
      versions: [{ versionId: 1, versionNo: 1, textSha256: 'x', patchCount: 0 }],
    }
    const failed = {
      sampleId: 'failed',
      status: 'failed',
      direction: 'zh_to_en',
      category: 'poetry',
      promptBundleVersion: 21,
      sourceText: 'source two',
      taskBrief: '',
      directText: 'direct two',
      directBaselineModel: 'GPT 5.6 Sol',
      finalText: null,
      error: 'provider unavailable',
      sessionId: null,
      versions: [],
    }
    writeFileSync(
      path.join(dir, 'results.jsonl'),
      `${JSON.stringify(complete)}\n${JSON.stringify(failed)}\n`,
      'utf8',
    )

    const result = await runNode(BUILD_BLIND, [`--round=${dir}`, '--salt=fixed'])
    expect(result.code).toBe(0)
    const mapping = JSON.parse(readFileSync(path.join(dir, 'blind-mapping.json'), 'utf8'))
    expect(mapping.pairs).toHaveLength(1)
    expect([mapping.pairs[0].A, mapping.pairs[0].B]).toContain('direct:Codex GPT')
    expect([mapping.pairs[0].A, mapping.pairs[0].B]).toContain('fsbp-v21-chat-r2')
    expect(mapping.systemFailures).toEqual([
      {
        sampleId: 'failed',
        countedWinner: 'GPT 5.6 Sol',
        error: 'provider unavailable',
      },
    ])
    const blind = readFileSync(path.join(dir, 'blind-review.md'), 'utf8')
    expect(blind).not.toContain('source two')
    expect(blind).not.toContain('direct two')
    expect(blind).toContain('系统失败：1 项')
  })

  it('rejects a hand-written pass when 4/4 actually contains a tie', async () => {
    const dir = tempDir()
    const verdictPath = path.join(dir, 'verdict.json')
    writeJson(verdictPath, {
      mainComparison: [
        { itemNo: 1, winner: 'A', A: 'fsbp-v1', B: 'direct', fsbpWins: true },
        { itemNo: 2, winner: 'A', A: 'fsbp-v1', B: 'direct', fsbpWins: true },
        { itemNo: 3, winner: 'A', A: 'fsbp-v1', B: 'direct', fsbpWins: true },
        { itemNo: 4, winner: 'tie', A: 'fsbp-v1', B: 'direct', fsbpWins: false },
      ],
      gates: {
        directGate: {
          requirement: '4/4 胜 GPT 直译',
          fsbpWins: 3,
          ties: 1,
          losses: 0,
          total: 4,
          passed: true,
        },
      },
    })

    const result = await runNode(VALIDATE_VERDICT, [`--verdict=${verdictPath}`])
    expect(result.code).toBe(1)
    const output = JSON.parse(result.stdout)
    expect(output.summary).toEqual({ fsbpWins: 3, ties: 1, losses: 0, total: 4 })
    expect(output.failures.join('\n')).toContain('passed=true')
  })

  it('records a failed sample and exits non-zero instead of reporting gate success', async () => {
    const dir = tempDir()
    const datasetPath = path.join(dir, 'dataset.jsonl')
    const baselinePath = path.join(dir, 'baseline.jsonl')
    const configPath = path.join(dir, 'config.json')
    writeFileSync(datasetPath, `${JSON.stringify({
      id: 'sample-a',
      direction: 'en_to_zh',
      category: 'literary',
      sourceText: 'A source text.',
      taskBrief: 'Translate faithfully.',
    })}\n`, 'utf8')
    writeFileSync(baselinePath, `${JSON.stringify({
      sampleId: 'sample-a',
      body: 'A direct translation.',
      model: 'Baseline Model',
    })}\n`, 'utf8')

    const server = createServer((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'fixture_not_found' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no fixture port')
    writeJson(configPath, {
      apiBase: `http://127.0.0.1:${address.port}`,
      outputDir: dir,
      datasetPath,
      baselinePath,
      selectedIds: ['sample-a'],
      expectedCount: 1,
      promptBundleVersion: 21,
      requireHumanReviewedBaseline: false,
      baselineModelAliases: { 'Baseline Model': 'Canonical Baseline Model' },
      expectedBaselineModel: 'Canonical Baseline Model',
    })

    try {
      const result = await runNode(RUN_GATE, [
        `--config=${configPath}`,
        '--only=sample-a',
      ])
      expect(result.code).toBe(1)
      const records = readFileSync(path.join(dir, 'results-sample-a.jsonl'), 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line))
      expect(records).toHaveLength(1)
      expect(records[0].status).toBe('failed')
      expect(records[0].directBaselineModel).toBe('Canonical Baseline Model')
      expect(records[0].directBaselineSourceLabel).toBe('Baseline Model')
      expect(result.stderr).toContain('incomplete or failed samples: sample-a')
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
    }
  })
})
