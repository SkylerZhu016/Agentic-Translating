import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const apiBase = (
  process.argv.find((argument) => argument.startsWith('--base='))?.slice(7) ??
  'http://127.0.0.1:3000'
).replace(/\/+$/, '')
const externalMode = process.argv.includes('--external')
const concurrency = 2
const outputDir = externalMode
  ? path.resolve(
      'FSBP_Test',
      'private',
      'round-02',
      'external-holdout-v1',
    )
  : path.resolve('FSBP_Test', 'private', 'round-02', 'holdout-v1')
const manifestPath = path.join(outputDir, 'holdout-manifest.json')
const resultsPath = path.join(outputDir, 'holdout-results.jsonl')
const diagnosticIds = new Set([
  'test-en-zh-hopkins-pied-beauty',
  'test-en-zh-jerome-sea-trip',
  'test-en-zh-lovelace-engine-limits',
  'test-zh-en-sushi-shuidiaogetou',
  'test-zh-en-wanganshi-reform-defense',
])
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
    if (
      method === 'GET' &&
      (response.status === 404 || response.status >= 500) &&
      attempt < maxAttempts
    ) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000))
      continue
    }
    throw new Error(
      `${response.status} ${url}: ${JSON.stringify(payload ?? {})}`,
    )
  }
  throw new Error(`${method} ${url}: retry loop exhausted`)
}

async function baseRevisionFor(sample) {
  const presets = await api(
    `/api/workflow-presets?direction=${sample.direction}`,
  )
  const expectedName =
    `FSBP B-2 ${sample.direction === 'en_to_zh' ? '英译中' : '中译英'}·` +
    categoryLabel[sample.category]
  const preset = presets.find((item) => item.name === expectedName)
  if (!preset) throw new Error(`${sample.id}: B-2 preset missing`)
  const detail = await api(
    `/api/workflow-presets/${encodeURIComponent(preset.id)}`,
  )
  const revision = detail.revisions.find(
    (item) => item.revisionNo === preset.currentRevisionNo,
  )
  if (!revision) throw new Error(`${sample.id}: current preset revision missing`)
  const contract = revision.contract
  if (
    contract.promptBundleVersion !== 10 ||
    contract.defaultWorkerBinding?.model !== 'DeepSeek V4 Pro: Go' ||
    contract.reviewAgentBinding?.model !== 'Kimi K2.6: Go' ||
    contract.filterAgentBinding?.model !== 'GLM 5.2: Go' ||
    contract.orchestrateAgentBinding?.model !== 'Kimi K2.6: Go' ||
    contract.assembleAgentBinding?.model !== 'GLM 5.2: Go' ||
    contract.candidateAnnotationMode !== 'body_only'
  ) {
    throw new Error(`${sample.id}: B-2 preset is not the locked v10 contract`)
  }
  return revision
}

async function createTemporaryPreset(sample, baseRevision) {
  const name =
    `${externalMode ? 'Round2 External Holdout v1' : 'Round2 Holdout v1'} · ` +
    sample.id
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
        '第二轮留出集专用冻结契约；运行后软删除，历史继续保留完整快照。',
      direction: sample.direction,
      contract: {
        ...baseRevision.contract,
        taskBriefTemplate: sample.taskBrief,
      },
    }),
  })
}

async function waitBatch(batchId, sampleId) {
  let last = ''
  for (;;) {
    const detail = await api(`/api/batches/${batchId}`)
    const item = detail.items[0]
    const summary = `${detail.batch.status}/${item?.status ?? 'missing'}`
    if (summary !== last) {
      process.stdout.write(`${sampleId}: ${summary}\n`)
      last = summary
    } else {
      process.stdout.write(`${sampleId}: waiting ${new Date().toISOString()}\n`)
    }
    if (['completed', 'failed', 'cancelled'].includes(detail.batch.status)) {
      return detail
    }
    if (detail.batch.status === 'paused' && item?.session_id) {
      const pausedSession = await api(`/api/sessions/${item.session_id}`)
      const latestRun = (pausedSession.runs ?? []).at(-1)
      const itemFinished = ['completed', 'failed', 'cancelled'].includes(
        item.status,
      )
      if (itemFinished || latestRun?.status === 'interrupted') {
        process.stdout.write(
          `${sampleId}: paused batch contains a recoverable session\n`,
        )
        return detail
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20_000))
  }
}

async function waitSessionRun(sessionId, runId, sampleId) {
  let last = ''
  for (;;) {
    const session = await api(`/api/sessions/${sessionId}`)
    const run = (session.runs ?? []).find((item) => item.id === runId)
    const summary = `${run?.status ?? 'missing'}/${run?.phase ?? 'unknown'}`
    if (summary !== last) {
      process.stdout.write(`${sampleId}: workflow-retry ${summary}\n`)
      last = summary
    } else {
      process.stdout.write(
        `${sampleId}: workflow-retry waiting ${new Date().toISOString()}\n`,
      )
    }
    if (run?.status === 'complete') return session
    if (['failed', 'interrupted', 'cancelled'].includes(run?.status)) {
      throw new Error(
        `${sampleId}: workflow retry ${summary}: ${run.error ?? ''}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 20_000))
  }
}

await mkdir(outputDir, { recursive: true })
const samples = (await readJsonl(
  externalMode
    ? path.resolve(
        'FSBP_Test',
        'private',
        'round-02',
        'external-holdout-v1',
        'external-holdout.jsonl',
      )
    : path.resolve('FSBP_Test', 'datasets', 'quality-test.jsonl'),
)).filter((sample) => externalMode || !diagnosticIds.has(sample.id))
const expectedSampleCount = externalMode ? 8 : 11
if (samples.length !== expectedSampleCount) {
  throw new Error(
    `Expected ${expectedSampleCount} holdout samples, found ${samples.length}`,
  )
}

let completed = []
try {
  completed = await readJsonl(resultsPath)
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
const completedIds = new Set(completed.map((record) => record.sampleId))

let manifest
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
  manifest = {
    experimentId:
      `${externalMode ? 'round2-external-holdout-v1' : 'round2-holdout-v1'}-` +
      new Date().toISOString(),
    createdAt: new Date().toISOString(),
    datasetVersion: '0.1.0',
    diagnosticSampleIds: externalMode ? [] : [...diagnosticIds],
    holdoutSampleIds: samples.map((sample) => sample.id),
    disclosure: externalMode
      ? 'These eight externally sourced samples were frozen after the prompt gate and must never be used to tune this run.'
      : 'These eleven samples were not used in the five-sample prompt iteration gate.',
    workflow: 'B-2 fixed three-role candidates plus four stages',
    promptBundleVersion: 10,
    agentPromptVersion: 8,
    candidateAnnotationMode: 'body_only',
    models: {
      analyses: ['DeepSeek V4 Pro: Go', 'Kimi K2.6: Go'],
      candidates: 'DeepSeek V4 Pro: Go',
      review: 'Kimi K2.6: Go',
      filter: 'GLM 5.2: Go',
      orchestrate: 'Kimi K2.6: Go',
      assemble: 'GLM 5.2: Go',
    },
    maxConcurrentSamples: concurrency,
    runs: {},
  }
}

let persistQueue = Promise.resolve()
function persistState() {
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
  const resultText =
    `${completed.map((record) => JSON.stringify(record)).join('\n')}\n`
  persistQueue = persistQueue.then(async () => {
    await writeFile(manifestPath, manifestText, 'utf8')
    await writeFile(resultsPath, resultText, 'utf8')
  })
  return persistQueue
}

async function runSample(sample) {
  if (completedIds.has(sample.id)) {
    process.stdout.write(`${sample.id}: holdout result already complete\n`)
    return
  }
  const baseRevision = await baseRevisionFor(sample)
  const temporary = await createTemporaryPreset(sample, baseRevision)
  const revision = temporary.revision
  if (!revision?.id) throw new Error(`${sample.id}: temporary revision missing`)
  let runRecord = manifest.runs[sample.id]
  if (!runRecord?.batchId) {
    const batch = await api('/api/batches', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name:
          `${externalMode ? 'Round2 External Holdout' : 'Round2 Holdout'} · ` +
          sample.id,
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
    runRecord = {
      batchId: batch.id,
      temporaryPresetId: temporary.preset.id,
      presetRevisionId: revision.id,
      sourceTextSha256: sha256(sample.sourceText),
    }
    manifest.runs[sample.id] = runRecord
    await persistState()
  }
  const batch = await waitBatch(runRecord.batchId, sample.id)
  const item = batch.items[0]
  let session
  if (item?.status === 'completed' && item.session_id) {
    session = await api(`/api/sessions/${item.session_id}`)
  } else if (item?.session_id) {
    const interruptedSession = await api(`/api/sessions/${item.session_id}`)
    const knownRunIds = [
      runRecord.infrastructureRecoveryRunId,
      runRecord.capacityRecoveryRunId,
      runRecord.recoveryRunId,
      runRecord.retryRunId,
    ].filter(Boolean)
    const knownRecovery = [...(interruptedSession.runs ?? [])]
      .reverse()
      .find((run) => knownRunIds.includes(run.id))
    if (knownRecovery?.status === 'complete') {
      session = interruptedSession
    } else if (knownRecovery?.status === 'running') {
      session = await waitSessionRun(
        item.session_id,
        knownRecovery.id,
        sample.id,
      )
    } else {
      const latestRun = (interruptedSession.runs ?? []).at(-1)
      const latestError =
        latestRun?.error ?? item.error ?? batch.batch.error ?? 'unknown'
      const systemInterrupted =
        latestRun?.status === 'interrupted' ||
        /application stopped while the run was active/i.test(latestError)
      const completionLimitReached =
        /completion token limit|response was truncated|finish_reason\s*=\s*length/i.test(
          latestError,
        )
      const infrastructureUnavailable =
        /system (?:cpu|memory) overloaded|insufficient (?:quota|balance)|quota exceeded|rate limit|\b429\b/i.test(
          latestError,
        )
      const emptyStageMatch = latestError.match(
        /\b(review|filter|orchestrate|assemble)\b\s*阶段正文为空/i,
      )
      const failedEmptyStage = emptyStageMatch?.[1]?.toLowerCase()
      const stageRetries = { ...(runRecord.stageRetries ?? {}) }
      if (
        Object.keys(stageRetries).length === 0 &&
        (runRecord.workflowRetries ?? 0) > 0
      ) {
        const priorStage = runRecord.firstFailure?.match(
          /\b(review|filter|orchestrate|assemble)\b\s*阶段正文为空/i,
        )?.[1]
        if (priorStage) {
          stageRetries[priorStage.toLowerCase()] = runRecord.workflowRetries
        }
      }

      if (systemInterrupted) {
        const recovery = await api(`/api/sessions/${item.session_id}/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ configMode: 'frozen' }),
        })
        runRecord.systemRecoveries = (runRecord.systemRecoveries ?? 0) + 1
        runRecord.recoveryRunId = recovery.runId
        runRecord.interruption =
          latestRun?.error ?? item.error ?? batch.batch.error ?? 'terminated'
        runRecord.status = 'recovering'
        await persistState()
        session = await waitSessionRun(
          item.session_id,
          recovery.runId,
          sample.id,
        )
      } else if (
        infrastructureUnavailable &&
        (runRecord.infrastructureRecoveries ?? 0) < 1
      ) {
        const recovery = await api(`/api/sessions/${item.session_id}/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ configMode: 'frozen' }),
        })
        runRecord.infrastructureRecoveries =
          (runRecord.infrastructureRecoveries ?? 0) + 1
        runRecord.infrastructureRecoveryRunId = recovery.runId
        runRecord.infrastructureFailure = latestError
        runRecord.status = 'infrastructure-recovering'
        await persistState()
        session = await waitSessionRun(
          item.session_id,
          recovery.runId,
          sample.id,
        )
      } else if (
        completionLimitReached &&
        (runRecord.capacityRecoveries ?? 0) < 1
      ) {
        const recovery = await api(`/api/sessions/${item.session_id}/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ configMode: 'frozen' }),
        })
        runRecord.capacityRecoveries =
          (runRecord.capacityRecoveries ?? 0) + 1
        runRecord.capacityRecoveryRunId = recovery.runId
        runRecord.capacityFailure = latestError
        runRecord.status = 'capacity-recovering'
        await persistState()
        session = await waitSessionRun(
          item.session_id,
          recovery.runId,
          sample.id,
        )
      } else if (
        failedEmptyStage &&
        (stageRetries[failedEmptyStage] ?? 0) < 1
      ) {
        const retry = await api(`/api/sessions/${item.session_id}/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ configMode: 'frozen' }),
        })
        runRecord.workflowRetries = (runRecord.workflowRetries ?? 0) + 1
        stageRetries[failedEmptyStage] =
          (stageRetries[failedEmptyStage] ?? 0) + 1
        runRecord.stageRetries = stageRetries
        runRecord.retryRunId = retry.runId
        runRecord.firstFailure ??=
          item.error ?? batch.batch.error ?? latestError ?? 'unknown'
        runRecord.lastStageFailure = latestError
        runRecord.status = 'retrying'
        await persistState()
        session = await waitSessionRun(item.session_id, retry.runId, sample.id)
      }
    }
  } else {
    runRecord.status = 'failed'
    runRecord.error = item?.error ?? batch.batch.error ?? 'unknown'
    await persistState()
    throw new Error(`${sample.id}: ${runRecord.error}`)
  }
  if (!session) {
    runRecord.status = 'failed'
    runRecord.error = item?.error ?? batch.batch.error ?? 'unknown'
    await persistState()
    throw new Error(`${sample.id}: ${runRecord.error}`)
  }
  if (!session.finalVersion?.text?.trim()) {
    throw new Error(`${sample.id}: formal final version missing`)
  }
  completed.push({
    sampleId: sample.id,
    direction: sample.direction,
    category: sample.category,
    batchId: runRecord.batchId,
    sessionId: item.session_id,
    presetRevisionId: revision.id,
    candidateInvocationIds: (session.invocations ?? [])
      .filter((invocation) => {
        try {
          return (
            invocation.status === 'complete' &&
            !JSON.parse(invocation.agent_snapshot)?.roleKind &&
            Boolean((invocation.body ?? invocation.body_output)?.trim())
          )
        } catch {
          return false
        }
      })
      .map((invocation) => invocation.id),
    finalVersionId: session.finalVersion.id,
    text: session.finalVersion.text,
    textSha256: sha256(session.finalVersion.text),
    completedAt: new Date().toISOString(),
  })
  completedIds.add(sample.id)
  runRecord.status = 'complete'
  runRecord.sessionId = item.session_id
  await persistState()
  try {
    await api(
      `/api/workflow-presets/${encodeURIComponent(temporary.preset.id)}`,
      { method: 'DELETE' },
    )
  } catch (error) {
    process.stderr.write(
      `${sample.id}: result saved; temporary preset cleanup failed: ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    )
  }
  process.stdout.write(`${sample.id}: holdout saved\n`)
}

let cursor = 0
const failures = []
async function worker() {
  for (;;) {
    const index = cursor
    cursor += 1
    if (index >= samples.length) return
    try {
      await runSample(samples[index])
    } catch (error) {
      failures.push({
        sampleId: samples[index].id,
        error: error instanceof Error ? error.message : String(error),
      })
      process.stderr.write(
        `${samples[index].id}: holdout failed after allowed retry: ` +
          `${error instanceof Error ? error.message : String(error)}\n`,
      )
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()))
await persistQueue
manifest.completedAt = new Date().toISOString()
manifest.failures = failures
await persistState()
if (failures.length) {
  throw new Error(
    `Holdout completed with ${failures.length} failed sample(s): ` +
      failures.map((item) => item.sampleId).join(', '),
  )
}
process.stdout.write(
  `Round 2 ${externalMode ? 'external ' : ''}holdout complete: ` +
    `${completed.length}/${expectedSampleCount}\n`,
)
