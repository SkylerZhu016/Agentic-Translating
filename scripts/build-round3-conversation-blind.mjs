import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const roundDir = path.resolve(
  process.argv.find((argument) => argument.startsWith('--round='))?.slice(8) ??
  path.join('FSBP_Test', 'private', 'round-03', 'dev-conversation-v1'),
)

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

async function readJsonl(filePath) {
  return (await readFile(filePath, 'utf8'))
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

const manifest = JSON.parse(await readFile(path.join(roundDir, 'manifest.json'), 'utf8'))
const expectedCount = Number(manifest.expectedCount ?? manifest.sampleIds?.length ?? 5)
const salt = process.argv.find((argument) => argument.startsWith('--salt='))?.slice(7) ??
  `agentic-translating:${manifest.experimentId}`
const results = await readJsonl(path.join(roundDir, 'results.jsonl'))
if (
  results.length !== expectedCount ||
  results.some((item) => !['complete', 'failed'].includes(item.status))
) {
  throw new Error(
    `${expectedCount} terminal records are required; received ${results.length}`,
  )
}

const mapping = {
  reviewId: `${manifest.experimentId}-blind-${new Date().toISOString()}`,
  createdAt: new Date().toISOString(),
  saltSha256: sha256(salt),
  pairs: [],
}
const sections = [
  `# ${manifest.blindReviewTitle ?? '第三轮匿名 A/B 评审'}`,
  '',
  manifest.blindReviewIntroduction ??
    '请独立比较译文，不推测模型、Agent、协议或文本来源。',
  '',
  '评分维度均为 1—10 分：忠实度、自然度、文体与声音、结构或形式、术语与逻辑、整体质量。若某维度不适用，可写 N/A。先核对原文和任务要求，再读 A、B；不要因为解释更长或用词更华丽而加分。',
  '',
]

for (const [index, result] of results.entries()) {
  const fsbpLabel = `fsbp-v${result.promptBundleVersion}-chat-v3`
  const fsbpFirst = Number.parseInt(
    sha256(`${salt}:${result.sampleId}`).slice(0, 2),
    16,
  ) % 2 === 0
  const fsbpText = result.status === 'complete'
    ? result.finalText
    : '[工作流失败，未产生成品。系统级计分中该项判为直译获胜。]'
  const versionA = fsbpFirst ? fsbpText : result.directText
  const versionB = fsbpFirst ? result.directText : fsbpText
  const itemNo = index + 1
  sections.push(
    `## 样本 ${itemNo}`,
    '',
    `方向：${result.direction === 'en_to_zh' ? '英译中' : '中译英'}`,
    '',
    `类别：${result.category}`,
    '',
    '### 任务要求',
    '',
    result.taskBrief?.trim() || '无额外要求',
    '',
    '### 原文',
    '',
    result.sourceText,
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
    A: fsbpFirst ? fsbpLabel : 'gpt-direct-reviewed',
    B: fsbpFirst ? 'gpt-direct-reviewed' : fsbpLabel,
    sourceTextSha256: sha256(result.sourceText),
    translationASha256: sha256(versionA),
    translationBSha256: sha256(versionB),
    fsbpSessionId: result.sessionId,
    fsbpFinalVersionId: result.versions.at(-1)?.versionId ?? null,
    workflowStatus: result.status,
  })
}

for (const pair of mapping.pairs) {
  if (pair.A === 'gpt-direct-reviewed') pair.A = manifest.directBaselineLabel ?? 'gpt-direct-reviewed'
  if (pair.B === 'gpt-direct-reviewed') pair.B = manifest.directBaselineLabel ?? 'gpt-direct-reviewed'
}

sections.push(
  '## 输出要求',
  '',
  '对每个样本分别给出：',
  '',
  '1. A、B 六个维度的分数；',
  '2. 可核查的优点和问题，引用具体短语并回指原文；',
  '3. A 胜、B 胜或平局；',
  '4. 高、中或低置信度；',
  '5. 一段简短裁决理由。',
  '',
  '最后汇总 A/B 胜平负。平局必须保留，工作流失败按直译获胜。不要修改任何候选，也不要接触来源映射文件。',
  '',
)

await writeFile(
  path.join(roundDir, 'blind-review.md'),
  `${sections.join('\n')}\n`,
  'utf8',
)
await writeFile(
  path.join(roundDir, 'blind-mapping.json'),
  `${JSON.stringify(mapping, null, 2)}\n`,
  'utf8',
)
await writeFile(
  path.join(roundDir, 'trajectory-audit.json'),
  `${JSON.stringify(results.map((item) => ({
    sampleId: item.sampleId,
    sessionId: item.sessionId,
    status: item.status,
    error: item.error ?? null,
    versions: item.versions.map((version) => ({
      round: version.round,
      versionId: version.versionId,
      versionNo: version.versionNo,
      textSha256: version.textSha256,
      patchCount: version.patchCount,
      changed: version.changed ?? true,
    })),
  })), null, 2)}\n`,
  'utf8',
)

console.log(`Blind review prepared: ${mapping.pairs.length} pairs`)
