import { randomBytes } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {
  QUALITY_DIMENSIONS,
  ROUND_ID,
  assertPathInside,
  deterministicOrder,
  hashFile,
  hashJson,
  packetHash,
  parseArgs,
  readJson,
  readJsonl,
  sha256,
  writeJsonNew,
  writeTextNew,
} from './round-0820-lib.mjs'

function usage() {
  return [
    'Usage: node scripts/prepare-round-0820-blind.mjs [--run-dir <private-run-directory>]',
    '  [--output <new-private-blind-directory>] [--sealed-output <new-private-sealed-directory>]',
    '  [--baseline-input <gpt-baseline-input.jsonl> --baseline-output <gpt-baseline-output.jsonl>]',
    '  [--private-root <FSBP_Test/private/round-0820>]',
  ].join('\n')
}

const REQUIRED_ARTIFACTS = ['events', 'outcomes', 'candidateCache', 'final']
const TERMINAL_RUN_STATUSES = new Set(['complete', 'completed_with_failures'])
const REVIEWERS = [
  { packageCode: 'A', reviewerId: 'reviewer-A' },
  { packageCode: 'B', reviewerId: 'reviewer-B' },
  { packageCode: 'C', reviewerId: 'reviewer-C' },
]
const QUALITY_WEIGHTS = {
  fidelity: 0.25,
  naturalness: 0.20,
  style_voice: 0.15,
  structure_form: 0.10,
  terminology_logic: 0.10,
  overall_quality: 0.20,
}
const FORBIDDEN_DISTRIBUTION_IDENTITIES = [
  /GPT/i,
  /DeepSeek/i,
  /Agentic\s+Translating/i,
  /multi_fsbp/i,
]
const FORBIDDEN_DISTRIBUTION_CONTROL_HINTS = [
  /\b(?:condition|model)\s*[:=]/i,
  /(?:实验条件|候选来源|来源身份|模型)\s*[:=：]/,
  /\b(?:candidate|translation)\s*[AB]\s*(?:comes?\s+from|generated\s+by|uses?|maps?\s+to|corresponds?\s+to)\b/i,
  /(?:译文|候选)\s*[AB]\s*(?:来自|来源(?:是|为)?|由|使用|采用|对应)/,
  /(?:模型|系统)\s*\S.{0,40}(?:生成|产出|produced|generated).{0,20}(?:译文|候选|candidate|translation)\s*[AB]/i,
]

function pathsOverlap(left, right) {
  const resolvedLeft = path.resolve(left)
  const resolvedRight = path.resolve(right)
  const leftToRight = path.relative(resolvedLeft, resolvedRight)
  const rightToLeft = path.relative(resolvedRight, resolvedLeft)
  return (
    leftToRight === '' || rightToLeft === '' ||
    (!leftToRight.startsWith('..') && !path.isAbsolute(leftToRight)) ||
    (!rightToLeft.startsWith('..') && !path.isAbsolute(rightToLeft))
  )
}

async function resolveThroughExistingAncestor(target) {
  let cursor = path.resolve(target)
  const missingSegments = []
  while (true) {
    try {
      const existingRealPath = await realpath(cursor)
      return path.resolve(existingRealPath, ...missingSegments)
    } catch (error) {
      if (!(error && typeof error === 'object' && error.code === 'ENOENT')) throw error
      const parent = path.dirname(cursor)
      if (parent === cursor) {
        throw new Error(`No existing ancestor could be resolved for ${target}.`)
      }
      missingSegments.unshift(path.basename(cursor))
      cursor = parent
    }
  }
}

async function resolvePrivateTarget({
  privateRootReal,
  target,
  label,
}) {
  const requested = path.resolve(target)
  const resolved = await resolveThroughExistingAncestor(requested)
  assertPathInside(privateRootReal, resolved, label)
  return resolved
}

async function resolveBaselineSelection({ args, privateRoot }) {
  const hasInput = Object.hasOwn(args, 'baseline-input')
  const hasOutput = Object.hasOwn(args, 'baseline-output')
  if (hasInput !== hasOutput) {
    throw new Error('--baseline-input and --baseline-output must be provided together.')
  }
  if (Object.hasOwn(args, 'baseline')) {
    throw new Error('--baseline is not accepted; use --baseline-output together with --baseline-input.')
  }
  const inputPath = path.resolve(
    args['baseline-input'] ?? path.join(privateRoot, 'gpt-baseline-input.jsonl'),
  )
  const outputPath = path.resolve(
    args['baseline-output'] ?? path.join(privateRoot, 'gpt-baseline-output.jsonl'),
  )
  if (inputPath === outputPath) {
    throw new Error('Baseline input and output must be different files.')
  }
  for (const [label, file] of [['input', inputPath], ['output', outputPath]]) {
    if (path.extname(file).toLowerCase() !== '.jsonl') {
      throw new Error(`Baseline ${label} must be a .jsonl file.`)
    }
  }
  let inputStat
  let outputStat
  try {
    [inputStat, outputStat] = await Promise.all([stat(inputPath), stat(outputPath)])
  } catch (error) {
    throw new Error(
      `Selected baseline file does not exist or is not readable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  if (!inputStat.isFile() || !outputStat.isFile()) {
    throw new Error('Selected baseline input and output must both be files.')
  }
  const [privateRootReal, inputReal, outputReal] = await Promise.all([
    realpath(privateRoot),
    realpath(inputPath),
    realpath(outputPath),
  ])
  assertPathInside(privateRootReal, inputReal, 'baseline input')
  assertPathInside(privateRootReal, outputReal, 'baseline output')
  if (inputReal === outputReal) {
    throw new Error('Baseline input and output must resolve to different files.')
  }
  const auditPath = (file) => path.relative(privateRootReal, file).split(path.sep).join('/')
  return {
    inputPath: inputReal,
    outputPath: outputReal,
    auditPaths: {
      input: auditPath(inputReal),
      output: auditPath(outputReal),
    },
  }
}

async function verifyRunArtifacts(runDir, runManifest) {
  if (!TERMINAL_RUN_STATUSES.has(runManifest.status)) {
    throw new Error(
      `Run status ${String(runManifest.status)} is not terminal; expected complete or completed_with_failures.`,
    )
  }
  const records = {}
  for (const name of REQUIRED_ARTIFACTS) {
    const descriptor = runManifest.artifacts?.[name]
    if (
      !descriptor || typeof descriptor.path !== 'string' ||
      !/^[a-f0-9]{64}$/.test(descriptor.sha256) ||
      !Number.isInteger(descriptor.recordCount) || descriptor.recordCount < 0
    ) {
      throw new Error(`Run manifest has no complete integrity descriptor for ${name}.`)
    }
    const artifactPath = path.resolve(runDir, descriptor.path)
    assertPathInside(runDir, artifactPath, `${name} artifact`)
    let artifactRealPath
    let artifactStat
    try {
      artifactRealPath = await realpath(artifactPath)
      assertPathInside(runDir, artifactRealPath, `${name} artifact`)
      artifactStat = await stat(artifactRealPath)
    } catch (error) {
      if (error instanceof Error && error.message.includes('must stay inside')) throw error
      throw new Error(
        `${name} artifact must be an existing regular file: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    if (!artifactStat.isFile()) {
      throw new Error(`${name} artifact must be an existing regular file.`)
    }
    const actualHash = await hashFile(artifactRealPath)
    if (actualHash !== descriptor.sha256) {
      throw new Error(`${name} artifact hash mismatch.`)
    }
    const artifactRecords = await readJsonl(artifactRealPath)
    if (artifactRecords.length !== descriptor.recordCount) {
      throw new Error(`${name} artifact record count mismatch.`)
    }
    records[name] = artifactRecords
  }
  const allowedOutcomeStatuses = new Set([
    'complete', 'failed', 'precheck_failed', 'cancelled', 'incomplete_output',
  ])
  const invalidStatus = records.final.find((record) => !allowedOutcomeStatuses.has(record.status))
  if (invalidStatus) {
    throw new Error(`final artifact contains invalid status ${String(invalidStatus.status)}.`)
  }
  const complete = records.final.filter((record) => record.status === 'complete').length
  const failed = records.final.length - complete
  const latestOutcomes = new Map()
  for (const outcome of records.outcomes) {
    if (typeof outcome.outcomeKey !== 'string' || !outcome.outcomeKey) {
      throw new Error('outcomes artifact contains a record without outcomeKey.')
    }
    latestOutcomes.set(outcome.outcomeKey, outcome)
  }
  if (latestOutcomes.size !== records.final.length) {
    throw new Error('final artifact count does not match the latest outcomes snapshot.')
  }
  for (const record of records.final) {
    const latest = record.outcomeKey ? latestOutcomes.get(record.outcomeKey) : null
    if (!latest || hashJson(latest) !== hashJson(record)) {
      throw new Error(`final artifact does not match latest outcome ${String(record.outcomeKey)}.`)
    }
  }
  const counts = runManifest.resultCounts ?? {}
  const failedOutcomeKeys = records.final
    .filter((record) => record.status !== 'complete')
    .map((record) => record.outcomeKey)
  if (
    counts.total !== records.final.length || counts.complete !== complete ||
    counts.failed !== failed || counts.recordedAttempts !== records.events.length ||
    counts.recordedFailedAttempts !== records.events
      .filter((record) => record.status === 'failed').length ||
    counts.recordedIncompleteAttempts !== records.events
      .filter((record) => record.status === 'incomplete_output').length ||
    counts.cachedCandidateSets !== records.candidateCache.length ||
    hashJson(counts.failedOutcomeKeys ?? []) !== hashJson(failedOutcomeKeys)
  ) {
    throw new Error('Run result counts do not match the sealed artifact contents.')
  }
  if (
    (runManifest.status === 'complete' && failed !== 0) ||
    (runManifest.status === 'completed_with_failures' && failed === 0)
  ) {
    throw new Error('Run terminal status does not match final outcome statuses.')
  }
  return records
}

function quote(value) {
  return String(value ?? '')
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n')
}

function groupBySample(records) {
  const groups = new Map()
  for (const record of records) {
    const key = `${record.datasetName}:${record.sampleId}`
    const group = groups.get(key) ?? []
    group.push(record)
    groups.set(key, group)
  }
  return groups
}

function conditionMap(records, key) {
  const map = new Map()
  for (const record of records) {
    if (map.has(record.condition)) {
      throw new Error(`${key}: duplicate ${record.condition} result.`)
    }
    map.set(record.condition, record)
  }
  return map
}

function verifyMultiPair(raw, fsbp, key) {
  const fields = ['candidateSetHash', 'pairId', 'comparisonControlHash']
  for (const field of fields) {
    if (!raw[field] || raw[field] !== fsbp[field]) {
      throw new Error(`${key}: ${field} does not prove an exact raw/FSBP pair.`)
    }
  }
  if (
    raw.allowedDifference !== 'downstream_inherited_view_only' ||
    fsbp.allowedDifference !== 'downstream_inherited_view_only' ||
    raw.inheritedView !== 'raw' ||
    fsbp.inheritedView !== 'body'
  ) {
    throw new Error(`${key}: pair has an unapproved condition difference.`)
  }
}

function assertExactRecordKeys(record, expected, label) {
  const actual = Object.keys(record).sort()
  const wanted = [...expected].sort()
  if (actual.join(',') !== wanted.join(',')) {
    throw new Error(`${label}: expected exactly ${wanted.join(', ')}.`)
  }
}

async function validateExternalBaseline({
  baselineInputPath,
  baselineOutputPath,
  baselineAuditPaths,
  finalRecords,
  allowNonformal,
}) {
  const [inputs, outputs, inputFileSha256, outputFileSha256] = await Promise.all([
    readJsonl(baselineInputPath),
    readJsonl(baselineOutputPath),
    hashFile(baselineInputPath),
    hashFile(baselineOutputPath),
  ])
  const expectedCount = allowNonformal ? inputs.length : 24
  if (inputs.length !== expectedCount || outputs.length !== expectedCount) {
    throw new Error(
      `External GPT baseline must contain exactly ${expectedCount} input and ${expectedCount} output records; found ${inputs.length} and ${outputs.length}.`,
    )
  }
  if (!inputs.length) throw new Error('External GPT baseline input is empty.')
  const inputById = new Map()
  for (const [index, input] of inputs.entries()) {
    assertExactRecordKeys(
      input,
      ['id', 'direction', 'taskBrief', 'sourceText'],
      `${path.basename(baselineInputPath)}:${index + 1}`,
    )
    if (inputById.has(input.id)) throw new Error(`Duplicate baseline input id ${String(input.id)}.`)
    if (
      typeof input.id !== 'string' || !input.id ||
      !['en_to_zh', 'zh_to_en'].includes(input.direction) ||
      typeof input.taskBrief !== 'string' ||
      typeof input.sourceText !== 'string' || !input.sourceText.trim()
    ) throw new Error(`Invalid baseline input record ${index + 1}.`)
    inputById.set(input.id, input)
  }
  const agenticRecords = finalRecords.filter((record) => (
    record.experiment === 'translation_quality' && record.condition === 'multi_fsbp'
  ))
  const agenticById = new Map(agenticRecords.map((record) => [record.sampleId, record]))
  if (agenticRecords.length !== expectedCount || agenticById.size !== expectedCount) {
    throw new Error(
      `Agentic quality results must contain exactly ${expectedCount} unique multi_fsbp records; found ${agenticRecords.length} records and ${agenticById.size} unique IDs.`,
    )
  }
  const outputIds = new Set()
  const evidence = {}
  const records = outputs.map((output, index) => {
    const label = `${path.basename(baselineOutputPath)}:${index + 1}`
    assertExactRecordKeys(output, ['id', 'direction', 'translation'], label)
    if (typeof output.id !== 'string' || !output.id || outputIds.has(output.id)) {
      throw new Error(`${label}: id must be unique and non-empty.`)
    }
    outputIds.add(output.id)
    const input = inputById.get(output.id)
    const agentic = agenticById.get(output.id)
    if (!input) throw new Error(`${label}: id is not present in the frozen baseline input.`)
    if (!agentic) throw new Error(`${label}: no Agentic multi_fsbp result exists for ${output.id}.`)
    if (output.direction !== input.direction || agentic.direction !== input.direction) {
      throw new Error(`${label}: direction does not match the frozen source and Agentic result.`)
    }
    if (agentic.sourceText !== input.sourceText) {
      throw new Error(`${label}: Agentic source text differs from the frozen baseline input.`)
    }
    if (agentic.status !== 'complete' || typeof agentic.text !== 'string' || !agentic.text.trim()) {
      throw new Error(`${label}: Agentic translation is not complete and non-empty.`)
    }
    if (typeof agentic.taskBrief !== 'string') {
      throw new Error(`${label}: Agentic task brief is unavailable.`)
    }
    if (typeof output.translation !== 'string' || !output.translation.trim()) {
      throw new Error(`${label}: external GPT translation must be non-empty.`)
    }
    const sourceSha256 = sha256(input.sourceText)
    const translationSha256 = sha256(output.translation)
    const runTaskBrief = agentic.taskBrief
    evidence[output.id] = {
      sourceSha256,
      translationSha256,
      baselineTaskBriefHash: sha256(input.taskBrief),
      runTaskBriefHash: sha256(runTaskBrief),
      taskBriefMatches: input.taskBrief === runTaskBrief,
    }
    return {
      ...agentic,
      outcomeId: `external-gpt-baseline:${output.id}`,
      outcomeKey: `quality:${output.id}:external_gpt_baseline`,
      condition: 'external_gpt_baseline',
      status: 'complete',
      text: output.translation,
      raw: output.translation,
      sourceText: input.sourceText,
      taskBrief: runTaskBrief,
    }
  })
  const missingOutputs = [...inputById.keys()].filter((id) => !outputIds.has(id))
  if (missingOutputs.length) {
    throw new Error(`External GPT baseline is missing id(s): ${missingOutputs.join(', ')}.`)
  }
  return {
    records,
    evidence: {
      inputFileSha256,
      outputFileSha256,
      recordCount: records.length,
      selectedFiles: {
        input: { path: baselineAuditPaths.input, sha256: inputFileSha256 },
        output: { path: baselineAuditPaths.output, sha256: outputFileSha256 },
      },
      perSampleHashes: evidence,
    },
  }
}

function prepareKind({ kind, requiredConditions, records, seed, runManifest }) {
  const items = []
  const mapping = {}
  const systemFailures = []
  for (const [key, group] of groupBySample(records)) {
    const byCondition = conditionMap(group, key)
    const missing = requiredConditions.filter((condition) => !byCondition.has(condition))
    const failed = requiredConditions
      .map((condition) => byCondition.get(condition))
      .filter((record) => record && record.status !== 'complete')
    const unusable = requiredConditions
      .map((condition) => byCondition.get(condition))
      .filter((record) => (
        record?.status === 'complete' &&
        (typeof record.text !== 'string' || !record.text.trim())
      ))
    const representative = byCondition.get(requiredConditions[0])
    const invalidSource = (
      representative?.status === 'complete' &&
      (typeof representative.sourceText !== 'string' || !representative.sourceText.trim())
    )
    if (missing.length || failed.length || unusable.length || invalidSource) {
      systemFailures.push({
        itemId: key,
        sampleId: group[0]?.sampleId ?? key,
        missingConditions: missing,
        failedConditions: [
          ...failed.map((record) => ({
            condition: record.condition,
            errorCode: record.errorCode ?? 'unknown_failure',
            error: record.error ?? 'No error detail recorded.',
          })),
          ...unusable.map((record) => ({
            condition: record.condition,
            errorCode: 'empty_translation_text',
            error: 'Completed result has no non-empty translation text.',
          })),
          ...(invalidSource ? [{
            condition: 'source',
            errorCode: 'empty_source_text',
            error: 'Completed result has no non-empty source text.',
          }] : []),
        ],
      })
      continue
    }
    const raw = byCondition.get('multi_raw')
    const fsbp = byCondition.get('multi_fsbp')
    if (raw?.status === 'complete' && fsbp?.status === 'complete') {
      verifyMultiPair(raw, fsbp, key)
    }
    const labels = deterministicOrder(
      requiredConditions,
      seed,
      `${kind}:${key}`,
    ).map((condition, index) => ({
      label: String.fromCharCode(65 + index),
      condition,
    }))
    const itemId = sha256(
      `${runManifest.runId}\u0000${kind}\u0000${key}`,
    ).slice(0, 20)
    mapping[itemId] = Object.fromEntries(
      labels.map(({ label, condition }) => [label, condition]),
    )
    const item = {
      itemId,
      direction: representative.direction,
      category: representative.category,
      sourceText: representative.sourceText,
      taskBrief: representative.taskBrief,
      candidates: labels.map(({ label, condition }) => ({
        label,
        text: byCondition.get(condition).text,
      })),
    }
    if (kind === 'isolation') {
      item.targetedError = representative.targetedError
      item.errorEvidence = representative.errorEvidence
    }
    items.push(item)
  }
  items.sort((left, right) => left.itemId.localeCompare(right.itemId))
  systemFailures.sort((left, right) => left.itemId.localeCompare(right.itemId))
  const packetId = `${ROUND_ID}-${kind}-${sha256(
    `${runManifest.runId}\u0000${seed}\u0000${kind}`,
  ).slice(0, 16)}`
  return {
    packetId,
    items,
    mapping,
    systemFailures,
    candidateLabels: requiredConditions.map((_, index) => String.fromCharCode(65 + index)),
  }
}

function buildPacket({
  kind,
  prepared,
  runManifest,
  blindKeySha256,
  seedSha256,
  baselineEvidence = null,
}) {
  const packet = {
    schemaVersion: '1.0.0',
    roundId: ROUND_ID,
    namespace: 'fsbp',
    packetId: prepared.packetId,
    kind,
    createdAt: new Date().toISOString(),
    runId: runManifest.runId,
    freezeManifestSha256: runManifest.freezeManifestSha256,
    blindKeySha256,
    randomizationSeedSha256: seedSha256,
    ...(kind === 'quality' ? {
      externalBaseline: {
        inputFileSha256: baselineEvidence.inputFileSha256,
        outputFileSha256: baselineEvidence.outputFileSha256,
        recordCount: baselineEvidence.recordCount,
      },
    } : {}),
    rubric: kind === 'quality'
      ? {
          id: 'translation-quality-v1',
          dimensions: QUALITY_DIMENSIONS,
          scoreRange: [1, 10],
          weights: QUALITY_WEIGHTS,
          weightedTotalRange: [10, 100],
          weightedTotalFormula: '10 * sum(score_i * weight_i) / sum(applicable_weight_i)',
          rankingAllowsTies: true,
          unableToJudgeAllowed: true,
        }
      : {
          id: 'annotation-isolation-v1',
          outcomes: ['corrected', 'rejected', 'retained', 'amplified', 'unclear'],
          targetedErrorConfirmationRequired: true,
        },
    blinding: {
      hidden: ['condition', 'model', 'run_order', 'annotation'],
      candidateLabels: prepared.candidateLabels,
    },
    items: prepared.items,
    systemFailures: prepared.systemFailures.map((failure) => ({
      itemId: failure.itemId,
      sampleId: failure.sampleId,
      failureCount: failure.missingConditions.length + failure.failedConditions.length,
      reasonCodes: [
        ...failure.missingConditions.map(() => 'missing_condition_result'),
        ...failure.failedConditions.map((entry) => entry.errorCode),
      ].sort(),
    })),
    counts: {
      eligible: prepared.items.length,
      systemFailures: prepared.systemFailures.length,
      total: prepared.items.length + prepared.systemFailures.length,
    },
  }
  packet.packetHash = packetHash(packet)
  return packet
}

function reviewTemplates(packet, reviewerType) {
  return packet.items.map((item) => packet.kind === 'quality'
    ? {
        schemaVersion: '1.0.0',
        namespace: 'fsbp',
        packetId: packet.packetId,
        packetHash: packet.packetHash,
        kind: 'quality',
        reviewerType,
        reviewerId: '',
        itemId: item.itemId,
        unableToJudge: false,
        candidateScores: Object.fromEntries(
          item.candidates.map(({ label }) => [
            label,
            Object.fromEntries(QUALITY_DIMENSIONS.map((dimension) => [dimension, null])),
          ]),
        ),
        ranking: [],
        severeErrors: [],
        revisionNeeded: Object.fromEntries(
          item.candidates.map(({ label }) => [label, null]),
        ),
        confidence: '',
        rationale: '',
      }
    : {
        schemaVersion: '1.0.0',
        namespace: 'fsbp',
        packetId: packet.packetId,
        packetHash: packet.packetHash,
        kind: 'isolation',
        reviewerType,
        reviewerId: '',
        itemId: item.itemId,
        targetedErrorConfirmed: null,
        outcomes: Object.fromEntries(
          item.candidates.map(({ label }) => [label, '']),
        ),
        confidence: '',
        rationale: '',
      })
}

function csvEscape(value) {
  const text = String(value ?? '')
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function csvText(headers, rows) {
  return `\ufeff${[
    headers,
    ...rows.map((row) => headers.map((header) => row[header] ?? '')),
  ].map((row) => row.map(csvEscape).join(',')).join('\r\n')}\r\n`
}

function qualityCsv(packet) {
  const labels = packet.blinding.candidateLabels
  const headers = [
    'itemId', 'unableToJudge',
    ...labels.flatMap((label) => [
      ...QUALITY_DIMENSIONS.map((dimension) => `${label}_${dimension}`),
      `${label}_revisionNeeded`,
      `${label}_severeErrorLocation`,
      `${label}_severeErrorCategory`,
      `${label}_severeErrorSeverity`,
      `${label}_severeErrorEvidence`,
    ]),
    'ranking', 'confidence', 'rationale',
  ]
  const rows = packet.items.map((item) => ({
    itemId: item.itemId,
    unableToJudge: 'false',
  }))
  return csvText(headers, rows)
}

function scoringStandardMarkdown(packet) {
  const labels = packet.blinding.candidateLabels.join('、')
  return `# 05 · 翻译质量评分标准

译文 A、译文 B 是两份文本的匿名编号。请针对每条原文分别评价译文 ${labels}，只依据文本质量打分。三位审核者收到的原文、译文顺序、评分维度和权重完全相同。

## 六个固定维度、权重与判分

| 固定字段 | 中文含义 | 权重 | 主要判断 |
| --- | --- | ---: | --- |
| \`fidelity\` | 忠实度 | 25% | 信息、关系、语气有无错译、漏译或擅增 |
| \`naturalness\` | 自然度 | 20% | 目标语言是否自然、流畅、易读 |
| \`style_voice\` | 风格与声音 | 15% | 文体、叙述声音、修辞和语域是否贴合 |
| \`structure_form\` | 结构与形式 | 10% | 段落、句法、诗行或论证结构是否处理妥当 |
| \`terminology_logic\` | 术语与逻辑 | 10% | 术语、指代、因果和逻辑是否稳定；确实不适用可填 \`N/A\` |
| \`overall_quality\` | 总体质量 | 20% | 综合判断这份译文是否达到可交付水平 |

每项使用 1–10 分：1–2 分为严重错误、基本不可用；3–4 分为问题明显；5–6 分为基本可用但需要较多修改；7–8 分为良好，仅需少量修改；9–10 分为优秀，可直接或近乎直接交付。加权总分由程序计算：\`10 × Σ(维度分 × 权重) ÷ Σ(适用维度权重)\`，理论范围为 10–100。\`terminology_logic=N/A\` 时，程序只在其余五项权重内归一化；审核者无需手算总分。

## 固定填写规则

在 \`02-质量评分表.csv\` 中，每行对应一条原文。为 ${labels} 的六个维度分别填分；\`revisionNeeded\` 只填 \`true\` 或 \`false\`。\`ranking\` 用 \`A>B\`、\`B>A\` 或 \`A=B\`，等号表示确实无法区分的平局。\`confidence\` 只填 \`high\`、\`medium\` 或 \`low\`，\`rationale\` 写一至三句可以回到原文核对的理由。

发现严重问题时，在相应译文的四个 \`severeError...\` 栏填写位置、类型、严重程度和证据；严重程度只填 \`major\` 或 \`critical\`。没有严重错误时四栏全部留空。同一译文有多项时，四栏填影响最大的一项，其余写入 \`rationale\`。

整条因原文损坏、语言能力范围或其他客观原因无法判断时，将 \`unableToJudge\` 改为 \`true\`，所有分数、排序、修改判断和严重错误栏留空，\`confidence\` 填 \`low\`，并在 \`rationale\` 说明原因。不要用“无法判断”代替普通的低分或平局。
`
}

function reviewerReadme(reviewerId) {
  return `# 从这里开始 · 匿名译文质量盲审 ${reviewerId}

你的任务只有一项：比较每条原文下的译文 A、译文 B，给出质量分数和总体排序。不需要检查文件或任何技术信息。

1. 先读 \`05-翻译质量评分标准.md\`，统一理解六个维度和 1–10 分量表。
2. 打开 \`01-原文与匿名译文.md\`，按顺序阅读每条原文及 A、B 两份译文。
3. 用表格软件填写 \`02-质量评分表.csv\`。每行的评分位已预留，只填评分、排序、修订判断、置信度和理由；需要时可修改 \`unableToJudge\`，\`itemId\` 保持原样。
4. 完成后同时交回填写好的 \`02-质量评分表.csv\` 和原样保留的 \`03-回传凭证.json\`。凭证用于确认随包文件属于这一份分发包；填写后的 CSV 仍由交回流程与该凭证成对归档。请勿打开、编辑、改名或与其他审核者交换凭证。

请独立完成，不搜索现成译文，不使用自动工具重译，也不查看包外文件。评分时始终只根据原文和译文 A、B 的实际表现。
`
}

function returnInstructions() {
  return `# 04 · 交回文件说明

请同时交回已经填写完整的 \`02-质量评分表.csv\` 和原样保留的 \`03-回传凭证.json\`。不要改文件名，不要删除行，不要增加译文列，也不要打开、编辑或交换回传凭证。凭证只绑定本分发包，不包含译文来源、模型或实验条件。发现无法判断的条目时，按评分标准填写 \`unableToJudge\` 与理由。

研究者会用脚本检查固定字段、分值范围、漏填和重复条目。你只需确保 24 行都已按标准完成。
`
}

function assertAnonymousDistribution(files, reviewerId) {
  for (const [file, content] of Object.entries(files)) {
    if (FORBIDDEN_DISTRIBUTION_IDENTITIES.some((pattern) => pattern.test(content))) {
      throw new Error(`${reviewerId}/${file}: reviewer package exposes a system identity.`)
    }
    if (
      file !== '01-原文与匿名译文.md' &&
      FORBIDDEN_DISTRIBUTION_CONTROL_HINTS.some((pattern) => pattern.test(content))
    ) {
      throw new Error(`${reviewerId}/${file}: reviewer package exposes a source hint.`)
    }
  }
}

async function writeReviewerPackages(outputDir, packet) {
  const materials = packetMarkdown(packet)
  const standard = scoringStandardMarkdown(packet)
  const boundReviewers = REVIEWERS.map((reviewer) => ({
    ...reviewer,
    reviewerPackageId: `rp-${randomBytes(12).toString('hex')}`,
    reviewerToken: randomBytes(32).toString('hex'),
  }))
  if (
    new Set(boundReviewers.map((entry) => entry.reviewerPackageId)).size !==
      boundReviewers.length ||
    new Set(boundReviewers.map((entry) => entry.reviewerToken)).size !==
      boundReviewers.length
  ) {
    throw new Error('Reviewer return credentials must be unique; regenerate the blind packages.')
  }
  await Promise.all(boundReviewers.flatMap(({
    packageCode,
    reviewerId,
    reviewerPackageId,
    reviewerToken,
  }) => {
    const reviewerDir = path.join(outputDir, `04-human-review-${packageCode}`)
    const reviewerTokenHash = sha256(reviewerToken)
    const returnCredential = {
      schemaVersion: '1.0.0',
      roundId: ROUND_ID,
      namespace: 'fsbp',
      credentialKind: 'human_review_return_credential',
      packetId: packet.packetId,
      packetHash: packet.packetHash,
      reviewerPackageId,
      reviewerToken,
      reviewerTokenHash,
    }
    const returnCredentialText = `${JSON.stringify(returnCredential, null, 2)}\n`
    const files = {
      '00-从这里开始.md': reviewerReadme(reviewerId),
      '01-原文与匿名译文.md': materials,
      '02-质量评分表.csv': qualityCsv(packet),
      '03-回传凭证.json': returnCredentialText,
      '04-交回文件说明.md': returnInstructions(),
      '05-翻译质量评分标准.md': standard,
    }
    assertAnonymousDistribution(files, reviewerId)
    const packageManifest = {
      schemaVersion: '1.0.0',
      roundId: ROUND_ID,
      namespace: 'fsbp',
      packageKind: 'blinded_translation_quality_review',
      reviewerId,
      reviewerPackageId,
      reviewerTokenHash,
      packetId: packet.packetId,
      packetHash: packet.packetHash,
      itemCount: packet.items.length,
      translationLabels: packet.blinding.candidateLabels,
      files: Object.entries(files).map(([file, content]) => ({
        file,
        sha256: sha256(content),
        bytes: Buffer.byteLength(content, 'utf8'),
      })),
    }
    return [
      ...Object.entries(files).map(([file, content]) => (
        writeTextNew(path.join(reviewerDir, file), content)
      )),
      writeJsonNew(
        path.join(outputDir, 'reviewer-package-manifests', `reviewer-${packageCode}.json`),
        packageManifest,
      ),
    ]
  }))
}

function jsonl(records) {
  return records.length
    ? `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
    : ''
}

function packetMarkdown(packet) {
  const lines = [
    `# ${packet.kind === 'quality' ? '译文质量' : 'FSBP 注释隔离'}匿名评审包`,
    '',
    `评审包：\`${packet.packetId}\``,
    '',
    '译文 A、B 的展示顺序已经固定。请独立阅读，只按文本质量评分。',
    '',
    `可评项目：${packet.counts.eligible}；系统失败：${packet.counts.systemFailures}。系统失败完整保存在 JSON 包中，不进入质量判断。`,
  ]
  for (const [index, item] of packet.items.entries()) {
    lines.push(
      '',
      `## ${index + 1}. ${item.itemId}`,
      '',
      `方向：${item.direction}`,
      `类别：${item.category ?? '未分类'}`,
      '',
      '### 任务要求',
      '',
      item.taskBrief || '无额外要求',
      '',
      '### 原文',
      '',
      quote(item.sourceText),
    )
    if (packet.kind === 'isolation') {
      lines.push(
        '',
        '### 待检查的正文问题',
        '',
        item.targetedError || '未提供',
        '',
        '证据：',
        '',
        item.errorEvidence || '未提供',
      )
    }
    for (const candidate of item.candidates) {
      lines.push('', `### 译文 ${candidate.label}`, '', quote(candidate.text))
    }
  }
  return `${lines.join('\n')}\n`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.seed !== undefined) {
    throw new Error('--seed is not accepted; blind randomization uses a fresh cryptographic secret.')
  }
  const privateRoot = path.resolve(
    args['private-root'] ?? path.join(process.cwd(), 'FSBP_Test', 'private', ROUND_ID),
  )
  const privateRootReal = await realpath(privateRoot)
  let requestedRunDir
  if (args['run-dir']) {
    requestedRunDir = path.resolve(args['run-dir'])
  } else {
    const freeze = await readJson(path.join(privateRoot, 'freeze-manifest.json'))
    const defaultRunId = `${ROUND_ID}-${freeze.freezeManifestSha256.slice(0, 12)}`
    requestedRunDir = path.join(privateRoot, 'runs', args['run-id'] ?? defaultRunId)
  }
  const runDir = await resolvePrivateTarget({
    privateRootReal,
    target: requestedRunDir,
    label: 'run input',
  })
  const runManifest = await readJson(path.join(runDir, 'run-manifest.json'))
  if (runManifest.roundId !== ROUND_ID || runManifest.namespace !== 'fsbp') {
    throw new Error(`Run is not in the ${ROUND_ID} fsbp namespace.`)
  }
  const requestedOutputDir = path.resolve(
    args.output ?? path.join(
      privateRoot,
      'blind',
      runManifest.runId,
    ),
  )
  const outputDir = await resolvePrivateTarget({
    privateRootReal,
    target: requestedOutputDir,
    label: 'blind output',
  })
  const requestedSealedDir = path.resolve(
    args['sealed-output'] ?? path.join(privateRoot, 'sealed', runManifest.runId),
  )
  const sealedDir = await resolvePrivateTarget({
    privateRootReal,
    target: requestedSealedDir,
    label: 'sealed blind-key output',
  })
  if (pathsOverlap(runDir, outputDir)) {
    throw new Error('Blind output must be separate from the run directory.')
  }
  if (pathsOverlap(runDir, sealedDir)) {
    throw new Error('Sealed blind-key output must be separate from the run directory.')
  }
  if (pathsOverlap(outputDir, sealedDir)) {
    throw new Error('Sealed blind-key output must be separate from the human packet directory.')
  }
  const verifiedArtifacts = await verifyRunArtifacts(runDir, runManifest)
  const finalRecords = verifiedArtifacts.final
  const baselineSelection = await resolveBaselineSelection({ args, privateRoot })
  const baselineInputPath = baselineSelection.inputPath
  const baselineOutputPath = baselineSelection.outputPath
  const externalBaseline = await validateExternalBaseline({
    baselineInputPath,
    baselineOutputPath,
    baselineAuditPaths: baselineSelection.auditPaths,
    finalRecords,
    allowNonformal: args['allow-nonformal'] === true,
  })
  const seed = randomBytes(32).toString('hex')
  const seedSha256 = sha256(seed)

  const qualityPrepared = prepareKind({
    kind: 'quality',
    requiredConditions: ['external_gpt_baseline', 'multi_fsbp'],
    records: [
      ...finalRecords.filter((record) => record.experiment === 'translation_quality'),
      ...externalBaseline.records,
    ],
    seed,
    runManifest,
  })
  const isolationPrepared = prepareKind({
    kind: 'isolation',
    requiredConditions: ['multi_raw', 'multi_fsbp'],
    records: finalRecords.filter((record) => record.experiment === 'annotation_isolation'),
    seed,
    runManifest,
  })
  if (!qualityPrepared.items.length) {
    throw new Error(
      'No eligible quality item contains both a complete external GPT baseline and a complete Agentic translation; refusing to create a source-only or empty human-review package.',
    )
  }

  const blindKey = {
    schemaVersion: '1.0.0',
    roundId: ROUND_ID,
    namespace: 'fsbp',
    runId: runManifest.runId,
    freezeManifestSha256: runManifest.freezeManifestSha256,
    randomizationSecret: seed,
    seedSha256,
    externalBaseline: externalBaseline.evidence,
    packets: {
      quality: {
        packetId: qualityPrepared.packetId,
        mapping: qualityPrepared.mapping,
        systemFailures: qualityPrepared.systemFailures,
      },
      isolation: {
        packetId: isolationPrepared.packetId,
        mapping: isolationPrepared.mapping,
        systemFailures: isolationPrepared.systemFailures,
      },
    },
  }
  const blindKeySha256 = hashJson(blindKey)
  const qualityPacket = buildPacket({
    kind: 'quality',
    prepared: qualityPrepared,
    runManifest,
    blindKeySha256,
    seedSha256,
    baselineEvidence: externalBaseline.evidence,
  })
  const isolationPacket = buildPacket({
    kind: 'isolation',
    prepared: isolationPrepared,
    runManifest,
    blindKeySha256,
    seedSha256,
  })
  const manifest = {
    schemaVersion: '1.0.0',
    roundId: ROUND_ID,
    namespace: 'fsbp',
    runId: runManifest.runId,
    createdAt: new Date().toISOString(),
    freezeManifestSha256: runManifest.freezeManifestSha256,
    blindKeySha256,
    randomizationSeedSha256: seedSha256,
    sealedKeyId: sha256(`${runManifest.runId}\u0000${blindKeySha256}`).slice(0, 24),
    externalBaselineAudit: externalBaseline.evidence.selectedFiles,
    packets: {
      quality: { file: 'quality-packet.json', packetHash: qualityPacket.packetHash },
      isolation: { file: 'isolation-packet.json', packetHash: isolationPacket.packetHash },
    },
    policy: {
      decodeRequiresValidatedFrozenHumanFiles: true,
      failureRecordsRetained: true,
    },
  }

  await Promise.all([
    writeJsonNew(path.join(outputDir, 'blind-manifest.json'), manifest),
    writeJsonNew(path.join(sealedDir, 'blind-key.json'), blindKey),
    writeJsonNew(path.join(outputDir, 'quality-packet.json'), qualityPacket),
    writeJsonNew(path.join(outputDir, 'isolation-packet.json'), isolationPacket),
    writeTextNew(path.join(outputDir, 'quality-packet.md'), packetMarkdown(qualityPacket)),
    writeTextNew(path.join(outputDir, 'isolation-packet.md'), packetMarkdown(isolationPacket)),
    writeTextNew(
      path.join(outputDir, 'quality-human-template.jsonl'),
      jsonl(reviewTemplates(qualityPacket, 'human')),
    ),
    writeTextNew(
      path.join(outputDir, 'isolation-human-template.jsonl'),
      jsonl(reviewTemplates(isolationPacket, 'human')),
    ),
    writeTextNew(
      path.join(outputDir, 'quality-ai-template.jsonl'),
      jsonl(reviewTemplates(qualityPacket, 'ai')),
    ),
    writeTextNew(
      path.join(outputDir, 'isolation-ai-template.jsonl'),
      jsonl(reviewTemplates(isolationPacket, 'ai')),
    ),
    writeReviewerPackages(outputDir, qualityPacket),
  ])
  process.stdout.write(`${JSON.stringify({
    outputDir,
    sealedDir,
    quality: qualityPacket.counts,
    isolation: isolationPacket.counts,
    blindKeySha256,
  }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
