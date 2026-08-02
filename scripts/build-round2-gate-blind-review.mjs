import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve('FSBP_Test')
const gateRevision = Number(
  process.argv.find((argument) =>
    argument.startsWith('--gate-revision='))?.slice(16) ?? '1',
)
if (![1, 2, 3, 4, 5, 6].includes(gateRevision)) {
  throw new Error('--gate-revision must be 1, 2, 3, 4, 5, or 6')
}
const roundDir = gateRevision === 1
  ? path.join(root, 'private', 'round-02')
  : path.join(
      root,
      'private',
      'round-02',
      `gate-v${gateRevision}`,
    )
const salt = `agentic-translating-round2-gate-v${gateRevision}`

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

async function readJsonl(filePath) {
  return (await readFile(filePath, 'utf8'))
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

const samples = await readJsonl(
  path.join(root, 'datasets', 'quality-test.jsonl'),
)
const baselines = await readJsonl(
  path.join(root, 'private', 'review', 'test-round-01.jsonl'),
)
const gateResults = await readJsonl(path.join(roundDir, 'gate-results.jsonl'))

if (gateResults.length !== 5) {
  throw new Error(`Gate results must contain exactly 5 records; got ${gateResults.length}`)
}

const sampleById = new Map(samples.map((sample) => [sample.id, sample]))
const baselineById = new Map(
  baselines.map((baseline) => [baseline.sampleId, baseline]),
)
const mapping = {
  reviewId: `round2-gate-${new Date().toISOString()}`,
  createdAt: new Date().toISOString(),
  saltSha256: sha256(salt),
  pairs: [],
}
const sections = [
  '# 第二轮五样本匿名 A/B 评审',
  '',
  '请按照 `FSBP_Test/rubrics/translation-quality.md` 独立评分。',
  '不要推测模型、Agent、协议或文本来源。每个样本先检查原文，再分别给 A、B 六个维度评分，最后给出胜者、置信度和可核查证据。平局必须明确写“平局”。',
  '',
]

for (const [index, result] of gateResults.entries()) {
  const sample = sampleById.get(result.sampleId)
  const baseline = baselineById.get(result.sampleId)
  if (!sample || !baseline?.body?.trim()) {
    throw new Error(`${result.sampleId}: source or reviewed baseline missing`)
  }
  const fsbpFirst = Number.parseInt(
    sha256(`${salt}:${result.sampleId}`).slice(0, 2),
    16,
  ) % 2 === 0
  const versionA = fsbpFirst ? result.text : baseline.body
  const versionB = fsbpFirst ? baseline.body : result.text
  const itemNo = index + 1

  sections.push(
    `## 样本 ${itemNo}`,
    '',
    `方向：${sample.direction === 'en_to_zh' ? '英译中' : '中译英'}`,
    '',
    `类别：${sample.category}`,
    '',
    '### 任务要求',
    '',
    sample.taskBrief?.trim() || '无额外要求',
    '',
    '### 原文',
    '',
    sample.sourceText,
    '',
    '### 译文 A',
    '',
    versionA,
    '',
    '### 译文 B',
    '',
    versionB,
    '',
  )
  mapping.pairs.push({
    itemNo,
    sampleId: result.sampleId,
    A: fsbpFirst ? 'fsbp-round2' : 'gpt-direct-reviewed',
    B: fsbpFirst ? 'gpt-direct-reviewed' : 'fsbp-round2',
    sourceTextSha256: sha256(sample.sourceText),
    translationASha256: sha256(versionA),
    translationBSha256: sha256(versionB),
    fsbpSessionId: result.sessionId,
    fsbpFinalVersionId: result.finalVersionId,
  })
}

sections.push(
  '## 评审输出要求',
  '',
  '1. 每个样本分别列出 A、B 的忠实度、自然度、文体与声音、结构或形式、术语与逻辑、整体质量，使用 1—10 分或 N/A。',
  '2. 对确定的误译、漏译、增译、指代、逻辑、术语、断句与形式问题引用具体片段。',
  '3. 每个样本给出 `A 胜`、`B 胜` 或 `平局`，并给出高、中、低置信度。',
  '4. 最后汇总 A/B 胜平负，不接触来源映射。',
  '5. 不修改候选，不为任何候选补写理由。',
  '',
)

await mkdir(roundDir, { recursive: true })
await writeFile(
  path.join(roundDir, 'gate-blind-review.md'),
  `${sections.join('\n')}\n`,
  'utf8',
)
await writeFile(
  path.join(roundDir, 'gate-blind-mapping.json'),
  `${JSON.stringify(mapping, null, 2)}\n`,
  'utf8',
)
console.log(`Blind review prepared: ${mapping.pairs.length} pairs`)
