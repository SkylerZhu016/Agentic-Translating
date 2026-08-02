import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const configArgument = process.argv.find((argument) => argument.startsWith('--config='))
const runConfig = configArgument
  ? JSON.parse(await readFile(path.resolve(configArgument.slice(9)), 'utf8'))
  : {}
const apiBase = (
  process.argv.find((argument) => argument.startsWith('--base='))?.slice(7) ??
  runConfig.apiBase ??
  'http://127.0.0.1:3001'
).replace(/\/+$/, '')
const outputDir = path.resolve(
  runConfig.outputDir ?? path.join(
    'FSBP_Test',
    'private',
    'round-03',
    'dev-conversation-v1',
  ),
)
const manifestPath = path.join(outputDir, 'manifest.json')
const resultsPath = path.join(outputDir, 'results.jsonl')
const defaultSelectedIds = [
  'test-en-zh-hopkins-pied-beauty',
  'test-en-zh-jerome-sea-trip',
  'test-en-zh-lovelace-engine-limits',
  'test-zh-en-sushi-shuidiaogetou',
  'test-zh-en-wanganshi-reform-defense',
]
const selectedIds = runConfig.selectedIds ?? defaultSelectedIds
const onlySampleId = process.argv
  .find((argument) => argument.startsWith('--only='))
  ?.slice(7)
const experimentSlug = runConfig.experimentSlug ?? 'round3-dev-conversation-v1'
const expectedCount = runConfig.expectedCount ?? selectedIds.length
if (selectedIds.length !== expectedCount || new Set(selectedIds).size !== selectedIds.length) {
  throw new Error('selectedIds must be unique and match expectedCount')
}
if (onlySampleId && !selectedIds.includes(onlySampleId)) {
  throw new Error(`--only sample is not part of this experiment: ${onlySampleId}`)
}
const datasetPath = path.resolve(
  runConfig.datasetPath ?? path.join('FSBP_Test', 'datasets', 'quality-test.jsonl'),
)
const baselinePath = path.resolve(
  runConfig.baselinePath ?? path.join(
    'FSBP_Test',
    'private',
    'review',
    'test-round-01.jsonl',
  ),
)
const requireHumanReviewedBaseline = runConfig.requireHumanReviewedBaseline ?? true
const directBaselineLabel = runConfig.directBaselineLabel ?? 'gpt-direct-reviewed'
const promptBundleVersion = runConfig.promptBundleVersion ?? 13
const revisionStrategy = runConfig.revisionStrategy ?? 'legacy_audit'
if (!['legacy_audit', 'isolated_suggestion'].includes(revisionStrategy)) {
  throw new Error(`Unsupported revisionStrategy: ${revisionStrategy}`)
}
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
  const attempts = method === 'GET' ? 5 : 1
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(`${apiBase}${url}`, init)
    const contentType = response.headers.get('content-type') ?? ''
    const payload = contentType.includes('application/json')
      ? await response.json().catch(() => null)
      : await response.text().catch(() => '')
    if (response.ok) return payload
    if (method === 'GET' && response.status >= 500 && attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000))
      continue
    }
    throw new Error(`${response.status} ${url}: ${JSON.stringify(payload ?? {})}`)
  }
  throw new Error(`${method} ${url}: retry loop exhausted`)
}

async function findBaseRevision(sample) {
  const directionLabel = sample.direction === 'en_to_zh' ? '英译中' : '中译英'
  const expectedName = `FSBP B-2 ${directionLabel}·${categoryLabel[sample.category]}`
  const presets = await api(`/api/workflow-presets?direction=${sample.direction}`)
  const preset = presets.find((item) => item.name === expectedName)
  if (!preset) throw new Error(`${sample.id}: ${expectedName} missing`)
  const detail = await api(`/api/workflow-presets/${encodeURIComponent(preset.id)}`)
  const revision = detail.revisions.find(
    (item) => item.revisionNo === preset.currentRevisionNo,
  )
  if (!revision) throw new Error(`${sample.id}: current preset revision missing`)
  const contract = revision.contract
  const bindings = [
    contract.defaultWorkerBinding,
    contract.mainAgentBinding,
    contract.reviewAgentBinding,
    contract.filterAgentBinding,
    contract.orchestrateAgentBinding,
    contract.assembleAgentBinding,
    contract.editingAgentBinding,
    ...(contract.contextAnalysisBindings ?? []),
  ]
  if (
    contract.promptBundleVersion !== promptBundleVersion ||
    contract.reviewMode !== 'four_stage' ||
    !bindings.every((item) => item?.model === 'DeepSeek V4 Flash: Go')
  ) {
    throw new Error(
      `${sample.id}: preset is not the locked round-3 Flash/v${promptBundleVersion} contract`,
    )
  }
  return revision
}

async function createTemporaryPreset(sample, baseRevision) {
  const name = `${experimentSlug} · ${sample.id}`
  const presets = await api(`/api/workflow-presets?direction=${sample.direction}`)
  const existing = presets.find((item) => item.name === name)
  if (existing) {
    const detail = await api(`/api/workflow-presets/${encodeURIComponent(existing.id)}`)
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
      description: runConfig.presetDescription ?? '第三轮对话门禁专用冻结契约。',
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
    }
    if (['completed', 'failed', 'cancelled', 'paused'].includes(detail.batch.status)) {
      return detail
    }
    await new Promise((resolve) => setTimeout(resolve, 30_000))
  }
}

async function waitRun(sessionId, runId, sampleId) {
  let last = ''
  for (;;) {
    const session = await api(`/api/sessions/${sessionId}`)
    const run = session.runs?.find((item) => item.id === runId)
    const summary = `${run?.status ?? 'missing'}/${run?.phase ?? 'unknown'}`
    if (summary !== last) {
      process.stdout.write(`${sampleId}: resume ${summary}\n`)
      last = summary
    }
    if (run?.status === 'complete') return session
    if (['failed', 'interrupted', 'cancelled'].includes(run?.status)) {
      throw new Error(`${sampleId}: resumed run ${summary}: ${run?.error ?? ''}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 30_000))
  }
}

async function completedSessionFromBatch(batch, sampleId) {
  const item = batch.items[0]
  if (!item?.session_id) {
    throw new Error(`${sampleId}: batch did not create a session`)
  }
  let session = await api(`/api/sessions/${item.session_id}`)
  if (session.finalVersion?.text?.trim()) return session
  const activeRun = session.runs?.find((run) =>
    ['queued', 'running'].includes(run.status),
  )
  if (activeRun) {
    return waitRun(item.session_id, activeRun.id, sampleId)
  }
  const latestRun = [...(session.runs ?? [])].sort((left, right) =>
    String(left.created_at ?? left.createdAt ?? '').localeCompare(
      String(right.created_at ?? right.createdAt ?? ''),
    ),
  ).at(-1)
  if (!['failed', 'interrupted'].includes(latestRun?.status)) {
    throw new Error(`${sampleId}: no final version and no recoverable run`)
  }
  const recovery = await api(`/api/sessions/${item.session_id}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ configMode: 'frozen' }),
  })
  return waitRun(item.session_id, recovery.runId, sampleId)
}

function feedbackRounds(sample) {
  const requirementAudit = sample.direction === 'en_to_zh'
    ? '这一轮只做审计，不修改译文。把任务简报中的每项明确要求逐项对应到原文和当前译文：引用准确位置，说明当前译文是否真正实现。对于复数要求、重复结构、并列关系、反问、专名、数量、段落或诗行，必须分别统计原文与译文中的出现次数，不能看到一处就判为满足。独立回看原文；上游审查只提供线索，若与用户要求冲突要明确指出。最后列出需要修改的准确译文片段及修改目标；没有证据的问题不要列入。此轮不要调用工具。'
    : 'Audit only in this turn; do not edit the translation. Map every explicit brief requirement to exact loci in both the source and the current translation, and state whether the current text actually realizes it. For plural requirements, repeated structures, parallel relations, rhetorical questions, names, quantities, paragraphs, or lines, count the source and target occurrences separately; finding one occurrence does not satisfy a plural requirement. Re-read the source independently. Upstream reviews are clues only, and you must identify any conflict with the user brief. End with the exact target spans that require change and the intended repair. Do not list unsupported preferences and do not call a tool in this turn.'
  const applyAudit = sample.direction === 'en_to_zh'
    ? '现在根据你上一轮的逐项审计执行修订。逐条复核后，只落实最多三处影响最大的、确有原文或任务要求支持的问题。每个 replace_text 的 old_string 都必须从“当前最新完整译文”中逐字复制，不能从审计意见、原文或旧版本中复制；片段若重复，必须连同不修改的上下文一起引用，使其唯一匹配。不能只复述建议。修改后再次统计复数、重复、反问、专名、数量和结构要求是否满足，并检查中文搭配与句法。若上轮意见与原文冲突，应舍弃该意见。可靠且不在问题范围内的文字保持不动。'
    : 'Now implement the preceding requirement audit. Recheck each finding and implement at most three highest-impact defects that are supported by the source or user brief. For every replace_text call, copy old_string character-for-character from CURRENT COMPLETE TRANSLATION, never from the audit, source, or an earlier version. If the span repeats, include unchanged surrounding context so it matches exactly once. Do not merely repeat recommendations. After editing, recount the relevant plural, repeated, rhetorical, naming, quantitative, and structural requirements and check English collocation and syntax. Discard any prior finding that conflicts with the source. Keep reliable wording outside the confirmed repair loci unchanged.'
  const regression = sample.direction === 'en_to_zh'
    ? '最后进行 Patch 回归检查：逐项复核本次对话产生的每个修改，并与完整原文和任务要求比较。此前修改若抹平了刻意陌生表达、删除反问或重复、改错专名、改变数量或修饰关系，或者造成漏译增译，请恢复更可靠的旧表达。只处理有原文证据的问题。'
    : 'Run a final patch-regression audit. Inspect every edit made earlier in this conversation against the complete source and brief. Revert any patch that flattened deliberate strangeness, removed a rhetorical or repeated structure, changed an established name, altered number or attachment, or caused omission or addition. Make only source-supported corrections.'
  return [requirementAudit, applyAudit, regression]
}

function ordinaryFeedbackRounds(sample) {
  if (sample.direction === 'en_to_zh') {
    return [
      '读起来有点拗口。只改最影响阅读的几处，别把原文特别的说法抹平。',
      '整体语气再统一、文雅一点，但别堆生僻词，也别整段重写。',
      '再和原文对照一下，只修意思走偏或前面改坏的地方；没有确切问题就停。',
    ]
  }
  return [
    'Some parts feel stiff. Fix only the few places that most obstruct reading, and keep the source’s distinctive phrasing.',
    'Make the voice more consistent and polished, without ornate wording or a wholesale rewrite.',
    'Check the source once more. Repair only meaning that drifted or wording damaged by earlier edits; stop if there is no clear problem.',
  ]
}

function storedFeedback(run, sample) {
  if (revisionStrategy === 'legacy_audit') return feedbackRounds(sample)
  return (run?.revisionSuggestions ?? [])
    .map((item) => item?.feedback)
    .filter((item) => typeof item === 'string' && item.trim())
}

async function generateRevisionFeedback(sessionId, userRequest) {
  return api(`/api/sessions/${sessionId}/revision-suggestions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: userRequest }),
  })
}

function sessionIdOf(detail) {
  const id = detail?.session?.id ?? detail?.id
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error('Session detail did not include a usable session id')
  }
  return id
}

async function applyChatRound(sessionId, message) {
  const response = await fetch(`${apiBase}/api/sessions/${sessionId}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${response.status} chat: ${text.slice(0, 1000)}`)
  }
  if (!/event:\s*done\b/.test(text)) {
    throw new Error(`chat stream ended without done event: ${text.slice(-1000)}`)
  }
  const completionBlocks = [
    ...text.matchAll(/event:\s*message_complete\s*\r?\ndata:\s*([^\r\n]+)/g),
  ]
  const completion = completionBlocks.at(-1)
  if (!completion) {
    throw new Error(`chat stream ended without message_complete: ${text.slice(-1000)}`)
  }
  const completionPayload = JSON.parse(completion[1])
  if (completionPayload.error) {
    throw new Error(
      `chat model failed: ${completionPayload.error}: ` +
      `${completionPayload.message ?? 'unknown error'}`,
    )
  }
  const session = await api(`/api/sessions/${sessionId}`)
  if (session.messages?.at(-1)?.role !== 'assistant') {
    throw new Error('chat stream completed without a persisted assistant turn')
  }
  return session
}

function versionRecord(session, version, round, extra = {}) {
  const patchCount = (session.patches ?? []).filter(
    (patch) => Number(patch.result_version_id ?? patch.resultVersionId) <= version.id,
  ).length
  return {
    round,
    versionId: version.id,
    versionNo: version.version_no ?? version.versionNo,
    text: version.text,
    textSha256: sha256(version.text),
    patchCount,
    ...extra,
  }
}

function recoverCompletedChatRounds(session, feedback) {
  const allVersions = session.versions ?? []
  const baseVersion = allVersions.find((version) =>
    ['assemble', 'main_draft'].includes(version.source),
  ) ?? allVersions[0]
  if (!baseVersion) throw new Error('Session has no initial formal version')
  const versions = [versionRecord(session, baseVersion, 0)]
  const messages = session.messages ?? []
  let cursor = 0
  for (let index = 0; index < feedback.length; index += 1) {
    const userIndex = messages.findIndex(
      (message, messageIndex) =>
        messageIndex >= cursor &&
        message.role === 'user' &&
        message.content === feedback[index],
    )
    if (userIndex < 0) break
    const assistantIndex = userIndex + 1
    if (messages[assistantIndex]?.role !== 'assistant') break
    const assistant = messages[assistantIndex]
    const previous = versions.at(-1)
    const resultVersion = assistant.version_id == null
      ? allVersions.find((version) => version.id === previous.versionId)
      : allVersions.find((version) => version.id === assistant.version_id)
    if (!resultVersion) break
    versions.push(versionRecord(session, resultVersion, index + 1, {
      changed: resultVersion.id !== previous.versionId,
      feedback: feedback[index],
    }))
    cursor = assistantIndex + 1
  }
  return versions
}

await mkdir(outputDir, { recursive: true })
const samples = await readJsonl(
  datasetPath,
)
const baselines = await readJsonl(
  baselinePath,
)
const sampleById = new Map(samples.map((sample) => [sample.id, sample]))
const baselineById = new Map(baselines.map((item) => [item.sampleId, item]))
const selected = selectedIds.map((id) => {
  const sample = sampleById.get(id)
  const baseline = baselineById.get(id)
  if (!sample) throw new Error(`${id}: sample missing`)
  if (
    !baseline?.body?.trim() ||
    (requireHumanReviewedBaseline && baseline.humanReview?.status !== 'reviewed')
  ) {
    throw new Error(`${id}: reviewed direct baseline missing`)
  }
  return { sample, baseline }
})

let manifest
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (JSON.stringify(manifest.sampleIds) !== JSON.stringify(selectedIds)) {
    throw new Error('Existing manifest uses a different sample set')
  }
  if ((manifest.revisionStrategy ?? 'legacy_audit') !== revisionStrategy) {
    throw new Error('Existing manifest uses a different revision strategy')
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
  manifest = {
    experimentId: `${experimentSlug}-${new Date().toISOString()}`,
    createdAt: new Date().toISOString(),
    purpose: runConfig.purpose ?? 'Revealed development gate; not a generalization claim.',
    promptBundleVersion,
    model: 'DeepSeek V4 Flash: Go',
    revisionStrategy,
    workflow: revisionStrategy === 'isolated_suggestion'
      ? 'B-2 fixed candidates; target-language reader plus bilingual verifier; ordinary-feedback arbitration; three bounded chat revisions'
      : 'B-2 fixed candidates; three isolated review audits; single-base conservative editing; three chat revisions',
    revisionStrategy,
    sampleIds: selectedIds,
    sourceHashes: Object.fromEntries(
      selected.map(({ sample }) => [sample.id, sha256(sample.sourceText)]),
    ),
    directBaselineLabel,
    expectedCount,
    blindReviewTitle: runConfig.blindReviewTitle,
    blindReviewIntroduction: runConfig.blindReviewIntroduction,
    runs: {},
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

let results = []
try {
  results = await readJsonl(resultsPath)
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
const resultById = new Map(results.map((item) => [item.sampleId, item]))

for (const { sample, baseline } of selected) {
  if (onlySampleId && sample.id !== onlySampleId) continue
  let activeSession = null
  try {
  const priorResult = resultById.get(sample.id)
  if (priorResult?.status === 'complete' && priorResult.sessionId) {
    const priorSession = await api(`/api/sessions/${priorResult.sessionId}`)
    const recovered = recoverCompletedChatRounds(
      priorSession,
      storedFeedback(manifest.runs[sample.id], sample),
    )
    if (recovered.length === 4) {
      process.stdout.write(`${sample.id}: already complete\n`)
      continue
    }
    process.stdout.write(
      `${sample.id}: stored result had ${recovered.length - 1}/3 ` +
      'complete chat turns; resuming from the session audit log\n',
    )
    resultById.delete(sample.id)
  }
  const baseRevision = await findBaseRevision(sample)
  const temporary = await createTemporaryPreset(sample, baseRevision)
  let run = manifest.runs[sample.id]
  if (!run?.batchId) {
    const batch = await api('/api/batches', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `${experimentSlug} · ${sample.id}`,
        presetRevisionId: temporary.revision.id,
        concurrency: 1,
        files: [{
          relativePath: `${sample.id}.md`,
          sourceText: sample.sourceText,
          originalLineEnding: 'lf',
          hadBom: false,
        }],
      }),
    })
    run = {
      batchId: batch.id,
      temporaryPresetId: temporary.preset.id,
      presetRevisionId: temporary.revision.id,
    }
    manifest.runs[sample.id] = run
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }

  const batch = await waitBatch(run.batchId, sample.id)
  let session = await completedSessionFromBatch(batch, sample.id)
  activeSession = session
  const versions = recoverCompletedChatRounds(
    session,
    storedFeedback(run, sample),
  )
  const ordinaryRequests = ordinaryFeedbackRounds(sample)
  const roundCount = revisionStrategy === 'isolated_suggestion'
    ? ordinaryRequests.length
    : feedbackRounds(sample).length
  for (let index = versions.length - 1; index < roundCount; index += 1) {
    let message
    let suggestion = null
    if (revisionStrategy === 'isolated_suggestion') {
      run.revisionSuggestions ??= []
      suggestion = run.revisionSuggestions[index]
      if (!suggestion?.feedback?.trim()) {
        const userRequest = ordinaryRequests[index]
        const generated = await generateRevisionFeedback(
          sessionIdOf(session),
          userRequest,
        )
        if (!generated?.feedback?.trim()) {
          throw new Error(`${sample.id}: revision suggestion ${index + 1} was empty`)
        }
        suggestion = {
          round: index + 1,
          userRequest,
          feedback: generated.feedback,
          targetReaderReport: generated.targetReaderReport,
          bilingualReport: generated.bilingualReport,
          generatedAt: new Date().toISOString(),
        }
        run.revisionSuggestions[index] = suggestion
        await writeFile(
          manifestPath,
          `${JSON.stringify(manifest, null, 2)}\n`,
          'utf8',
        )
      }
      message = suggestion.feedback
      process.stdout.write(`${sample.id}: suggestion ${index + 1} saved\n`)
    } else {
      message = feedbackRounds(sample)[index]
    }

    session = await applyChatRound(sessionIdOf(session), message)
    activeSession = session
    versions.push(versionRecord(session, session.finalVersion, index + 1, {
      changed: session.finalVersion.id !== versions.at(-1).versionId,
      feedback: message,
      userRequest: suggestion?.userRequest ?? null,
      targetReaderReport: suggestion?.targetReaderReport ?? null,
      bilingualReport: suggestion?.bilingualReport ?? null,
    }))
    process.stdout.write(
      `${sample.id}: chat round ${index + 1} ` +
      `${versions.at(-1).changed ? 'created a version' : 'kept the current version'}\n`,
    )
  }

  const record = {
    sampleId: sample.id,
    direction: sample.direction,
    category: sample.category,
    status: 'complete',
    sessionId: sessionIdOf(session),
    batchId: run.batchId,
    presetRevisionId: run.presetRevisionId,
    promptBundleVersion,
    model: 'DeepSeek V4 Flash: Go',
    sourceText: sample.sourceText,
    taskBrief: sample.taskBrief,
    directText: baseline.body,
    directBaselineLabel,
    directTextSha256: sha256(baseline.body),
    versions,
    finalText: versions.at(-1).text,
    finalTextSha256: versions.at(-1).textSha256,
    completedAt: new Date().toISOString(),
  }
  resultById.set(sample.id, record)
  results = selectedIds
    .map((id) => resultById.get(id))
    .filter(Boolean)
  await writeFile(
    resultsPath,
    `${results.map((item) => JSON.stringify(item)).join('\n')}\n`,
    'utf8',
  )
  process.stdout.write(`${sample.id}: saved ${sessionIdOf(session)}\n`)
  } catch (error) {
    if (!activeSession && manifest.runs[sample.id]?.batchId) {
      try {
        const batch = await api(`/api/batches/${manifest.runs[sample.id].batchId}`)
        const sessionId = batch.items?.[0]?.session_id
        if (sessionId) activeSession = await api(`/api/sessions/${sessionId}`)
      } catch {
        // Preserve the original experiment failure when audit recovery also fails.
      }
    }
    const recoveredVersions = activeSession?.finalVersion?.text?.trim()
      ? recoverCompletedChatRounds(
        activeSession,
        storedFeedback(manifest.runs[sample.id], sample),
      )
      : []
    const failedRecord = {
      sampleId: sample.id,
      direction: sample.direction,
      category: sample.category,
      status: 'failed',
      sessionId: activeSession ? sessionIdOf(activeSession) : null,
      batchId: manifest.runs[sample.id]?.batchId ?? null,
      presetRevisionId: manifest.runs[sample.id]?.presetRevisionId ?? null,
      promptBundleVersion,
      model: 'DeepSeek V4 Flash: Go',
      revisionStrategy,
      sourceText: sample.sourceText,
      taskBrief: sample.taskBrief,
      directText: baseline.body,
      directBaselineLabel,
      directTextSha256: sha256(baseline.body),
      versions: recoveredVersions,
      finalText: recoveredVersions.at(-1)?.text ?? null,
      finalTextSha256: recoveredVersions.at(-1)?.textSha256 ?? null,
      error: error instanceof Error ? error.message : String(error),
      failedAt: new Date().toISOString(),
    }
    resultById.set(sample.id, failedRecord)
    results = selectedIds.map((id) => resultById.get(id)).filter(Boolean)
    await writeFile(
      resultsPath,
      `${results.map((item) => JSON.stringify(item)).join('\n')}\n`,
      'utf8',
    )
    process.stderr.write(`${sample.id}: failed and recorded: ${failedRecord.error}\n`)
  }
}

process.stdout.write(
  `${experimentSlug}: ${results.length}/${expectedCount} saved.\n`,
)
