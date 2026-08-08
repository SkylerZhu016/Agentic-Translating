// Merge one terminal --only shard per configured sample into the canonical gate files.
// Missing, duplicate, foreign, or non-terminal shards are hard failures.
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const configArgument = process.argv.find((argument) => argument.startsWith('--config='))
if (!configArgument) throw new Error('--config is required')
const runConfig = JSON.parse(
  await readFile(path.resolve(configArgument.slice(9)), 'utf8'),
)
const outputDir = path.resolve(
  runConfig.outputDir ?? path.join('FSBP_Test', 'private', 'round-03', 'dev-conversation-v1'),
)
const selectedIds = runConfig.selectedIds ?? []
if (selectedIds.length === 0 || new Set(selectedIds).size !== selectedIds.length) {
  throw new Error('selectedIds must be a non-empty unique list')
}

let mainManifest = null
const mainResults = []
const shardExperimentIds = []
const sourceHashes = {}
const baselineModels = new Set()
const baselineSourceLabels = new Set()
const identityKeys = [
  'promptBundleVersion',
  'model',
  'revisionStrategy',
  'directBaselineLabel',
]

for (const id of selectedIds) {
  const manifestPath = path.join(outputDir, `manifest-${id}.json`)
  const resultsPath = path.join(outputDir, `results-${id}.jsonl`)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const lines = (await readFile(resultsPath, 'utf8'))
    .split(/\r?\n/)
    .filter((line) => line.trim())

  if (JSON.stringify(manifest.sampleIds) !== JSON.stringify(selectedIds)) {
    throw new Error(`${id}: shard manifest sample set does not match the config`)
  }
  if (Number(manifest.expectedCount) !== selectedIds.length) {
    throw new Error(`${id}: shard manifest expectedCount does not match the config`)
  }
  if (lines.length !== 1) {
    throw new Error(`${id}: exactly one result record is required; received ${lines.length}`)
  }
  const record = JSON.parse(lines[0])
  if (record.sampleId !== id) {
    throw new Error(`${id}: shard contains result for ${String(record.sampleId)}`)
  }
  if (!['complete', 'failed'].includes(record.status)) {
    throw new Error(`${id}: shard result is not terminal (${String(record.status)})`)
  }

  if (mainManifest === null) {
    mainManifest = { ...manifest, runs: {} }
  } else {
    for (const key of identityKeys) {
      if (manifest[key] !== mainManifest[key]) {
        throw new Error(`${id}: shard ${key} does not match the other shards`)
      }
    }
  }

  if (manifest.sourceHashes?.[id] == null) {
    throw new Error(`${id}: shard manifest is missing the source hash`)
  }
  sourceHashes[id] = manifest.sourceHashes[id]
  shardExperimentIds.push(manifest.experimentId)
  for (const model of manifest.directBaselineModels ?? []) baselineModels.add(model)
  for (const label of manifest.directBaselineSourceLabels ?? []) {
    baselineSourceLabels.add(label)
  }
  if (manifest.runs?.[id] != null) mainManifest.runs[id] = manifest.runs[id]
  mainResults.push(record)
}

if (mainManifest === null) throw new Error('no shards found to merge')

mainManifest = {
  ...mainManifest,
  experimentId: `${runConfig.experimentSlug ?? 'round3-gate'}-merged`,
  sampleIds: selectedIds,
  expectedCount: selectedIds.length,
  sourceHashes,
  directBaselineModels: [...baselineModels],
  directBaselineSourceLabels: [...baselineSourceLabels],
  shardExperimentIds,
  mergedAt: new Date().toISOString(),
}

const resultById = new Map(mainResults.map((result) => [result.sampleId, result]))
const orderedResults = selectedIds.map((id) => resultById.get(id))
if (orderedResults.some((result) => result == null)) {
  throw new Error('merge invariant failed: at least one selected sample is missing')
}

await writeFile(
  path.join(outputDir, 'manifest.json'),
  `${JSON.stringify(mainManifest, null, 2)}\n`,
  'utf8',
)
await writeFile(
  path.join(outputDir, 'results.jsonl'),
  `${orderedResults.map((item) => JSON.stringify(item)).join('\n')}\n`,
  'utf8',
)
console.log(
  `merged: ${orderedResults.length}/${selectedIds.length} results -> ${path.join(outputDir, 'results.jsonl')}`,
)
