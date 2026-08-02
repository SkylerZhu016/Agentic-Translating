import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const candidateFile = path.resolve(
  'FSBP_Test/selection/test-candidates-round-01.jsonl',
)

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

async function readCandidates() {
  return (await readFile(candidateFile, 'utf8'))
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

describe('FSBP test candidate round 01', () => {
  it('contains two candidates in every direction and category bucket', async () => {
    const candidates = await readCandidates()
    expect(candidates).toHaveLength(16)

    const buckets = new Map<string, number>()
    for (const sample of candidates) {
      const key = `${sample.direction}:${sample.category}`
      buckets.set(key, (buckets.get(key) ?? 0) + 1)
    }

    for (const direction of ['en_to_zh', 'zh_to_en']) {
      for (const category of [
        'poetry',
        'literary',
        'cultural_argument',
        'nonliterary',
      ]) {
        expect(buckets.get(`${direction}:${category}`)).toBe(2)
      }
    }
  })

  it('uses only the sourceText SHA-256 as its content fingerprint', async () => {
    const candidates = await readCandidates()
    for (const sample of candidates) {
      expect(sample.contentHash).toBe(sha256(sample.sourceText))
      expect(sample).not.toHaveProperty('rawHash')
      expect(sample).not.toHaveProperty('bodyHash')
    }
  })

  it('stores Chinese source texts in simplified characters', async () => {
    const candidates = await readCandidates()
    const commonTraditional =
      /[學國體說聲萬與為時後雲風東書師無長見問從來實數開關禮義恥]/

    for (const sample of candidates.filter(
      (candidate) => candidate.direction === 'zh_to_en',
    )) {
      expect(sample.sourceText).not.toMatch(commonTraditional)
    }
  })
})
