import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const apiBase = (
  process.argv.find((argument) => argument.startsWith('--base='))?.slice(7) ??
  'http://127.0.0.1:3000'
).replace(/\/+$/, '')
const sourceGateDir = path.resolve(
  'FSBP_Test',
  'private',
  'round-02',
  'gate-v4',
)
const outputDir = path.resolve(
  'FSBP_Test',
  'private',
  'round-02',
  'gate-v5',
)
const manifestPath = path.join(outputDir, 'gate-manifest.json')
const resultsPath = path.join(outputDir, 'gate-results.jsonl')
const evidenceDir = path.join(outputDir, 'session-evidence')

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

function candidateInvocationIds(session) {
  return (session.invocations ?? [])
    .filter(
      (invocation) =>
        invocation.status === 'complete' &&
        !roleKind(invocation) &&
        Boolean(invocationBody(invocation)?.trim()),
    )
    .map((invocation) => invocation.id)
}

function safeEvidence(session, runId) {
  return {
    capturedAt: new Date().toISOString(),
    runId,
    session: {
      id: session.session.id,
      state: session.session.state,
      direction: session.session.direction,
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
  let lastSummary = ''
  for (;;) {
    const session = await api(`/api/sessions/${sessionId}`)
    const run = (session.runs ?? []).find((item) => item.id === runId)
    const summary = `${run?.status ?? 'missing'}/${run?.phase ?? 'unknown'}`
    if (summary !== lastSummary) {
      process.stdout.write(`${sampleId}: ${summary}\n`)
      lastSummary = summary
    } else {
      process.stdout.write(`${sampleId}: waiting ${new Date().toISOString()}\n`)
    }
    if (run?.status === 'complete') return session
    if (['failed', 'interrupted', 'cancelled'].includes(run?.status)) {
      throw new Error(
        `${sampleId}: ${run.status}/${run.phase}: ${run.error ?? ''}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 20_000))
  }
}

await mkdir(evidenceDir, { recursive: true })
const sourceResults = await readJsonl(
  path.join(sourceGateDir, 'gate-results.jsonl'),
)
if (sourceResults.length !== 5) {
  throw new Error(`Expected five source gate records, found ${sourceResults.length}`)
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
    gateId: `round2-error-closure-v10-${new Date().toISOString()}`,
    createdAt: new Date().toISOString(),
    passRule: 'FSBP must win at least 4 of 5; ties do not count',
    diagnosticReuseDisclosure:
      'Candidate invocations are frozen from gate-v4. Only review, filter, orchestrate, and assemble are regenerated.',
    independentChanges: [
      'prompt bundle version 10',
      'selection independently adjudicates review findings',
      'final decision ledger constrains orchestration and assembly',
      'assembly model changes from DeepSeek V4 Pro: Go to GLM 5.2: Go',
    ],
    candidateAnnotationMode: 'body_only',
    configMode: 'current',
    promptBundleVersion: 10,
    models: {
      candidates: 'DeepSeek V4 Pro: Go (frozen from gate-v4)',
      review: 'Kimi K2.6: Go',
      filter: 'GLM 5.2: Go',
      orchestrate: 'Kimi K2.6: Go',
      assemble: 'GLM 5.2: Go',
    },
    stageMaxTokens: 65_536,
    runs: {},
  }
}

for (const source of sourceResults) {
  if (completedIds.has(source.sampleId)) {
    process.stdout.write(`${source.sampleId}: gate-v5 already complete\n`)
    continue
  }
  const before = await api(`/api/sessions/${source.sessionId}`)
  const candidateIds = candidateInvocationIds(before)
  if (candidateIds.length < 2) {
    throw new Error(`${source.sampleId}: fewer than two frozen candidates`)
  }
  const runRecord = manifest.runs[source.sampleId] ?? {
    sessionId: source.sessionId,
    sourceFinalVersionId: source.finalVersionId,
    sourceTextSha256: source.textSha256,
    candidateInvocationIds: candidateIds,
    attempts: [],
  }
  manifest.runs[source.sampleId] = runRecord

  async function startAttempt() {
    const response = await api(
      `/api/sessions/${source.sessionId}/regenerate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          candidateAnnotationMode: 'body_only',
          configMode: 'current',
        }),
      },
    )
    runRecord.runId = response.runId
    runRecord.attempts.push({
      runId: response.runId,
      startedAt: new Date().toISOString(),
    })
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    )
    return response.runId
  }

  let session
  let runId = runRecord.runId
  if (!runId) runId = await startAttempt()
  for (;;) {
    try {
      session = await waitRun(source.sessionId, runId, source.sampleId)
      break
    } catch (error) {
      const attempt = runRecord.attempts.find((item) => item.runId === runId)
      if (attempt) {
        attempt.failedAt = new Date().toISOString()
        attempt.error = error instanceof Error ? error.message : String(error)
      }
      if (runRecord.attempts.length >= 2) throw error
      process.stdout.write(
        `${source.sampleId}: invalid stage output; retrying once\n`,
      )
      runId = await startAttempt()
    }
  }
  if (!session.finalVersion?.text?.trim()) {
    throw new Error(`${source.sampleId}: regenerated final version missing`)
  }
  if (session.finalVersion.id === source.finalVersionId) {
    throw new Error(`${source.sampleId}: regeneration did not create a version`)
  }
  const record = {
    sampleId: source.sampleId,
    direction: source.direction,
    category: source.category,
    sessionId: source.sessionId,
    runId,
    candidateInvocationIds: candidateIds,
    finalVersionId: session.finalVersion.id,
    text: session.finalVersion.text,
    textSha256: sha256(session.finalVersion.text),
    completedAt: new Date().toISOString(),
  }
  completed.push(record)
  await writeFile(
    path.join(evidenceDir, `${source.sampleId}.json`),
    `${JSON.stringify(safeEvidence(session, runId), null, 2)}\n`,
    'utf8',
  )
  await writeFile(
    resultsPath,
    `${completed.map((item) => JSON.stringify(item)).join('\n')}\n`,
    'utf8',
  )
  process.stdout.write(`${source.sampleId}: gate-v5 saved\n`)
}

manifest.completedAt = new Date().toISOString()
await writeFile(
  manifestPath,
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
)
process.stdout.write(`Round 2 error-closure gate complete: ${completed.length}/5\n`)
