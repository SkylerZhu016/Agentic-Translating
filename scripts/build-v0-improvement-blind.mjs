// 构建"对话修订最终版 vs 同工作流 v0"匿名评审包
// 用法：node scripts/build-v0-improvement-blind.mjs --round=FSBP_Test/private/round-03/<dir>
// 输出：blind-review-v0.md + blind-mapping-v0.json（评委只读前者）
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const roundDir = path.resolve(
  process.argv.find((a) => a.startsWith('--round='))?.slice(8) ??
    path.join('FSBP_Test', 'private', 'round-03', 'guided-revision-v14-2turn-valid4'),
)

const sha256 = (v) => createHash('sha256').update(v, 'utf8').digest('hex')

const manifest = JSON.parse(await readFile(path.join(roundDir, 'manifest.json'), 'utf8'))
const salt =
  process.argv.find((a) => a.startsWith('--salt='))?.slice(7) ??
  `agentic-translating:v0-improvement:${manifest.experimentId}`
const lines = (await readFile(path.join(roundDir, 'results.jsonl'), 'utf8'))
  .split(/\r?\n/)
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))
const results = lines.filter((r) => r.status === 'complete')
const failed = lines.filter((r) => r.status !== 'complete')

const mapping = {
  reviewId: `${manifest.experimentId}-v0-blind-${new Date().toISOString()}`,
  createdAt: new Date().toISOString(),
  saltSha256: sha256(salt),
  pairs: [],
}
const sections = [
  '# 对话修订改善验证：匿名开发诊断',
  '',
  '请仅依据本文件评审。候选来源、版本号、反馈内容和修改次数均已隐藏。',
  '',
  '本次目的仅为判断：对话修订后的文本是否比同一工作流的初始正式版本更好。它不是 GPT 直译对照，也不构成未见集泛化证据。',
  '',
  '逐项比较候选 A 与候选 B，并分别给出以下六个维度的 1—10 分：忠实度、自然度、文体与声音、结构或形式、术语与逻辑、整体质量。每项必须给出 A 胜、B 胜或平局，并说明能够从原文、任务要求和候选正文直接核验的理由。不要推测候选来源。',
  '',
]
if (failed.length) {
  sections.push(
    `注意：以下 ${failed.length} 个样本工作流失败，未产生正式成品，本次不纳入比较（另行记录）：`,
    '',
    ...failed.map((r) => `- ${r.sampleId}：${r.error ?? '未知错误'}`),
    '',
  )
}
for (const [index, result] of results.entries()) {
  const v0 = result.versions[0]?.text
  const final = result.versions.at(-1)?.text
  if (!v0 || !final) {
    throw new Error(`${result.sampleId}: missing v0 or final text`)
  }
  const finalFirst = Number.parseInt(sha256(`${salt}:${result.sampleId}`).slice(0, 2), 16) % 2 === 0
  const a = finalFirst ? final : v0
  const b = finalFirst ? v0 : final
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
    a,
    '',
    '### 译文 B',
    '',
    b,
    '',
  )
  mapping.pairs.push({
    itemNo,
    sampleId: result.sampleId,
    A: finalFirst ? 'fsbp-chat-final' : 'fsbp-v0',
    B: finalFirst ? 'fsbp-v0' : 'fsbp-chat-final',
    sourceTextSha256: sha256(result.sourceText),
    translationASha256: sha256(a),
    translationBSha256: sha256(b),
    fsbpSessionId: result.sessionId,
    fsbpV0VersionId: result.versions[0].versionId,
    fsbpFinalVersionId: result.versions.at(-1).versionId,
    rounds: result.versions.length - 1,
  })
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
  '最后汇总 A/B 胜平负。平局必须保留。不要修改任何候选，也不要接触来源映射文件。',
  '',
)
await writeFile(path.join(roundDir, 'blind-review-v0.md'), `${sections.join('\n')}\n`, 'utf8')
await writeFile(path.join(roundDir, 'blind-mapping-v0.json'), `${JSON.stringify(mapping, null, 2)}\n`, 'utf8')
console.log(`V0 blind review prepared: ${mapping.pairs.length} pairs (${failed.length} failed excluded)`)
