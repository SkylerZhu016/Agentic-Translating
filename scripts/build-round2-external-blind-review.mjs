import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const outputDir = path.resolve(
  'FSBP_Test',
  'private',
  'round-02',
  'external-holdout-v1',
)
const salt = 'agentic-translating-round2-external-holdout-v1'
const sha256 = (value) =>
  createHash('sha256').update(value, 'utf8').digest('hex')

async function readJsonl(filePath) {
  return (await readFile(filePath, 'utf8'))
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

const samples = await readJsonl(path.join(outputDir, 'external-holdout.jsonl'))
const baselines = await readJsonl(
  path.join(outputDir, 'direct-gpt56-xhigh.jsonl'),
)
const results = await readJsonl(path.join(outputDir, 'holdout-results.jsonl'))
if (
  samples.length !== 8 ||
  baselines.length !== 8 ||
  results.length < 1 ||
  results.length > 8
) {
  throw new Error(
    `External holdout requires 8 samples/baselines and 1-8 completed results; got ${samples.length}/${baselines.length}/${results.length}.`,
  )
}

const baselineById = new Map(
  baselines.map((baseline) => [baseline.sampleId, baseline]),
)
const resultById = new Map(results.map((result) => [result.sampleId, result]))
const completedSamples = samples.filter((sample) => resultById.has(sample.id))
const failedSampleIds = samples
  .filter((sample) => !resultById.has(sample.id))
  .map((sample) => sample.id)
const mapping = {
  reviewId: `round2-external-holdout-${new Date().toISOString()}`,
  createdAt: new Date().toISOString(),
  saltSha256: sha256(salt),
  disclosure:
    `${completedSamples.length} of eight frozen external samples produced a formal FSBP version and are included in this quality comparison. Workflow failures are reported separately.`,
  expectedSampleCount: 8,
  completedSampleCount: completedSamples.length,
  failedSampleIds,
  pairs: [],
}
const sections = [
  '# 第二轮全新外部留出集匿名 A/B 评审',
  '',
  '按照 `FSBP_Test/rubrics/translation-quality.md` 独立评审。',
  '不得推测模型、Agent、协议或文本来源。先核对原文和任务要求，再分别评估 A、B。',
  '',
]

for (const [index, sample] of completedSamples.entries()) {
  const result = resultById.get(sample.id)
  const baseline = baselineById.get(sample.id)
  if (!result?.text?.trim() || !baseline?.translation?.trim()) {
    throw new Error(`${sample.id}: FSBP result or direct baseline missing`)
  }
  const fsbpFirst =
    Number.parseInt(sha256(`${salt}:${sample.id}`).slice(0, 2), 16) % 2 === 0
  const versionA = fsbpFirst ? result.text : baseline.translation
  const versionB = fsbpFirst ? baseline.translation : result.text
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
    sample.taskBrief,
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
    A: fsbpFirst ? 'fsbp-round2-v10' : 'gpt56-direct-xhigh',
    B: fsbpFirst ? 'gpt56-direct-xhigh' : 'fsbp-round2-v10',
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

await writeFile(
  path.join(outputDir, 'external-blind-review.md'),
  `${sections.join('\n')}\n`,
  'utf8',
)
await writeFile(
  path.join(outputDir, 'external-blind-mapping.json'),
  `${JSON.stringify(mapping, null, 2)}\n`,
  'utf8',
)
process.stdout.write(`External blind review prepared: ${mapping.pairs.length}\n`)
