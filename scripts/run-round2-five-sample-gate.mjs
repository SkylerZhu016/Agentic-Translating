import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const apiBase = (
  process.argv.find((argument) => argument.startsWith('--base='))?.slice(7) ??
  'http://127.0.0.1:3000'
).replace(/\/+$/, '')
const gateRevision = Number(
  process.argv.find((argument) =>
    argument.startsWith('--gate-revision='))?.slice(16) ?? '1',
)
if (![1, 2, 3, 4].includes(gateRevision)) {
  throw new Error('--gate-revision must be 1, 2, 3, or 4')
}
const expectedPromptBundleVersion =
  gateRevision === 1 ? 7 : gateRevision === 2 ? 8 : 9
const outputDir = gateRevision === 1
  ? path.resolve('FSBP_Test', 'private', 'round-02')
  : path.resolve(
      'FSBP_Test',
      'private',
      'round-02',
      `gate-v${gateRevision}`,
    )
const manifestPath = path.join(outputDir, 'gate-manifest.json')
const resultsPath = path.join(outputDir, 'gate-results.jsonl')
const selectedIds = [
  'test-en-zh-hopkins-pied-beauty',
  'test-en-zh-jerome-sea-trip',
  'test-en-zh-lovelace-engine-limits',
  'test-zh-en-sushi-shuidiaogetou',
  'test-zh-en-wanganshi-reform-defense',
]

const categoryLabel = {
  poetry: '诗歌',
  literary: '文学',
  cultural_argument: '文化论辩',
  nonliterary: '非文学',
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

async function readJsonl(filePath) {
  return (await readFile(filePath, 'utf8'))
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

async function api(url, init) {
  const method = init?.method?.toUpperCase() ?? 'GET'
  const maxAttempts = method === 'GET' ? 5 : 1
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(`${apiBase}${url}`, init)
    const payload = await response.json().catch(() => null)
    if (response.ok) return payload
    const transientReadFailure =
      method === 'GET' &&
      (response.status === 404 || response.status >= 500) &&
      attempt < maxAttempts
    if (!transientReadFailure) {
      throw new Error(
        `${response.status} ${url}: ${JSON.stringify(payload ?? {})}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 1_000))
  }
  throw new Error(`${method} ${url}: retry loop exhausted`)
}

async function findBasePreset(sample) {
  const presets = await api(
    `/api/workflow-presets?direction=${sample.direction}`,
  )
  const suffix = categoryLabel[sample.category]
  const preset = presets.find(
    (item) => item.name ===
      `FSBP B-2 ${sample.direction === 'en_to_zh' ? '英译中' : '中译英'}·${suffix}`,
  )
  if (!preset) throw new Error(`${sample.id}: B-2 preset not found`)
  const detail = await api(
    `/api/workflow-presets/${encodeURIComponent(preset.id)}`,
  )
  const revision = detail.revisions.find(
    (item) => item.revisionNo === preset.currentRevisionNo,
  )
  if (!revision) throw new Error(`${sample.id}: current preset revision missing`)
  if (
    revision.contract.promptBundleVersion !== expectedPromptBundleVersion ||
    revision.contract.defaultWorkerBinding?.model !== 'DeepSeek V4 Pro: Go'
  ) {
    throw new Error(`${sample.id}: B-2 preset has not been upgraded for round 2`)
  }
  return revision
}

async function createGatePreset(sample, baseRevision) {
  const name =
    `Round2 Gate r${gateRevision} prompt-v${expectedPromptBundleVersion} · ${sample.id}`
  const existing = (
    await api(`/api/workflow-presets?direction=${sample.direction}`)
  ).find((item) => item.name === name)
  if (existing) {
    const detail = await api(
      `/api/workflow-presets/${encodeURIComponent(existing.id)}`,
    )
    const revision = detail.revisions.find(
      (item) => item.revisionNo === existing.currentRevisionNo,
    )
    return { preset: existing, revision }
  }
  return api('/api/workflow-presets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      description:
        '第二轮五样本门禁专用冻结契约；批次完成后软删除，历史继续保留快照。',
      direction: sample.direction,
      contract: {
        ...baseRevision.contract,
        taskBriefTemplate: sample.taskBrief,
      },
    }),
  })
}

async function waitBatch(batchId, sampleId) {
  let lastStatus = ''
  for (;;) {
    const detail = await api(`/api/batches/${batchId}`)
    const status = detail.batch.status
    const item = detail.items[0]
    const summary = `${status}/${item?.status ?? 'missing'}`
    if (summary !== lastStatus) {
      process.stdout.write(`${sampleId}: ${summary}\n`)
      lastStatus = summary
    } else {
      process.stdout.write(`${sampleId}: waiting ${new Date().toISOString()}\n`)
    }
    if (['completed', 'failed', 'cancelled'].includes(status)) return detail
    await new Promise((resolve) => setTimeout(resolve, 20_000))
  }
}

await mkdir(outputDir, { recursive: true })
const allSamples = await readJsonl(
  path.resolve('FSBP_Test', 'datasets', 'quality-test.jsonl'),
)
const baselines = await readJsonl(
  path.resolve('FSBP_Test', 'private', 'review', 'test-round-01.jsonl'),
)
const sampleById = new Map(allSamples.map((sample) => [sample.id, sample]))
const baselineById = new Map(
  baselines.map((baseline) => [baseline.sampleId, baseline]),
)
const samples = selectedIds.map((id) => {
  const sample = sampleById.get(id)
  if (!sample) throw new Error(`${id}: locked sample missing`)
  const baseline = baselineById.get(id)
  if (!baseline?.body?.trim() || baseline.humanReview?.status !== 'reviewed') {
    throw new Error(`${id}: reviewed direct baseline missing`)
  }
  return sample
})

let manifest
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (
    JSON.stringify(manifest.sampleIds) !== JSON.stringify(selectedIds) ||
    manifest.promptBundleVersion !== expectedPromptBundleVersion ||
    manifest.agentPromptVersion !== 8
  ) {
    throw new Error('Existing gate manifest does not match the locked selection')
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
  manifest = {
    gateId:
      `round2-five-sample-prompt-v${expectedPromptBundleVersion}-` +
      new Date().toISOString(),
    createdAt: new Date().toISOString(),
    frozenBeforeGeneration: true,
    passRule: 'FSBP must win at least 4 of 5; ties do not count',
    judgeSeesSources: false,
    promptBundleVersion: expectedPromptBundleVersion,
    agentPromptVersion: 8,
    workflow: 'B-2 fixed three-role candidates plus four independent stages',
    models: {
      contextAnalysis: ['DeepSeek V4 Pro: Go', 'Kimi K2.6: Go'],
      candidates: 'DeepSeek V4 Pro: Go',
      main: 'GLM 5.2: Go',
      review: 'Kimi K2.6: Go',
      filter: 'GLM 5.2: Go',
      orchestrate: 'Kimi K2.6: Go',
      assemble: 'DeepSeek V4 Pro: Go',
    },
    stageMaxTokens: 131_072,
    stageIdleTimeoutMs: gateRevision >= 4 ? 20 * 60_000 : null,
    stageMaxDurationMs: gateRevision >= 4 ? 90 * 60_000 : null,
    sampleIds: selectedIds,
    samples: samples.map((sample) => ({
      id: sample.id,
      direction: sample.direction,
      category: sample.category,
      sourceTextSha256: sha256(sample.sourceText),
      baselineSha256: sha256(baselineById.get(sample.id).body),
    })),
    runs: {},
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

const completed = []
try {
  completed.push(...await readJsonl(resultsPath))
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
const completedIds = new Set(completed.map((record) => record.sampleId))

for (const sample of samples) {
  if (completedIds.has(sample.id)) {
    process.stdout.write(`${sample.id}: result already complete\n`)
    continue
  }
  const baseRevision = await findBasePreset(sample)
  const gatePreset = await createGatePreset(sample, baseRevision)
  const revision = gatePreset.revision
  if (!revision?.id) throw new Error(`${sample.id}: gate revision missing`)
  let batchId = manifest.runs[sample.id]?.batchId
  if (!batchId) {
    const created = await api('/api/batches', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `Round2 Gate · ${sample.id}`,
        presetRevisionId: revision.id,
        concurrency: 1,
        files: [
          {
            relativePath: `${sample.id}.md`,
            sourceText: sample.sourceText,
            originalLineEnding: 'lf',
            hadBom: false,
          },
        ],
      }),
    })
    batchId = created.id
    manifest.runs[sample.id] = {
      batchId,
      gatePresetId: gatePreset.preset.id,
      presetRevisionId: revision.id,
    }
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    )
  }
  const batch = await waitBatch(batchId, sample.id)
  const item = batch.items[0]
  if (item?.status !== 'completed' || !item.session_id) {
    throw new Error(
      `${sample.id}: batch failed: ${item?.error ?? batch.batch.error ?? 'unknown'}`,
    )
  }
  const session = await api(`/api/sessions/${item.session_id}`)
  if (!session.finalVersion?.text?.trim()) {
    throw new Error(`${sample.id}: completed batch has no formal final version`)
  }
  const record = {
    sampleId: sample.id,
    direction: sample.direction,
    category: sample.category,
    batchId,
    sessionId: item.session_id,
    presetRevisionId: revision.id,
    finalVersionId: session.finalVersion.id,
    text: session.finalVersion.text,
    textSha256: sha256(session.finalVersion.text),
    completedAt: new Date().toISOString(),
  }
  completed.push(record)
  await writeFile(
    resultsPath,
    `${completed.map((item) => JSON.stringify(item)).join('\n')}\n`,
    'utf8',
  )
  try {
    await api(
      `/api/workflow-presets/${encodeURIComponent(gatePreset.preset.id)}`,
      { method: 'DELETE' },
    )
  } catch (error) {
    process.stderr.write(
      `${sample.id}: result saved; temporary preset cleanup failed: ` +
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
  }
  process.stdout.write(`${sample.id}: saved ${record.sessionId}\n`)
}

process.stdout.write(`Round 2 gate generation complete: ${completed.length}/5\n`)
