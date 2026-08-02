import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

function parseArgs(argv) {
  const options = {
    seed: 'fsbp-b2-blind-v1',
    results: path.resolve(
      'FSBP_Test',
      'private',
      'blind-review',
      'b2-results.jsonl',
    ),
    output: path.resolve('FSBP_Test', 'private', 'blind-review'),
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--seed') options.seed = argv[++index]
    else if (token === '--results') options.results = path.resolve(argv[++index])
    else if (token === '--output') options.output = path.resolve(argv[++index])
    else throw new Error(`Unknown argument: ${token}`)
  }
  return options
}

async function readJsonl(filePath) {
  return (await readFile(filePath, 'utf8'))
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

function hash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function cleanText(value) {
  return value.trim().replace(/\r\n?/g, '\n')
}

const options = parseArgs(process.argv.slice(2))
const datasetPath = path.resolve(
  'FSBP_Test',
  'datasets',
  'quality-test.jsonl',
)
const baselinePath = path.resolve(
  'FSBP_Test',
  'private',
  'review',
  'test-round-01.jsonl',
)

const samples = await readJsonl(datasetPath)
const baselines = await readJsonl(baselinePath)
const b2Results = await readJsonl(options.results)

if (samples.length !== 16) {
  throw new Error(`Expected 16 locked samples, found ${samples.length}.`)
}

const baselineById = new Map(
  baselines.map((record) => [record.sampleId, record]),
)
const b2ById = new Map(b2Results.map((record) => [record.sampleId, record]))
if (baselineById.size !== 16 || b2ById.size !== 16) {
  throw new Error(
    `Expected 16 unique baseline and B-2 records, found ${baselineById.size} and ${b2ById.size}.`,
  )
}

const ranked = [...samples]
  .map((sample) => ({
    sampleId: sample.id,
    rank: hash(`${options.seed}\u0000${sample.id}`),
  }))
  .sort((left, right) => left.rank.localeCompare(right.rank))
const agentInA = new Set(
  ranked.slice(0, samples.length / 2).map((record) => record.sampleId),
)

const keyEntries = []
const sections = []
for (const [index, sample] of samples.entries()) {
  const baseline = baselineById.get(sample.id)
  const b2 = b2ById.get(sample.id)
  if (!baseline?.body?.trim()) {
    throw new Error(`${sample.id}: reviewed direct translation is empty.`)
  }
  if (baseline.humanReview?.status !== 'reviewed') {
    throw new Error(`${sample.id}: direct translation was not marked reviewed.`)
  }
  if (!b2?.text?.trim() || !b2?.sessionId) {
    throw new Error(`${sample.id}: B-2 result is incomplete.`)
  }

  const candidates = {
    direct: {
      source: 'direct',
      translator: 'GPT 5.6 Sol Extra High',
      text: baseline.body.trim(),
    },
    agent: {
      source: 'agentic_b2',
      translator: 'Agentic Translating B-2 · FSBP v2',
      text: b2.text.trim(),
    },
  }
  const a = agentInA.has(sample.id) ? candidates.agent : candidates.direct
  const b = agentInA.has(sample.id) ? candidates.direct : candidates.agent

  sections.push(`样本 ${String(index + 1).padStart(2, '0')}

【原文】
${cleanText(sample.sourceText)}

【译文 A】
${cleanText(a.text)}

【译文 B】
${cleanText(b.text)}`)

  keyEntries.push({
    sampleNo: index + 1,
    sampleId: sample.id,
    direction: sample.direction,
    category: sample.category,
    sourceTextSha256: hash(sample.sourceText),
    b2SessionId: b2.sessionId,
    A: {
      source: a.source,
      translator: a.translator,
    },
    B: {
      source: b.source,
      translator: b.translator,
    },
  })
}

const blindText = `FSBP 双译文盲审材料

${sections.join('\n\n====================\n\n')}
`
const key = {
  blindSetId: 'fsbp-b2-blind-v1',
  seed: options.seed,
  assignment: 'SHA-256 seeded rank, balanced 8 agent-in-A and 8 agent-in-B',
  directTranslator: 'GPT 5.6 Sol Extra High',
  agentWorkflow: {
    name: 'Agentic Translating B-2',
    protocol: 'FSBP v2',
    formalCandidateModel: 'DeepSeek V4 Flash',
    contextAnalysisModels: ['GLM 5.2', 'Kimi K2.6'],
    orchestrationModel: 'GLM 5.2',
    reviewMode: 'four_stage',
  },
  entries: keyEntries,
}

await mkdir(options.output, { recursive: true })
await writeFile(
  path.join(options.output, 'blind-pairs.txt'),
  blindText,
  'utf8',
)
await writeFile(
  path.join(options.output, 'blind-key.json'),
  `${JSON.stringify(key, null, 2)}\n`,
  'utf8',
)
process.stdout.write(
  `Prepared ${samples.length} blind pairs in ${options.output}; agent appears as A in ${agentInA.size} samples.\n`,
)
