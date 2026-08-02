import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const apiBase = (
  process.argv.find((argument) => argument.startsWith('--base='))?.slice(7) ??
  'http://127.0.0.1:3000'
).replace(/\/+$/, '')
const gateDir = path.resolve(
  'FSBP_Test',
  'private',
  'round-02',
  'gate-v4',
)
const outputDir = path.join(gateDir, 'annotation-ablation')
const manifestPath = path.join(outputDir, 'annotation-ablation-manifest.json')
const resultsPath = path.join(outputDir, 'annotation-ablation-results.jsonl')
const baselineEvidenceDir = path.join(outputDir, 'body-only-evidence')
const annotationEvidenceDir = path.join(
  outputDir,
  'body-and-annotation-evidence',
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

function roleKind(invocation) {
  try {
    return JSON.parse(invocation.agent_snapshot)?.roleKind ?? null
  } catch {
    return null
  }
}

function invocationBody(invocation) {
  return invocation.body ?? invocation.body_output ?? null
}

function invocationAnnotation(invocation) {
  return invocation.annotation ?? invocation.annotation_output ?? null
}

function candidateInvocations(session) {
  return (session.invocations ?? []).filter((invocation) => {
    const kind = roleKind(invocation)
    return (
      invocation.status === 'complete' &&
      !kind &&
      Boolean(invocationBody(invocation)?.trim())
    )
  })
}

function safeEvidence(session) {
  return {
    capturedAt: new Date().toISOString(),
    session: {
      id: session.session.id,
      state: session.session.state,
      direction: session.session.direction,
      taskBrief: session.session.task_brief,
      finalVersionId: session.session.final_version_id,
    },
    finalVersion: session.finalVersion,
    stages: (session.stages ?? []).map((stage) => ({
      stage: stage.stage,
      status: stage.status,
      promptUsed: stage.prompt_used,
      rawOutput: stage.raw_output,
      error: stage.error,
    })),
    invocations: (session.invocations ?? []).map((invocation) => ({
      id: invocation.id,
      parentRunId: invocation.parent_run_id,
      status: invocation.status,
      model: invocation.model,
      agentSnapshot: invocation.agent_snapshot,
      raw: invocation.raw ?? invocation.raw_output,
      body: invocationBody(invocation),
      annotation: invocationAnnotation(invocation),
      error: invocation.error,
      latencyMs: invocation.latency_ms,
    })),
    runs: session.runs,
    events: (session.events ?? []).filter((event) =>
      [
        'draft.regeneration.started',
        'stage.binding.resolved',
        'stage.completed',
        'stage.failed',
        'version.created',
        'session.completed',
      ].includes(event.event_type),
    ),
  }
}

async function waitRun(sessionId, runId, sampleId) {
  let lastStatus = ''
  for (;;) {
    const session = await api(`/api/sessions/${sessionId}`)
    const run = (session.runs ?? []).find((item) => item.id === runId)
    const status = run?.status ?? 'missing'
    const phase = run?.phase ?? 'unknown'
    const summary = `${status}/${phase}`
    if (summary !== lastStatus) {
      process.stdout.write(`${sampleId}: ${summary}\n`)
      lastStatus = summary
    } else {
      process.stdout.write(`${sampleId}: waiting ${new Date().toISOString()}\n`)
    }
    if (status === 'complete') return session
    if (['failed', 'interrupted', 'cancelled'].includes(status)) {
      throw new Error(`${sampleId}: regeneration ${status}: ${run?.error ?? ''}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20_000))
  }
}

await mkdir(baselineEvidenceDir, { recursive: true })
await mkdir(annotationEvidenceDir, { recursive: true })

const gateResults = await readJsonl(path.join(gateDir, 'gate-results.jsonl'))
if (gateResults.length !== 5) {
  throw new Error(`Expected five gate-v4 results, found ${gateResults.length}`)
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
    experimentId: `round2-gate-v4-annotation-ablation-${new Date().toISOString()}`,
    createdAt: new Date().toISOString(),
    frozenBeforeRegeneration: true,
    independentVariable:
      'candidate context changes from body_only to body_and_annotation',
    controlledVariables: [
      'source text',
      'task brief',
      'successful candidate invocation IDs',
      'candidate raw/body/annotation',
      'review/filter/orchestrate/assemble model bindings',
      'prompt bundle version',
      'max_tokens and timeout policy',
    ],
    candidateGenerationRepeated: false,
    bodyOnlyGateDirectory: gateDir,
    runs: {},
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

for (const gateRecord of gateResults) {
  if (completedIds.has(gateRecord.sampleId)) {
    process.stdout.write(`${gateRecord.sampleId}: ablation already complete\n`)
    continue
  }
  const before = await api(`/api/sessions/${gateRecord.sessionId}`)
  const candidates = candidateInvocations(before)
  if (candidates.length < 2) {
    throw new Error(`${gateRecord.sampleId}: fewer than two frozen candidates`)
  }
  const candidateIds = candidates.map((invocation) => invocation.id)
  const annotations = candidates
    .map((invocation) => invocationAnnotation(invocation))
    .filter((annotation) => annotation?.trim())
  const baselineEvidence = safeEvidence(before)
  const baselineEvidencePath = path.join(
    baselineEvidenceDir,
    `${gateRecord.sampleId}.json`,
  )
  try {
    await readFile(baselineEvidencePath, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await writeFile(
      baselineEvidencePath,
      `${JSON.stringify(baselineEvidence, null, 2)}\n`,
      'utf8',
    )
  }

  const runRecord = manifest.runs[gateRecord.sampleId] ?? {
    sessionId: gateRecord.sessionId,
    baselineFinalVersionId: gateRecord.finalVersionId,
    baselineTextSha256: gateRecord.textSha256,
    candidateInvocationIds: candidateIds,
    candidateAnnotationCount: annotations.length,
    candidateAnnotationChars: annotations.reduce(
      (sum, annotation) => sum + annotation.length,
      0,
    ),
    attempts: [],
  }
  runRecord.attempts ??= runRecord.runId
    ? [{ runId: runRecord.runId, legacy: true }]
    : []
  manifest.runs[gateRecord.sampleId] = runRecord

  async function startAttempt() {
    const started = await api(
      `/api/sessions/${gateRecord.sessionId}/regenerate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          candidateAnnotationMode: 'body_and_annotation',
        }),
      },
    )
    runRecord.runId = started.runId
    runRecord.attempts.push({
      runId: started.runId,
      startedAt: new Date().toISOString(),
    })
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    )
    return started.runId
  }

  let runId = runRecord.runId
  if (!runId) runId = await startAttempt()
  let after
  let excludedFailure = null
  for (;;) {
    try {
      after = await waitRun(
        gateRecord.sessionId,
        runId,
        gateRecord.sampleId,
      )
      break
    } catch (error) {
      const attempt = runRecord.attempts.find(
        (item) => item.runId === runId,
      )
      if (attempt) {
        attempt.failedAt = new Date().toISOString()
        attempt.error = error instanceof Error ? error.message : String(error)
      }
      if (runRecord.attempts.length >= 2) {
        excludedFailure =
          error instanceof Error ? error.message : String(error)
        runRecord.status = 'excluded_after_two_failed_attempts'
        runRecord.exclusionReason = excludedFailure
        runRecord.excludedAt = new Date().toISOString()
        await writeFile(
          manifestPath,
          `${JSON.stringify(manifest, null, 2)}\n`,
          'utf8',
        )
        process.stdout.write(
          `${gateRecord.sampleId}: excluded after two failed regeneration attempts\n`,
        )
        break
      }
      process.stdout.write(
        `${gateRecord.sampleId}: invalid stage output; retrying once\n`,
      )
      runId = await startAttempt()
    }
  }
  if (excludedFailure) continue
  if (!after.finalVersion?.text?.trim()) {
    throw new Error(`${gateRecord.sampleId}: regenerated final version missing`)
  }
  if (after.finalVersion.id === gateRecord.finalVersionId) {
    throw new Error(`${gateRecord.sampleId}: regeneration did not create a version`)
  }
  const afterEvidence = safeEvidence(after)
  await writeFile(
    path.join(annotationEvidenceDir, `${gateRecord.sampleId}.json`),
    `${JSON.stringify(afterEvidence, null, 2)}\n`,
    'utf8',
  )
  completed.push({
    sampleId: gateRecord.sampleId,
    direction: gateRecord.direction,
    category: gateRecord.category,
    sessionId: gateRecord.sessionId,
    runId,
    candidateInvocationIds: candidateIds,
    candidateAnnotationCount: annotations.length,
    candidateAnnotationChars: annotations.reduce(
      (sum, annotation) => sum + annotation.length,
      0,
    ),
    bodyOnly: {
      finalVersionId: gateRecord.finalVersionId,
      text: gateRecord.text,
      textSha256: gateRecord.textSha256,
    },
    bodyAndAnnotation: {
      finalVersionId: after.finalVersion.id,
      text: after.finalVersion.text,
      textSha256: sha256(after.finalVersion.text),
    },
    completedAt: new Date().toISOString(),
  })
  await writeFile(
    resultsPath,
    `${completed.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  )
  process.stdout.write(`${gateRecord.sampleId}: annotation ablation saved\n`)
}

process.stdout.write(
  `Round 2 annotation ablation complete: ${completed.length}/5\n`,
)
