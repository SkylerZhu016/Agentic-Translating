import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const gateDir = path.resolve(
  'FSBP_Test',
  'private',
  'round-02',
  'gate-v4',
)
const ablationDir = path.join(gateDir, 'annotation-ablation')
const resultsPath = path.join(ablationDir, 'annotation-ablation-results.jsonl')
const blindPath = path.join(ablationDir, 'annotation-ablation-blind.md')
const mappingPath = path.join(ablationDir, 'annotation-ablation-mapping.json')
const salt = 'agentic-translating-round2-gate-v4-annotation-ablation'

async function readJsonl(filePath) {
  return (await readFile(filePath, 'utf8'))
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

function chooseFirst(sampleId) {
  const digest = createHash('sha256')
    .update(`${salt}:${sampleId}`, 'utf8')
    .digest()
  return digest[0] % 2 === 0 ? 'body_only' : 'body_and_annotation'
}

const samples = await readJsonl(
  path.resolve('FSBP_Test', 'datasets', 'quality-test.jsonl'),
)
const results = await readJsonl(resultsPath)
if (results.length < 3 || results.length > 5) {
  throw new Error(
    `Expected three to five comparable ablation results, found ${results.length}`,
  )
}
const sampleById = new Map(samples.map((sample) => [sample.id, sample]))
const mapping = {}
const sections = [
  '# FSBP 候选注释可见性消融 · 匿名 A/B',
  '',
  '请依据原文、任务要求和统一翻译质量量表，逐项比较译文 A 与译文 B。',
  '两份译文复用完全相同的候选，只重跑审查、筛选、编排和组装。',
  '平局可以成立；请列出足以改变胜负的具体文本证据。',
]

for (const [index, result] of results.entries()) {
  const sample = sampleById.get(result.sampleId)
  if (!sample) throw new Error(`${result.sampleId}: locked sample missing`)
  const first = chooseFirst(result.sampleId)
  const second =
    first === 'body_only' ? 'body_and_annotation' : 'body_only'
  const textFor = (source) =>
    source === 'body_only'
      ? result.bodyOnly.text
      : result.bodyAndAnnotation.text
  mapping[result.sampleId] = {
    A: first,
    B: second,
    candidateInvocationIds: result.candidateInvocationIds,
    candidateAnnotationCount: result.candidateAnnotationCount,
    candidateAnnotationChars: result.candidateAnnotationChars,
  }
  sections.push(
    '',
    `## ${index + 1}. ${result.sampleId}`,
    '',
    `方向：${result.direction}`,
    `类别：${result.category}`,
    '',
    '### 任务要求',
    '',
    sample.taskBrief || '无额外要求',
    '',
    '### 原文',
    '',
    sample.sourceText,
    '',
    '### 译文 A',
    '',
    textFor(first),
    '',
    '### 译文 B',
    '',
    textFor(second),
  )
}

await mkdir(ablationDir, { recursive: true })
await writeFile(blindPath, `${sections.join('\n')}\n`, 'utf8')
await writeFile(
  mappingPath,
  `${JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      saltSha256: createHash('sha256').update(salt).digest('hex'),
      mapping,
    },
    null,
    2,
  )}\n`,
  'utf8',
)
process.stdout.write(
  `Annotation ablation blind review prepared: ${results.length} pairs\n`,
)
