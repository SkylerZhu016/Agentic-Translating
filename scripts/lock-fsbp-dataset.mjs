import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const [rootInput = 'FSBP_Test', reviewInput] = process.argv.slice(2)
if (!reviewInput) {
  throw new Error(
    'Usage: node scripts/lock-fsbp-dataset.mjs <dataset-root> <review.jsonl>',
  )
}

const datasetRoot = path.resolve(rootInput)
const version = '0.1.0'
const manifestPath = path.join(datasetRoot, 'dataset-manifest.json')
const devPath = path.join(datasetRoot, 'datasets', 'quality-dev.jsonl')
const testPath = path.join(datasetRoot, 'datasets', 'quality-test.jsonl')
const devCandidatesPath = path.join(
  datasetRoot,
  'selection',
  'dev-candidates-round-01.jsonl',
)
const testCandidatesPath = path.join(
  datasetRoot,
  'selection',
  'test-candidates-round-01.jsonl',
)

async function readJsonl(filePath) {
  return (await readFile(filePath, 'utf8'))
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line)
      } catch (error) {
        throw new Error(
          `${path.basename(filePath)}:${index + 1}: ${error.message}`,
        )
      }
    })
}

function jsonl(records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
if (manifest.status !== 'draft') {
  throw new Error(`Refusing to lock dataset in status: ${manifest.status}`)
}
if ((await readFile(testPath, 'utf8')).trim()) {
  throw new Error('Refusing to overwrite a non-empty formal test dataset.')
}

const dev = await readJsonl(devPath)
const devCandidates = await readJsonl(devCandidatesPath)
const testCandidates = await readJsonl(testCandidatesPath)
const reviews = await readJsonl(path.resolve(reviewInput))
const reviewById = new Map(reviews.map((record) => [record.sampleId, record]))

if (dev.length !== 8 || testCandidates.length !== 16) {
  throw new Error(
    `Expected 8 development and 16 test samples; found ${dev.length} and ${testCandidates.length}.`,
  )
}
for (const sample of testCandidates) {
  const review = reviewById.get(sample.id)
  if (!review || review.reviewStatus !== 'reviewed') {
    throw new Error(`Missing completed human review for ${sample.id}`)
  }
}
if (reviews.length !== testCandidates.length) {
  throw new Error(
    `Review count mismatch: ${reviews.length} for ${testCandidates.length} test samples.`,
  )
}

const lockedDev = dev.map((sample) => ({
  ...sample,
  datasetVersion: version,
}))
const lockedDevCandidates = devCandidates.map((sample) => ({
  ...sample,
  datasetVersion: version,
}))
const lockedTest = testCandidates.map((sample) => ({
  ...sample,
  datasetVersion: version,
}))
const lockedManifest = {
  ...manifest,
  status: 'locked',
  datasetVersion: version,
  lockedAt: new Date().toISOString(),
}

await writeFile(devPath, jsonl(lockedDev), 'utf8')
await writeFile(devCandidatesPath, jsonl(lockedDevCandidates), 'utf8')
await writeFile(testCandidatesPath, jsonl(lockedTest), 'utf8')
await writeFile(testPath, jsonl(lockedTest), 'utf8')
await writeFile(
  manifestPath,
  `${JSON.stringify(lockedManifest, null, 2)}\n`,
  'utf8',
)

process.stdout.write(
  `Locked FSBP dataset ${version}: ${lockedDev.length} dev, ${lockedTest.length} test.\n`,
)
