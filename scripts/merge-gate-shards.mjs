// 合并并发 --only 模式产生的分片 manifest/results 为正式文件
// 用法：node scripts/merge-gate-shards.mjs --config=FSBP_Test/private/round-03/<config>.json
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const configArgument = process.argv.find((argument) => argument.startsWith('--config='))
const runConfig = configArgument
  ? JSON.parse(await readFile(path.resolve(configArgument.slice(9)), 'utf8'))
  : {}
const outputDir = path.resolve(
  runConfig.outputDir ?? path.join('FSBP_Test', 'private', 'round-03', 'dev-conversation-v1'),
)
const selectedIds = runConfig.selectedIds ?? []

let mainManifest = null
const mainResults = []
for (const id of selectedIds) {
  const manifestPath = path.join(outputDir, `manifest-${id}.json`)
  const resultsPath = path.join(outputDir, `results-${id}.jsonl`)
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      console.warn(`skip ${id}: no shard manifest`)
      continue
    }
    throw error
  }
  let lines = []
  try {
    lines = (await readFile(resultsPath, 'utf8')).split(/\r?\n/).filter((l) => l.trim())
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (!mainManifest) {
    mainManifest = {
      ...manifest,
      runs: {},
    }
  }
  for (const [sampleId, run] of Object.entries(manifest.runs ?? {})) {
    mainManifest.runs[sampleId] = run
  }
  for (const line of lines) {
    const record = JSON.parse(line)
    if (!record.sampleId) continue
    const existing = mainResults.findIndex((item) => item.sampleId === record.sampleId)
    if (existing >= 0) mainResults[existing] = record
    else mainResults.push(record)
  }
}

if (!mainManifest) {
  throw new Error('no shards found to merge')
}
// 保持 sampleIds 顺序
mainResults.sort((a, b) => {
  const ia = selectedIds.indexOf(a.sampleId)
  const ib = selectedIds.indexOf(b.sampleId)
  return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib)
})

await writeFile(
  path.join(outputDir, 'manifest.json'),
  `${JSON.stringify(mainManifest, null, 2)}\n`,
  'utf8',
)
await writeFile(
  path.join(outputDir, 'results.jsonl'),
  `${mainResults.map((item) => JSON.stringify(item)).join('\n')}\n`,
  'utf8',
)
console.log(
  `merged: ${mainResults.length}/${selectedIds.length} results -> ${path.join(outputDir, 'results.jsonl')}`,
)
