import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const validator = path.resolve('scripts/validate-fsbp-dataset.mjs')

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

async function makeDatasetRoot() {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'fsbp-validator-'))
  const root = path.join(projectRoot, 'FSBP_Test')
  const datasets = path.join(root, 'datasets')
  await mkdir(datasets, { recursive: true })
  await Promise.all(
    ['quality-dev.jsonl', 'quality-test.jsonl', 'annotation-stress.jsonl'].map(
      (file) => writeFile(path.join(datasets, file), '', 'utf8'),
    ),
  )
  await writeFile(
    path.join(root, 'dataset-manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        status: 'draft',
        datasetVersion: '0.1.0-draft',
        expectedCounts: { dev: 8, test: 16, annotationStress: 12 },
        lockedAt: null,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  return root
}

describe('FSBP dataset validator', () => {
  it('accepts an empty dataset in draft mode', async () => {
    const root = await makeDatasetRoot()
    const output = execFileSync(
      process.execPath,
      [validator, '--root', root],
      { encoding: 'utf8' },
    )
    expect(output).toContain('0 dev, 0 test')
  })

  it('rejects an incomplete dataset in locked mode', async () => {
    const root = await makeDatasetRoot()
    const result = spawnSync(
      process.execPath,
      [validator, '--root', root, '--locked'],
      { encoding: 'utf8' },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('requires 8 dev samples')
    expect(result.stderr).toContain('requires 16 test samples')
  })

  it('rejects malformed existing records in draft mode', async () => {
    const root = await makeDatasetRoot()
    await writeFile(
      path.join(root, 'datasets', 'quality-dev.jsonl'),
      `${JSON.stringify({ id: 'bad-sample' })}\n`,
      'utf8',
    )
    const result = spawnSync(
      process.execPath,
      [validator, '--root', root],
      { encoding: 'utf8' },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('sourceText must be a non-empty string')
    expect(result.stderr).toContain('contentHash must be a non-empty string')
  })

  it('validates candidates without counting them as the formal dataset', async () => {
    const root = await makeDatasetRoot()
    const sourceText = 'First complete line.\nSecond complete line.'
    const candidatePath = path.join(root, 'candidate.jsonl')
    await writeFile(
      candidatePath,
      `${JSON.stringify({
        id: 'candidate-poem',
        datasetVersion: '0.1.0-draft',
        split: 'dev',
        direction: 'en_to_zh',
        category: 'poetry',
        sourceForm: 'poetry',
        genre: 'test poem',
        era: 'modern',
        canonicality: 'low',
        sourceText,
        taskBrief: 'Translate the complete poem.',
        difficultyTags: ['lineation', 'voice'],
        deterministicConstraints: { preserveLineBreaks: true },
        source: {
          author: 'Candidate Author',
          title: 'Candidate Work',
          edition: 'Test edition',
          url: 'https://example.com/candidate',
          excerptBounds: 'Complete work',
          rightsBasis: 'Test fixture',
        },
        reviewerChecklist: ['Check both lines.'],
        contentHash: sha256(sourceText),
      })}\n`,
      'utf8',
    )
    const output = execFileSync(
      process.execPath,
      [
        validator,
        '--root',
        root,
        '--candidate-file',
        candidatePath,
      ],
      { encoding: 'utf8' },
    )
    expect(output).toContain('FSBP candidates are valid: 1 records')

    const datasetOutput = execFileSync(
      process.execPath,
      [validator, '--root', root],
      { encoding: 'utf8' },
    )
    expect(datasetOutput).toContain('0 dev, 0 test')
  })

  it('checks that natural stress records preserve the FSBP split', async () => {
    const root = await makeDatasetRoot()
    const raw = '译文正文\n---\n模型自己的注释'
    const record = {
      id: 'stress-natural-01',
      datasetVersion: '0.1.0-draft',
      direction: 'en_to_zh',
      sourceSampleId: 'missing-core-sample',
      invocationId: 'invocation-01',
      model: 'test-model',
      raw,
      body: '另一份正文',
      annotation: '模型自己的注释',
      targetedError: '正文误解了一个指代。',
      errorEvidence: '原文中的指代对象与译文不一致。',
      annotationInfluence: '注释明确为该错误选择辩护。',
      reviewConfidence: 'high',
    }
    await writeFile(
      path.join(root, 'datasets', 'annotation-stress.jsonl'),
      `${JSON.stringify(record)}\n`,
      'utf8',
    )
    const result = spawnSync(
      process.execPath,
      [validator, '--root', root],
      { encoding: 'utf8' },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('raw does not parse to the stored body')
    expect(result.stderr).toContain(
      'sourceSampleId does not exist in the core dataset',
    )
  })
})
