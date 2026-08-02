import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const DIRECTIONS = ['en_to_zh', 'zh_to_en']
const CATEGORIES = [
  'poetry',
  'literary',
  'cultural_argument',
  'nonliterary',
]
const SOURCE_FORMS = [
  'poetry',
  'english_prose',
  'classical_chinese_prose',
  'modern_chinese_prose',
]
const ERAS = [
  'ancient',
  'medieval',
  'early_modern',
  'modern',
  'contemporary',
]
const CANONICALITY = ['low', 'medium', 'high']
const ANONYMOUS_AUTHORS = new Set([
  'anonymous',
  'various',
  '佚名',
  '无名氏',
  '多人',
])

function parseArgs(argv) {
  const result = { locked: false, root: null, candidateFile: null }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--locked') {
      result.locked = true
      continue
    }
    if (token === '--root') {
      result.root = argv[index + 1]
      index += 1
      continue
    }
    if (token === '--candidate-file') {
      result.candidateFile = argv[index + 1]
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${token}`)
  }
  return result
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function normalizeIdentity(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

function englishWordCount(text) {
  return (
    text.match(
      /[\p{L}\p{N}]+(?:[’'][\p{L}\p{N}]+)*(?:-[\p{L}\p{N}]+)*/gu,
    ) ?? []
  ).length
}

function hanCharacterCount(text) {
  return (text.match(/\p{Script=Han}/gu) ?? []).length
}

async function readJsonl(filePath) {
  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Missing dataset file: ${filePath}`)
    }
    throw error
  }

  const records = []
  const errors = []
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch (error) {
      errors.push(
        `${path.basename(filePath)}:${index + 1}: invalid JSON: ${error.message}`,
      )
    }
  }
  return { records, errors, text }
}

function requireString(sample, key, errors) {
  if (typeof sample?.[key] !== 'string' || !sample[key].trim()) {
    errors.push(`${sample?.id ?? '<unknown>'}: ${key} must be a non-empty string`)
    return false
  }
  return true
}

function validateSample(sample, expectedSplit) {
  const errors = []
  const id = typeof sample?.id === 'string' ? sample.id : '<unknown>'

  for (const key of [
    'id',
    'datasetVersion',
    'sourceText',
    'taskBrief',
    'genre',
    'contentHash',
  ]) {
    requireString(sample, key, errors)
  }

  if (sample?.split !== expectedSplit) {
    errors.push(`${id}: split must be ${expectedSplit}`)
  }
  if (!DIRECTIONS.includes(sample?.direction)) {
    errors.push(`${id}: unsupported direction ${sample?.direction}`)
  }
  if (!CATEGORIES.includes(sample?.category)) {
    errors.push(`${id}: unsupported category ${sample?.category}`)
  }
  if (!SOURCE_FORMS.includes(sample?.sourceForm)) {
    errors.push(`${id}: unsupported sourceForm ${sample?.sourceForm}`)
  }
  if (!ERAS.includes(sample?.era)) {
    errors.push(`${id}: unsupported era ${sample?.era}`)
  }
  if (!CANONICALITY.includes(sample?.canonicality)) {
    errors.push(`${id}: unsupported canonicality ${sample?.canonicality}`)
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sample?.id ?? '')) {
    errors.push(`${id}: id must use lowercase kebab-case`)
  }
  if (
    !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(
      sample?.datasetVersion ?? '',
    )
  ) {
    errors.push(`${id}: datasetVersion must be semver-like`)
  }
  if (
    !Array.isArray(sample?.difficultyTags) ||
    new Set(sample.difficultyTags).size < 2 ||
    sample.difficultyTags.some(
      (tag) => typeof tag !== 'string' || !tag.trim(),
    )
  ) {
    errors.push(`${id}: difficultyTags must contain at least two unique tags`)
  }
  if (
    !sample?.deterministicConstraints ||
    typeof sample.deterministicConstraints !== 'object' ||
    Array.isArray(sample.deterministicConstraints)
  ) {
    errors.push(`${id}: deterministicConstraints must be an object`)
  }
  if (
    !Array.isArray(sample?.reviewerChecklist) ||
    sample.reviewerChecklist.length === 0 ||
    sample.reviewerChecklist.some(
      (item) => typeof item !== 'string' || !item.trim(),
    )
  ) {
    errors.push(`${id}: reviewerChecklist must contain at least one item`)
  }

  const source = sample?.source
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    errors.push(`${id}: source must be an object`)
  } else {
    for (const key of [
      'author',
      'title',
      'edition',
      'url',
      'excerptBounds',
      'rightsBasis',
    ]) {
      if (typeof source[key] !== 'string' || !source[key].trim()) {
        errors.push(`${id}: source.${key} must be a non-empty string`)
      }
    }
    try {
      new URL(source.url)
    } catch {
      errors.push(`${id}: source.url must be an absolute URL`)
    }
    if (source.licenseUrl !== undefined) {
      try {
        new URL(source.licenseUrl)
      } catch {
        errors.push(`${id}: source.licenseUrl must be an absolute URL`)
      }
    }
  }

  if (typeof sample?.sourceText === 'string') {
    const expectedHash = sha256(sample.sourceText)
    if (sample.contentHash !== expectedHash) {
      errors.push(
        `${id}: contentHash mismatch; expected ${expectedHash}`,
      )
    }
  }

  if (sample?.category === 'poetry') {
    if (sample.sourceForm !== 'poetry') {
      errors.push(`${id}: poetry category must use poetry sourceForm`)
    }
    const lines =
      typeof sample.sourceText === 'string'
        ? sample.sourceText.split(/\r?\n/).filter((line) => line.trim())
        : []
    if (lines.length < 2) {
      errors.push(`${id}: poetry must preserve at least two non-empty lines`)
    }
    if (sample?.deterministicConstraints?.preserveLineBreaks !== true) {
      errors.push(
        `${id}: poetry must set deterministicConstraints.preserveLineBreaks=true`,
      )
    }
  } else if (sample?.sourceForm === 'poetry') {
    errors.push(`${id}: non-poetry category cannot use poetry sourceForm`)
  } else if (sample?.sourceForm === 'english_prose') {
    if (sample.direction !== 'en_to_zh') {
      errors.push(`${id}: english_prose requires en_to_zh direction`)
    }
    const count = englishWordCount(sample.sourceText ?? '')
    if (count < 170 || count > 240) {
      errors.push(`${id}: english prose has ${count} words; expected 170-240`)
    }
  } else if (sample?.sourceForm === 'classical_chinese_prose') {
    if (sample.direction !== 'zh_to_en') {
      errors.push(`${id}: classical Chinese prose requires zh_to_en direction`)
    }
    const count = hanCharacterCount(sample.sourceText ?? '')
    if (count < 80 || count > 140) {
      errors.push(
        `${id}: classical Chinese prose has ${count} Han characters; expected 80-140`,
      )
    }
  } else if (sample?.sourceForm === 'modern_chinese_prose') {
    if (sample.direction !== 'zh_to_en') {
      errors.push(`${id}: modern Chinese prose requires zh_to_en direction`)
    }
    const count = hanCharacterCount(sample.sourceText ?? '')
    if (count < 160 || count > 240) {
      errors.push(
        `${id}: modern Chinese prose has ${count} Han characters; expected 160-240`,
      )
    }
  }

  return errors
}

function parseSemantic(raw) {
  const normalized = raw.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  const separator = lines.findIndex((line) => line.trim() === '---')
  if (separator < 0) {
    return { body: normalized.trim(), annotation: null }
  }
  return {
    body: lines.slice(0, separator).join('\n').trim(),
    annotation:
      lines.slice(separator + 1).join('\n').trim() || null,
  }
}

function validateStressCase(record) {
  const errors = []
  const id = typeof record?.id === 'string' ? record.id : '<unknown-stress>'
  for (const key of [
    'id',
    'datasetVersion',
    'sourceSampleId',
    'invocationId',
    'model',
    'raw',
    'body',
    'annotation',
    'targetedError',
    'errorEvidence',
    'annotationInfluence',
  ]) {
    if (typeof record?.[key] !== 'string' || !record[key].trim()) {
      errors.push(`${id}: ${key} must be a non-empty string`)
    }
  }
  if (!DIRECTIONS.includes(record?.direction)) {
    errors.push(`${id}: unsupported direction ${record?.direction}`)
  }
  if (!['high', 'medium', 'low'].includes(record?.reviewConfidence)) {
    errors.push(`${id}: reviewConfidence must be high, medium or low`)
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record?.id ?? '')) {
    errors.push(`${id}: id must use lowercase kebab-case`)
  }
  if (
    !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(
      record?.datasetVersion ?? '',
    )
  ) {
    errors.push(`${id}: datasetVersion must be semver-like`)
  }
  if (
    typeof record?.raw === 'string' &&
    typeof record?.body === 'string' &&
    typeof record?.annotation === 'string'
  ) {
    const semantic = parseSemantic(record.raw)
    if (semantic.body !== record.body) {
      errors.push(`${id}: raw does not parse to the stored body`)
    }
    if (semantic.annotation !== record.annotation) {
      errors.push(`${id}: raw does not parse to the stored annotation`)
    }
  }
  return errors
}

async function readManifest(datasetRoot) {
  const manifestPath = path.join(datasetRoot, 'dataset-manifest.json')
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Missing dataset manifest: ${manifestPath}`)
    }
    throw new Error(`Invalid dataset manifest: ${error.message}`)
  }
}

async function oldSampleHashes(datasetRoot) {
  const filePath = path.join(
    datasetRoot,
    'selection',
    'legacy-exclusions.json',
  )
  try {
    const data = JSON.parse(await readFile(filePath, 'utf8'))
    return new Set(
      data.samples.map((sample) => sample.sourceTextHash),
    )
  } catch (error) {
    if (error?.code === 'ENOENT') return new Set()
    throw new Error(`Cannot read legacy exclusions: ${error.message}`)
  }
}

function bucketKey(sample) {
  return `${sample.split}:${sample.direction}:${sample.category}`
}

export async function validateCandidateFile({ root, candidateFile }) {
  const datasetRoot = path.resolve(root)
  const manifest = await readManifest(datasetRoot)
  const candidatePath = path.resolve(candidateFile)
  const candidates = await readJsonl(candidatePath)
  const formalDev = await readJsonl(
    path.join(datasetRoot, 'datasets', 'quality-dev.jsonl'),
  )
  const formalTest = await readJsonl(
    path.join(datasetRoot, 'datasets', 'quality-test.jsonl'),
  )
  const errors = [
    ...candidates.errors,
    ...formalDev.errors,
    ...formalTest.errors,
  ]
  const ids = new Set()
  const works = new Set()
  const authors = new Set()
  const hashes = new Set()
  const buckets = new Map()
  const legacyHashes = await oldSampleHashes(datasetRoot)
  const candidateIds = new Set(
    candidates.records
      .map((sample) => sample?.id)
      .filter((id) => typeof id === 'string'),
  )

  for (const sample of [...formalDev.records, ...formalTest.records]) {
    // Re-validating a candidate that has already been promoted must not make
    // the same stable sample look like a duplicate of itself.
    if (candidateIds.has(sample?.id)) continue

    ids.add(sample.id)
    const work = normalizeIdentity(sample?.source?.title)
    if (work) works.add(work)
    const author = normalizeIdentity(sample?.source?.author)
    const anonymous = ANONYMOUS_AUTHORS.has(
      String(sample?.source?.author ?? '').trim().toLocaleLowerCase('en-US'),
    )
    if (author && !anonymous) authors.add(author)
    if (sample?.contentHash) hashes.add(sample.contentHash)
    const key = bucketKey(sample)
    const bucket = buckets.get(key) ?? []
    bucket.push(sample)
    buckets.set(key, bucket)
  }

  for (const sample of candidates.records) {
    if (!['dev', 'test'].includes(sample?.split)) {
      errors.push(`${sample?.id ?? '<unknown>'}: split must be dev or test`)
      continue
    }
    errors.push(...validateSample(sample, sample.split))
    if (sample.datasetVersion !== manifest?.datasetVersion) {
      errors.push(
        `${sample.id}: datasetVersion must match dataset-manifest.json`,
      )
    }

    if (ids.has(sample.id)) errors.push(`${sample.id}: duplicate id`)
    ids.add(sample.id)

    const work = normalizeIdentity(sample?.source?.title)
    if (work && works.has(work)) {
      errors.push(`${sample.id}: duplicate work title`)
    }
    if (work) works.add(work)

    const author = normalizeIdentity(sample?.source?.author)
    const anonymous = ANONYMOUS_AUTHORS.has(
      String(sample?.source?.author ?? '').trim().toLocaleLowerCase('en-US'),
    )
    if (author && !anonymous && authors.has(author)) {
      errors.push(`${sample.id}: author already appears in another sample`)
    }
    if (author && !anonymous) authors.add(author)

    if (hashes.has(sample.contentHash)) {
      errors.push(`${sample.id}: duplicate sourceText hash`)
    }
    hashes.add(sample.contentHash)
    if (legacyHashes.has(sample.contentHash)) {
      errors.push(`${sample.id}: sourceText duplicates the legacy experiment`)
    }

    const key = bucketKey(sample)
    const bucket = buckets.get(key) ?? []
    bucket.push(sample)
    buckets.set(key, bucket)
  }

  for (const [key, bucket] of buckets) {
    const expected = key.startsWith('dev:') ? 1 : 2
    if (bucket.length > expected) {
      errors.push(`${key}: has ${bucket.length} samples; maximum is ${expected}`)
    }
    if (
      bucket.filter((sample) => sample.canonicality === 'high').length > 1
    ) {
      errors.push(`${key}: more than one high-canonicality sample`)
    }
  }

  return { errors, count: candidates.records.length }
}

export async function validateDataset({ root, locked = false }) {
  const datasetRoot = path.resolve(root)
  const manifest = await readManifest(datasetRoot)
  const dev = await readJsonl(
    path.join(datasetRoot, 'datasets', 'quality-dev.jsonl'),
  )
  const test = await readJsonl(
    path.join(datasetRoot, 'datasets', 'quality-test.jsonl'),
  )
  const stress = await readJsonl(
    path.join(datasetRoot, 'datasets', 'annotation-stress.jsonl'),
  )
  const errors = [...dev.errors, ...test.errors, ...stress.errors]
  const samples = [...dev.records, ...test.records]

  for (const sample of dev.records) {
    errors.push(...validateSample(sample, 'dev'))
    if (sample.datasetVersion !== manifest?.datasetVersion) {
      errors.push(
        `${sample.id}: datasetVersion must match dataset-manifest.json`,
      )
    }
  }
  for (const sample of test.records) {
    errors.push(...validateSample(sample, 'test'))
    if (sample.datasetVersion !== manifest?.datasetVersion) {
      errors.push(
        `${sample.id}: datasetVersion must match dataset-manifest.json`,
      )
    }
  }
  for (const record of stress.records) {
    errors.push(...validateStressCase(record))
    if (record.datasetVersion !== manifest?.datasetVersion) {
      errors.push(
        `${record.id}: datasetVersion must match dataset-manifest.json`,
      )
    }
  }

  if (manifest?.schemaVersion !== 1) {
    errors.push('dataset-manifest.json: schemaVersion must be 1')
  }
  if (!['draft', 'locked'].includes(manifest?.status)) {
    errors.push('dataset-manifest.json: status must be draft or locked')
  }
  if (
    !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(
      manifest?.datasetVersion ?? '',
    )
  ) {
    errors.push('dataset-manifest.json: invalid datasetVersion')
  }
  const expectedCounts = manifest?.expectedCounts
  if (
    expectedCounts?.dev !== 8 ||
    expectedCounts?.test !== 16 ||
    expectedCounts?.annotationStress !== 12
  ) {
    errors.push('dataset-manifest.json: expectedCounts must be 8/16/12')
  }

  const ids = new Set()
  const works = new Set()
  const authors = new Set()
  const hashes = new Set()
  const legacyHashes = await oldSampleHashes(datasetRoot)
  const buckets = new Map()

  for (const sample of samples) {
    if (ids.has(sample.id)) errors.push(`${sample.id}: duplicate id`)
    ids.add(sample.id)

    const work = normalizeIdentity(sample?.source?.title)
    if (work && works.has(work)) errors.push(`${sample.id}: duplicate work title`)
    if (work) works.add(work)

    const author = normalizeIdentity(sample?.source?.author)
    const anonymous = ANONYMOUS_AUTHORS.has(
      String(sample?.source?.author ?? '').trim().toLocaleLowerCase('en-US'),
    )
    if (author && !anonymous && authors.has(author)) {
      errors.push(`${sample.id}: author already appears in another sample`)
    }
    if (author && !anonymous) authors.add(author)

    if (hashes.has(sample.contentHash)) {
      errors.push(`${sample.id}: duplicate sourceText hash`)
    }
    hashes.add(sample.contentHash)

    if (legacyHashes.has(sample.contentHash)) {
      errors.push(`${sample.id}: sourceText duplicates the legacy experiment`)
    }

    const key = bucketKey(sample)
    const bucket = buckets.get(key) ?? []
    bucket.push(sample)
    buckets.set(key, bucket)
  }

  for (const [key, bucket] of buckets) {
    const expected = key.startsWith('dev:') ? 1 : 2
    if (bucket.length > expected) {
      errors.push(`${key}: has ${bucket.length} samples; maximum is ${expected}`)
    }
    const highCanonicality = bucket.filter(
      (sample) => sample.canonicality === 'high',
    ).length
    if (highCanonicality > 1) {
      errors.push(`${key}: more than one high-canonicality sample`)
    }
  }

  if (locked) {
    if (dev.records.length !== 8) {
      errors.push(`locked dataset requires 8 dev samples; found ${dev.records.length}`)
    }
    if (test.records.length !== 16) {
      errors.push(
        `locked dataset requires 16 test samples; found ${test.records.length}`,
      )
    }
    for (const split of ['dev', 'test']) {
      for (const direction of DIRECTIONS) {
        for (const category of CATEGORIES) {
          const key = `${split}:${direction}:${category}`
          const expected = split === 'dev' ? 1 : 2
          const actual = buckets.get(key)?.length ?? 0
          if (actual !== expected) {
            errors.push(`${key}: expected ${expected}, found ${actual}`)
          }
        }
      }
    }
    for (const direction of DIRECTIONS) {
      const eras = new Set(
        samples
          .filter((sample) => sample.direction === direction)
          .map((sample) => sample.era),
      )
      if (eras.size < 2) {
        errors.push(
          `${direction}: locked dataset must cover at least two eras`,
        )
      }
    }
    if (new Set(samples.map((sample) => sample.era)).size < 3) {
      errors.push('locked dataset must cover at least three eras overall')
    }
  }

  if (stress.records.length > 12) {
    errors.push(
      `annotation-stress.jsonl has ${stress.records.length} records; maximum is 12`,
    )
  }

  const stressIds = new Set()
  const invocationIds = new Set()
  for (const record of stress.records) {
    if (stressIds.has(record.id)) {
      errors.push(`${record.id}: duplicate annotation-stress id`)
    }
    stressIds.add(record.id)
    if (invocationIds.has(record.invocationId)) {
      errors.push(
        `${record.id}: invocationId already used by another stress case`,
      )
    }
    invocationIds.add(record.invocationId)
    if (!ids.has(record.sourceSampleId)) {
      errors.push(
        `${record.id}: sourceSampleId does not exist in the core dataset`,
      )
    }
  }

  if (locked) {
    if (manifest?.status !== 'locked') {
      errors.push('locked validation requires manifest.status=locked')
    }
    if (
      typeof manifest?.lockedAt !== 'string' ||
      Number.isNaN(Date.parse(manifest.lockedAt))
    ) {
      errors.push('locked validation requires a valid manifest.lockedAt')
    }
  }

  return {
    errors,
    counts: {
      dev: dev.records.length,
      test: test.records.length,
      stress: stress.records.length,
    },
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const root =
    args.root ?? path.join(process.cwd(), 'FSBP_Test')
  if (args.candidateFile) {
    if (args.locked) {
      throw new Error('--locked cannot be combined with --candidate-file')
    }
    const candidateResult = await validateCandidateFile({
      root,
      candidateFile: args.candidateFile,
    })
    if (candidateResult.errors.length) {
      process.stderr.write(
        `FSBP candidate validation failed (${candidateResult.errors.length}):\n${candidateResult.errors
          .map((error) => `- ${error}`)
          .join('\n')}\n`,
      )
      process.exitCode = 1
      return
    }
    process.stdout.write(
      `FSBP candidates are valid: ${candidateResult.count} records.\n`,
    )
    return
  }
  const result = await validateDataset({ root, locked: args.locked })
  if (result.errors.length) {
    process.stderr.write(
      `FSBP dataset validation failed (${result.errors.length}):\n${result.errors
        .map((error) => `- ${error}`)
        .join('\n')}\n`,
    )
    process.exitCode = 1
    return
  }
  process.stdout.write(
    `FSBP dataset is valid (${args.locked ? 'locked' : 'draft'}): ` +
      `${result.counts.dev} dev, ${result.counts.test} test, ` +
      `${result.counts.stress} annotation-stress records.\n`,
  )
}

const isCli =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`)
    process.exitCode = 1
  })
}
