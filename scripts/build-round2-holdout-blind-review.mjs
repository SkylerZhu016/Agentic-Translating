import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve('FSBP_Test')
const outputDir = path.join(root, 'private', 'round-02', 'holdout-v1')
const salt = 'agentic-translating-round2-untouched-holdout-v1'
const diagnosticIds = new Set([
  'test-en-zh-hopkins-pied-beauty',
  'test-en-zh-jerome-sea-trip',
  'test-en-zh-lovelace-engine-limits',
  'test-zh-en-sushi-shuidiaogetou',
  'test-zh-en-wanganshi-reform-defense',
])

const sha256 = (value) =>
  createHash('sha256').update(value, 'utf8').digest('hex')

async function readJsonl(filePath) {
  return (await readFile(filePath, 'utf8'))
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

const samples = (await readJsonl(
  path.join(root, 'datasets', 'quality-test.jsonl'),
)).filter((sample) => !diagnosticIds.has(sample.id))
const baselines = await readJsonl(
  path.join(root, 'private', 'review', 'test-round-01.jsonl'),
)
const results = await readJsonl(path.join(outputDir, 'holdout-results.jsonl'))

if (samples.length !== 11 || results.length < 1 || results.length > 11) {
  throw new Error(
    `Untouched holdout must contain 11 samples and 1-11 completed results; got ${samples.length}/${results.length}.`,
  )
}

const sampleById = new Map(samples.map((sample) => [sample.id, sample]))
const baselineById = new Map(
  baselines.map((baseline) => [baseline.sampleId, baseline]),
)
const resultById = new Map(results.map((result) => [result.sampleId, result]))
const completedSamples = samples.filter((sample) => resultById.has(sample.id))
const failedSampleIds = samples
  .filter((sample) => !resultById.has(sample.id))
  .map((sample) => sample.id)
const mapping = {
  reviewId: `round2-untouched-holdout-${new Date().toISOString()}`,
  createdAt: new Date().toISOString(),
  saltSha256: sha256(salt),
  disclosure:
    `${completedSamples.length} of eleven untouched samples produced a formal FSBP version and are included in this quality comparison. Workflow failures are reported separately.`,
  expectedSampleCount: 11,
  completedSampleCount: completedSamples.length,
  failedSampleIds,
  pairs: [],
}
const sections = [
  '# 第二轮未调参留出集匿名 A/B 评审',
  '',
  '按照 `FSBP_Test/rubrics/translation-quality.md` 独立评审。',
  '不得推测模型、Agent、协议或文本来源。先核对原文和任务要求，再分别评估 A、B。',
  '',
]

for (const [index, sample] of completedSamples.entries()) {
  const result = resultById.get(sample.id)
  const baseline = baselineById.get(sample.id)
  if (!result?.text?.trim() || !baseline?.body?.trim()) {
    throw new Error(`${sample.id}: FSBP result or direct baseline missing`)
  }
  const fsbpFirst =
    Number.parseInt(sha256(`${salt}:${sample.id}`).slice(0, 2), 16) % 2 === 0
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
    sampleId: sample.id,
    A: fsbpFirst ? 'fsbp-round2-v10' : 'gpt56-direct-reviewed',
    B: fsbpFirst ? 'gpt56-direct-reviewed' : 'fsbp-round2-v10',
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
  '1. 每项分别给出 A、B 的忠实度、自然度、文体与声音、结构或形式、术语与逻辑、整体质量，使用 1—10 分或 N/A。',
  '2. 对误译、漏译、增译、指代、逻辑、术语、断句与形式问题引用具体片段。',
  '3. 每项给出 `A 胜`、`B 胜` 或 `平局`，并标注高、中、低置信度。',
  '4. 最后只汇总匿名 A/B 胜平负，不接触来源映射。',
  '5. 不修改候选，也不替任何候选补写理由。',
  '',
)

await mkdir(outputDir, { recursive: true })
await writeFile(
  path.join(outputDir, 'holdout-blind-review.md'),
  `${sections.join('\n')}\n`,
  'utf8',
)
await writeFile(
  path.join(outputDir, 'holdout-blind-mapping.json'),
  `${JSON.stringify(mapping, null, 2)}\n`,
  'utf8',
)
process.stdout.write(`Holdout blind review prepared: ${mapping.pairs.length}\n`)
