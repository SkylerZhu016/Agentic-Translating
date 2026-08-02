import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--run') result.runId = argv[++index]
    else if (token === '--seed') result.seed = argv[++index]
    else throw new Error(`Unknown argument: ${token}`)
  }
  if (!result.runId) {
    throw new Error(
      'Usage: node scripts/prepare-fsbp-blind-review.mjs --run <run-id> [--seed <seed>]',
    )
  }
  return result
}

async function readJsonl(filePath) {
  return (await readFile(filePath, 'utf8'))
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

function rank(seed, sampleId, condition) {
  return createHash('sha256')
    .update(`${seed}\u0000${sampleId}\u0000${condition}`, 'utf8')
    .digest('hex')
}

function quote(value) {
  return value
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n')
}

const args = parseArgs(process.argv.slice(2))
if (!/^[a-zA-Z0-9._-]+$/.test(args.runId)) {
  throw new Error('Invalid run ID.')
}
const runDir = path.resolve('FSBP_Test', 'results', args.runId)
const finalRecords = await readJsonl(path.join(runDir, 'final.jsonl'))
const samples = await readJsonl(
  path.resolve('FSBP_Test', 'datasets', 'quality-test.jsonl'),
)
const bySample = new Map()
for (const record of finalRecords) {
  const list = bySample.get(record.sampleId) ?? []
  list.push(record)
  bySample.set(record.sampleId, list)
}

const seed = args.seed ?? args.runId
const key = []
const sections = []
for (const [sampleIndex, sample] of samples.entries()) {
  const candidates = bySample.get(sample.id) ?? []
  if (candidates.length !== 3) {
    throw new Error(
      `${sample.id}: expected 3 final candidates, found ${candidates.length}`,
    )
  }
  const conditions = new Set(candidates.map((record) => record.condition))
  for (const required of ['direct', 'multi_raw', 'multi_fsbp']) {
    if (!conditions.has(required)) {
      throw new Error(`${sample.id}: missing ${required}`)
    }
  }
  const shuffled = [...candidates].sort((left, right) =>
    rank(seed, sample.id, left.condition).localeCompare(
      rank(seed, sample.id, right.condition),
    ),
  )
  const labels = ['A', 'B', 'C']
  shuffled.forEach((record, index) => {
    key.push({
      sampleId: sample.id,
      label: labels[index],
      condition: record.condition,
      sourceTaskKey: record.sourceTaskKey,
    })
  })

  sections.push(`## ${sampleIndex + 1}. ${sample.id}

方向：${sample.direction === 'en_to_zh' ? '英译中' : '中译英'}  
类别：${sample.category}

### 原文

${quote(sample.sourceText)}

### 任务要求

${sample.taskBrief}

${shuffled
  .map(
    (record, index) => `### 候选 ${labels[index]}

${quote(record.text)}

| 维度 | 分数（1—10 / N/A） |
|---|---|
| 忠实度 | |
| 自然度 | |
| 文体与声音 | |
| 结构或形式 | |
| 术语与逻辑 | |
| 整体质量 | |

- 具体依据：
- 置信度：
`,
  )
  .join('\n')}
### 本样本排序

- 排序：
- 并列：
- 总体理由：

---`)
}

const markdown = `# FSBP 质量实验盲评稿

运行：${args.runId}  
评审者：internal-human  
评审人数：n=1  
状态：待审  

候选顺序已经随机化。评审时不得打开同目录的 \`blind-key.json\`，也不要根据文风
猜测模型或条件。评分准则见 \`FSBP_Test/rubrics/translation-quality.md\`。

${sections.join('\n\n')}
`

await mkdir(runDir, { recursive: true })
await writeFile(
  path.join(runDir, 'blind-review.md'),
  markdown,
  'utf8',
)
await writeFile(
  path.join(runDir, 'blind-key.json'),
  `${JSON.stringify({ runId: args.runId, seed, key }, null, 2)}\n`,
  'utf8',
)
process.stdout.write(
  `Prepared blind review: ${samples.length} samples, ${key.length} candidates.\n`,
)
