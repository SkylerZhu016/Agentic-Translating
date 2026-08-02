import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const apiBase = (
  process.argv.find((argument) => argument.startsWith('--base='))?.slice(7) ??
  'http://127.0.0.1:3000'
).replace(/\/+$/, '')
const sourceDir = path.resolve('FSBP_Test', 'private', 'round-02', 'gate-v5')
const outputDir = path.resolve('FSBP_Test', 'private', 'round-02', 'gate-v6')
const targetId = 'test-en-zh-hopkins-pied-beauty'

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
  const response = await fetch(`${apiBase}${url}`, init)
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(`${response.status} ${url}: ${JSON.stringify(payload ?? {})}`)
  }
  return payload
}

async function waitRun(sessionId, runId) {
  let last = ''
  for (;;) {
    const session = await api(`/api/sessions/${sessionId}`)
    const run = (session.runs ?? []).find((item) => item.id === runId)
    const status = `${run?.status ?? 'missing'}/${run?.phase ?? 'unknown'}`
    if (status !== last) {
      process.stdout.write(`${targetId}: ${status}\n`)
      last = status
    } else {
      process.stdout.write(`${targetId}: waiting ${new Date().toISOString()}\n`)
    }
    if (run?.status === 'complete') return session
    if (['failed', 'interrupted', 'cancelled'].includes(run?.status)) {
      throw new Error(`${status}: ${run?.error ?? ''}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20_000))
  }
}

await mkdir(path.join(outputDir, 'session-evidence'), { recursive: true })
const sourceResults = await readJsonl(path.join(sourceDir, 'gate-results.jsonl'))
if (sourceResults.length !== 5) throw new Error('gate-v5 must contain five results')
const target = sourceResults.find((item) => item.sampleId === targetId)
if (!target) throw new Error('Hopkins gate-v5 result missing')

const manifestPath = path.join(outputDir, 'gate-manifest.json')
let manifest
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
  manifest = {
    gateId: `round2-prompt-leak-repair-${new Date().toISOString()}`,
    createdAt: new Date().toISOString(),
    sourceGateRevision: 5,
    retainedSampleIds: sourceResults
      .filter((item) => item.sampleId !== targetId)
      .map((item) => item.sampleId),
    regeneratedSampleId: targetId,
    reason:
      'gate-v5 Hopkins visible output contained a substantial verbatim system-prompt echo',
    guard:
      'three verbatim system-prompt lines and at least 160 matched characters cause a retryable integrity failure',
    passRule: 'FSBP must win at least 4 of 5; ties do not count',
    attempts: [],
  }
}

let session
for (let attemptNo = manifest.attempts.length + 1; attemptNo <= 2; attemptNo += 1) {
  const started = await api(`/api/sessions/${target.sessionId}/regenerate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      candidateAnnotationMode: 'body_only',
      configMode: 'current',
    }),
  })
  const attempt = {
    attemptNo,
    runId: started.runId,
    startedAt: new Date().toISOString(),
  }
  manifest.attempts.push(attempt)
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  try {
    session = await waitRun(target.sessionId, started.runId)
    attempt.completedAt = new Date().toISOString()
    break
  } catch (error) {
    attempt.failedAt = new Date().toISOString()
    attempt.error = error instanceof Error ? error.message : String(error)
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    if (attemptNo === 2) throw error
  }
}

const repairedText = session?.finalVersion?.text?.trim()
if (!repairedText) throw new Error('repaired Hopkins final version missing')
if (
  repairedText.includes('# 组装工作') &&
  repairedText.includes('执行编排中有依据的选择')
) {
  throw new Error('prompt echo remained in repaired final output')
}

const repaired = {
  ...target,
  runId: manifest.attempts.at(-1).runId,
  finalVersionId: session.finalVersion.id,
  text: repairedText,
  textSha256: sha256(repairedText),
  completedAt: new Date().toISOString(),
  repairOfFinalVersionId: target.finalVersionId,
}
const results = sourceResults.map((item) =>
  item.sampleId === targetId ? repaired : item,
)
await writeFile(
  path.join(outputDir, 'gate-results.jsonl'),
  `${results.map((item) => JSON.stringify(item)).join('\n')}\n`,
  'utf8',
)
await writeFile(
  path.join(outputDir, 'session-evidence', `${targetId}.json`),
  `${JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      runId: repaired.runId,
      finalVersion: session.finalVersion,
      stages: session.stages,
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
    },
    null,
    2,
  )}\n`,
  'utf8',
)
manifest.completedAt = new Date().toISOString()
manifest.repairedFinalVersionId = repaired.finalVersionId
manifest.repairedTextSha256 = repaired.textSha256
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
process.stdout.write('Round 2 prompt-leak repair gate complete: 5/5\n')
