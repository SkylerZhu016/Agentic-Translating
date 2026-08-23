import { execFile } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import {
  ROUND_ID,
  assertPathInside,
  assertNonEmptyString,
  assertPlainObject,
  canonicalJson,
  hashFile,
  hashJson,
  parseArgs,
  parseSemanticOutput,
  portableRelative,
  readJson,
  readJsonl,
  resolvePortable,
  sha256,
  writeJsonNew,
} from './round-0820-lib.mjs'

const execFileAsync = promisify(execFile)
const SECRET_KEY_PATTERN = /(?:api[_-]?key|authorization|password|secret|access[_-]?token)/i
const GPT_MODEL = 'GPT 5.6 Sol: CPA'

function usage() {
  return [
    'Usage: node scripts/freeze-round-0820.mjs [--config <private-config.json>]',
    '  [--output <freeze-manifest.json>] [--repo-root <repository>]',
    '  [--mode development|formal]',
  ].join('\n')
}

function assertNoEmbeddedSecrets(value, trail = []) {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    const nextTrail = [...trail, key]
    if (SECRET_KEY_PATTERN.test(key) && key !== 'apiKeyEnv') {
      throw new Error(
        `Freeze config must reference credentials by environment variable; embedded secret field found at ${nextTrail.join('.')}.`,
      )
    }
    assertNoEmbeddedSecrets(child, nextTrail)
  }
}

function assertNoLocaleFields(value, trail = []) {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    const nextTrail = [...trail, key]
    if (/^(?:locale|uiLocale|ui_locale)$/i.test(key)) {
      throw new Error(
        `UI locale belongs to the i18n namespace and cannot enter the fsbp freeze: ${nextTrail.join('.')}.`,
      )
    }
    assertNoLocaleFields(child, nextTrail)
  }
}

function validatePromptBundle(bundle) {
  assertPlainObject(bundle, 'promptBundle')
  assertNonEmptyString(bundle.direct, 'promptBundle.direct')
  const analysis = Array.isArray(bundle.analysis)
    ? bundle.analysis
    : [bundle.analysis]
  if (!analysis.length || analysis.some((prompt) => typeof prompt !== 'string' || !prompt.trim())) {
    throw new Error('promptBundle.analysis must be a prompt or non-empty prompt array.')
  }
  const candidate = Array.isArray(bundle.candidate)
    ? bundle.candidate
    : [bundle.candidate]
  if (!candidate.length || candidate.some((prompt) => typeof prompt !== 'string' || !prompt.trim())) {
    throw new Error('promptBundle.candidate must be a prompt or non-empty prompt array.')
  }
  assertPlainObject(bundle.stages, 'promptBundle.stages')
  for (const stage of ['review', 'filter', 'orchestrate', 'assemble']) {
    assertNonEmptyString(bundle.stages[stage], `promptBundle.stages.${stage}`)
  }
}

function validateModels(models) {
  assertPlainObject(models, 'models')
  assertNonEmptyString(models.direct, 'models.direct')
  if (!Array.isArray(models.analysis) || models.analysis.length !== 2) {
    throw new Error('models.analysis must contain exactly two model IDs.')
  }
  if (!Array.isArray(models.candidates) || models.candidates.length !== 3) {
    throw new Error('models.candidates must contain exactly three model IDs.')
  }
  for (const [index, model] of models.analysis.entries()) {
    assertNonEmptyString(model, `models.analysis[${index}]`)
  }
  for (const [index, model] of models.candidates.entries()) {
    assertNonEmptyString(model, `models.candidates[${index}]`)
  }
  assertNonEmptyString(models.editor, 'models.editor')
  assertNonEmptyString(models.fallbackModel, 'models.fallbackModel')

  if (models.direct !== GPT_MODEL) {
    throw new Error(`round-0820 models.direct must be ${GPT_MODEL}.`)
  }
  if (models.analysis.some((model) => model !== GPT_MODEL)) {
    throw new Error(`round-0820 models.analysis must be [${GPT_MODEL}, ${GPT_MODEL}].`)
  }
  const expectedCandidates = [GPT_MODEL, GPT_MODEL, GPT_MODEL]
  if (models.candidates.some((model, index) => model !== expectedCandidates[index])) {
    throw new Error(
      `round-0820 models.candidates must be [${expectedCandidates.join(', ')}].`,
    )
  }
  if (models.editor !== GPT_MODEL) {
    throw new Error(
      `round-0820 models.editor must be ${GPT_MODEL}; review, filter, orchestrate, and assemble all use this editor binding.`,
    )
  }
  if (models.fallbackModel !== GPT_MODEL) {
    throw new Error(`round-0820 models.fallbackModel must be ${GPT_MODEL}.`)
  }
}

function validateParameters(parameters) {
  assertPlainObject(parameters, 'parameters')
  const numeric = ['temperature', 'maxTokens', 'timeoutMs', 'retries', 'fallbackAttempts']
  for (const key of numeric) {
    if (typeof parameters[key] !== 'number' || !Number.isFinite(parameters[key])) {
      throw new Error(`parameters.${key} must be a finite number.`)
    }
  }
  if (parameters.temperature < 0 || parameters.temperature > 2) {
    throw new Error('parameters.temperature must be between 0 and 2.')
  }
  if (parameters.maxTokens !== 131_072) {
    throw new Error('round-0820 parameters.maxTokens must be exactly 131072.')
  }
  if (parameters.sampleConcurrency !== 5) {
    throw new Error('round-0820 parameters.sampleConcurrency must be exactly 5.')
  }
  if (parameters.fallbackAttempts !== 1) {
    throw new Error('round-0820 parameters.fallbackAttempts must be exactly 1.')
  }
  if (parameters.timeoutMs !== 900_000) {
    throw new Error('round-0820 parameters.timeoutMs must be exactly 900000.')
  }
  if (!Number.isInteger(parameters.retries) || parameters.retries < 0 || parameters.retries > 10) {
    throw new Error('parameters.retries must be an integer from 0 through 10.')
  }
}

function validateEndpoint(endpoint) {
  assertPlainObject(endpoint, 'endpoint')
  const expectedKeys = ['apiKeyEnv', 'baseUrl', 'chatCompletionsPath']
  const actualKeys = Object.keys(endpoint).sort()
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error('endpoint may contain only baseUrl, chatCompletionsPath, and apiKeyEnv.')
  }
  const baseUrl = assertNonEmptyString(endpoint.baseUrl, 'endpoint.baseUrl')
  let parsed
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error('endpoint.baseUrl must be an absolute HTTP(S) URL.')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('endpoint.baseUrl must use HTTP or HTTPS.')
  }
  const chatCompletionsPath = assertNonEmptyString(
    endpoint.chatCompletionsPath,
    'endpoint.chatCompletionsPath',
  )
  if (!chatCompletionsPath.startsWith('/')) {
    throw new Error('endpoint.chatCompletionsPath must start with /.')
  }
  if (endpoint.apiKeyEnv !== 'FSBP_EXPERIMENT_API_KEY') {
    throw new Error('endpoint.apiKeyEnv must be FSBP_EXPERIMENT_API_KEY.')
  }
}

async function git(repositoryRoot, args) {
  const { stdout } = await execFileAsync('git', ['-C', repositoryRoot, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  })
  return stdout.trim()
}

async function inspectDataset(repositoryRoot, name, descriptor) {
  assertPlainObject(descriptor, `datasets.${name}`)
  const portablePath = assertNonEmptyString(descriptor.path, `datasets.${name}.path`)
  const datasetPath = resolvePortable(repositoryRoot, portablePath)
  const records = await readJsonl(datasetPath)
  if (!records.length) throw new Error(`datasets.${name} is empty.`)
  if (!Number.isInteger(descriptor.expectedCount) || descriptor.expectedCount < 1) {
    throw new Error(`datasets.${name}.expectedCount must be a positive integer.`)
  }
  if (records.length !== descriptor.expectedCount) {
    throw new Error(
      `datasets.${name} expected ${descriptor.expectedCount} records, found ${records.length}.`,
    )
  }
  const ids = records.map((record, index) => {
    const id = assertNonEmptyString(record.id, `datasets.${name}[${index}].id`)
    if (!['en_to_zh', 'zh_to_en'].includes(record.direction)) {
      throw new Error(`datasets.${name}[${index}].direction is invalid.`)
    }
    return id
  })
  if (new Set(ids).size !== ids.length) {
    throw new Error(`datasets.${name} contains duplicate sample IDs.`)
  }
  return {
    name,
    kind: descriptor.kind ?? name,
    path: portableRelative(repositoryRoot, datasetPath),
    expectedCount: records.length,
    sha256: await hashFile(datasetPath),
    recordHashes: Object.fromEntries(
      records.map((record) => [record.id, hashJson(record)]),
    ),
    records,
  }
}

function requireFormalString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Formal freeze: ${label} must be a non-empty string.`)
  }
}

function validateFormalQuality(records) {
  if (records.length !== 24) {
    throw new Error(`Formal freeze: quality dataset must contain exactly 24 records, found ${records.length}.`)
  }
  const directionCounts = { en_to_zh: 0, zh_to_en: 0 }
  const categoryCounts = {
    poetry: 0,
    literary: 0,
    cultural_argument: 0,
    nonliterary: 0,
  }
  const crossCounts = {}
  for (const [index, record] of records.entries()) {
    const label = `quality[${index}] (${record.id ?? 'missing-id'})`
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.id ?? '')) {
      throw new Error(`Formal freeze: ${label}.id does not match the quality schema.`)
    }
    if (!(record.direction in directionCounts)) {
      throw new Error(`Formal freeze: ${label}.direction is invalid.`)
    }
    if (!(record.category in categoryCounts)) {
      throw new Error(`Formal freeze: ${label}.category is invalid.`)
    }
    requireFormalString(record.sourceText, `${label}.sourceText`)
    requireFormalString(record.taskBrief, `${label}.taskBrief`)
    requireFormalString(record.selectionReason, `${label}.selectionReason`)
    if (!record.source || typeof record.source !== 'object' || Array.isArray(record.source)) {
      throw new Error(`Formal freeze: ${label}.source must follow the quality schema.`)
    }
    requireFormalString(record.source.author, `${label}.source.author`)
    requireFormalString(record.source.title, `${label}.source.title`)
    requireFormalString(record.source.rightsBasis, `${label}.source.rightsBasis`)
    for (const field of ['contextBefore', 'contextAfter']) {
      if (record[field] !== undefined && typeof record[field] !== 'string') {
        throw new Error(`Formal freeze: ${label}.${field} does not match the quality schema.`)
      }
    }
    if (
      record.source.year !== undefined && record.source.year !== null &&
      !Number.isInteger(record.source.year)
    ) {
      throw new Error(`Formal freeze: ${label}.source.year does not match the quality schema.`)
    }
    if (
      record.source.url !== undefined && record.source.url !== null &&
      typeof record.source.url !== 'string'
    ) {
      throw new Error(`Formal freeze: ${label}.source.url does not match the quality schema.`)
    }
    if (
      record.retrievalSnapshot !== undefined && record.retrievalSnapshot !== null &&
      (typeof record.retrievalSnapshot !== 'object' || Array.isArray(record.retrievalSnapshot))
    ) {
      throw new Error(`Formal freeze: ${label}.retrievalSnapshot does not match the quality schema.`)
    }
    const recomputedHash = sha256(record.sourceText)
    if (record.contentHash !== recomputedHash) {
      throw new Error(`Formal freeze: ${label}.contentHash does not match sourceText.`)
    }
    directionCounts[record.direction] += 1
    categoryCounts[record.category] += 1
    const crossKey = `${record.direction}:${record.category}`
    crossCounts[crossKey] = (crossCounts[crossKey] ?? 0) + 1
  }
  for (const [direction, count] of Object.entries(directionCounts)) {
    if (count !== 12) throw new Error(`Formal freeze: ${direction} must contain 12 quality records, found ${count}.`)
  }
  for (const [category, count] of Object.entries(categoryCounts)) {
    if (count !== 6) throw new Error(`Formal freeze: ${category} must contain 6 quality records, found ${count}.`)
    for (const direction of Object.keys(directionCounts)) {
      const crossKey = `${direction}:${category}`
      if (crossCounts[crossKey] !== 3) {
        throw new Error(`Formal freeze: ${crossKey} must contain 3 quality records, found ${crossCounts[crossKey] ?? 0}.`)
      }
    }
  }
  return { directionCounts, categoryCounts, directionCategoryCounts: crossCounts }
}

function validateFormalAnnotationStress(records) {
  if (records.length < 12) {
    throw new Error(`Formal freeze: annotation-stress requires at least 12 records, found ${records.length}.`)
  }
  for (const [index, record] of records.entries()) {
    const label = `annotationStress[${index}] (${record.id ?? 'missing-id'})`
    const allowedFields = new Set([
      'id', 'direction', 'category', 'sourceText', 'contextBefore', 'contextAfter',
      'taskBrief', 'sourceRunId', 'upstream', 'targetedError', 'errorEvidence',
      'annotationInfluence', 'confirmationStatus', 'contentHash', 'retrievalSnapshot',
    ])
    const unexpectedField = Object.keys(record).find((field) => !allowedFields.has(field))
    if (unexpectedField) {
      throw new Error(`Formal freeze: ${label}.${unexpectedField} is outside the annotation-stress schema.`)
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.id ?? '')) {
      throw new Error(`Formal freeze: ${label}.id does not match the annotation-stress schema.`)
    }
    if (!['poetry', 'literary', 'cultural_argument', 'nonliterary'].includes(record.category)) {
      throw new Error(`Formal freeze: ${label}.category does not match the annotation-stress schema.`)
    }
    requireFormalString(record.sourceText, `${label}.sourceText`)
    requireFormalString(record.taskBrief, `${label}.taskBrief`)
    requireFormalString(record.sourceRunId, `${label}.sourceRunId`)
    requireFormalString(record.targetedError, `${label}.targetedError`)
    requireFormalString(record.errorEvidence, `${label}.errorEvidence`)
    requireFormalString(record.annotationInfluence, `${label}.annotationInfluence`)
    for (const field of ['contextBefore', 'contextAfter']) {
      if (record[field] !== undefined && typeof record[field] !== 'string') {
        throw new Error(`Formal freeze: ${label}.${field} does not match the annotation-stress schema.`)
      }
    }
    if (
      record.retrievalSnapshot !== undefined && record.retrievalSnapshot !== null &&
      (typeof record.retrievalSnapshot !== 'object' || Array.isArray(record.retrievalSnapshot))
    ) {
      throw new Error(`Formal freeze: ${label}.retrievalSnapshot does not match the annotation-stress schema.`)
    }
    if (record.confirmationStatus !== 'human_confirmed') {
      throw new Error(`Formal freeze: ${label}.confirmationStatus must be human_confirmed.`)
    }
    if (!record.upstream || typeof record.upstream !== 'object' || Array.isArray(record.upstream)) {
      throw new Error(`Formal freeze: ${label}.upstream is required.`)
    }
    for (const field of ['invocationId', 'model', 'raw', 'body', 'annotation']) {
      requireFormalString(record.upstream[field], `${label}.upstream.${field}`)
    }
    const unexpectedUpstreamField = Object.keys(record.upstream)
      .find((field) => !['invocationId', 'model', 'raw', 'body', 'annotation', 'generatorCommit'].includes(field))
    if (unexpectedUpstreamField) {
      throw new Error(`Formal freeze: ${label}.upstream.${unexpectedUpstreamField} is outside the annotation-stress schema.`)
    }
    if (
      record.upstream.generatorCommit !== undefined &&
      !/^[a-f0-9]{40}$/.test(record.upstream.generatorCommit)
    ) {
      throw new Error(`Formal freeze: ${label}.upstream.generatorCommit does not match the annotation-stress schema.`)
    }
    const parsed = parseSemanticOutput(record.upstream.raw)
    if (!parsed.boundaryFound || parsed.body !== record.upstream.body || parsed.annotation !== record.upstream.annotation) {
      throw new Error(`Formal freeze: ${label}.upstream raw/body/annotation are inconsistent.`)
    }
    if (record.contentHash !== sha256(record.sourceText)) {
      throw new Error(`Formal freeze: ${label}.contentHash does not match sourceText.`)
    }
  }
  return { minimumRequired: 12, confirmedCount: records.length }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const repositoryRoot = path.resolve(args['repo-root'] ?? process.cwd())
  const configPath = path.resolve(
    args.config ?? path.join(repositoryRoot, 'FSBP_Test', 'private', ROUND_ID, 'freeze-config.json'),
  )
  const config = await readJson(configPath)
  assertPlainObject(config, 'config')
  assertNoEmbeddedSecrets(config)
  assertNoLocaleFields(config)

  if ((config.roundId ?? ROUND_ID) !== ROUND_ID) {
    throw new Error(`roundId must be ${ROUND_ID}.`)
  }
  const mode = args.mode ?? config.mode ?? 'development'
  if (!['development', 'formal'].includes(mode)) {
    throw new Error('Freeze mode must be development or formal.')
  }
  assertNonEmptyString(config.seed, 'seed')
  validateModels(config.models)
  validateParameters(config.parameters)
  validateEndpoint(config.endpoint)
  validatePromptBundle(config.promptBundle)
  assertPlainObject(config.datasets, 'datasets')
  const datasetEntries = Object.entries(config.datasets)
  if (!datasetEntries.length) throw new Error('At least one dataset is required.')
  if (!config.datasets.quality) throw new Error('datasets.quality is required.')
  if (!Array.isArray(config.promptFiles) || !config.promptFiles.length) {
    throw new Error('promptFiles must list at least one repository-relative file.')
  }

  const [commit, status, datasets, promptFiles] = await Promise.all([
    git(repositoryRoot, ['rev-parse', 'HEAD']),
    git(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=all']),
    Promise.all(
      datasetEntries.map(([name, descriptor]) =>
        inspectDataset(repositoryRoot, name, descriptor),
      ),
    ),
    Promise.all(
      config.promptFiles.map(async (portablePath, index) => {
        assertNonEmptyString(portablePath, `promptFiles[${index}]`)
        const promptPath = resolvePortable(repositoryRoot, portablePath)
        return {
          path: portableRelative(repositoryRoot, promptPath),
          sha256: await hashFile(promptPath),
        }
      }),
    ),
  ])

  if (!/^[a-f0-9]{40}$/i.test(commit)) {
    throw new Error(`Unable to resolve a Git commit: ${commit}`)
  }
  const dirtyFiles = status ? status.split(/\r?\n/).filter(Boolean) : []
  if (mode === 'formal' && dirtyFiles.length) {
    throw new Error(
      `Formal freeze requires a clean repository; found ${dirtyFiles.length} uncommitted path(s).`,
    )
  }

  let formalValidation = {
    status: 'not_evaluated_development_mode',
    quality: null,
    annotationStress: null,
  }
  if (mode === 'formal') {
    const quality = datasets.find((entry) => entry.name === 'quality' && entry.kind === 'quality')
    const annotationStress = datasets.find((entry) => entry.kind === 'annotation_isolation')
    if (!quality) throw new Error('Formal freeze requires datasets.quality with kind=quality.')
    const qualityValidation = validateFormalQuality(quality.records)
    if (!annotationStress) {
      throw new Error('Formal freeze requires an annotation_isolation dataset with at least 12 confirmed records.')
    }
    formalValidation = {
      status: 'passed',
      quality: qualityValidation,
      annotationStress: validateFormalAnnotationStress(annotationStress.records),
    }
  }

  const snapshot = {
    namespace: 'fsbp',
    roundId: ROUND_ID,
    seed: config.seed,
    datasets: Object.fromEntries(datasets.map(({ records: _records, ...entry }) => [entry.name, entry])),
    promptFiles,
    promptBundle: config.promptBundle,
    models: config.models,
    parameters: config.parameters,
    toolLimits: config.toolLimits ?? {
      maxReviewDepth: 1,
      maxReviewCallsPerStage: 2,
    },
    endpoint: {
      baseUrl: config.endpoint.baseUrl,
      chatCompletionsPath: config.endpoint.chatCompletionsPath ?? '/v1/chat/completions',
      apiKeyEnv: config.endpoint.apiKeyEnv,
    },
    conditions: ['direct', 'multi_raw', 'multi_fsbp'],
  }
  const annotationDataset = datasets.find((entry) => entry.kind === 'annotation_isolation')
  const annotationSource = config.annotationSource ?? {
    source: annotationDataset?.path ?? 'not_supplied',
    version: config.annotationVersion ?? 'round-0820',
  }
  assertNonEmptyString(annotationSource.source, 'annotationSource.source')
  assertNonEmptyString(annotationSource.version, 'annotationSource.version')
  const annotationHash = annotationDataset?.sha256 ?? hashJson(annotationSource)
  const determinismLevel = config.determinismLevel ?? 'partial'
  if (!['full', 'partial', 'none'].includes(determinismLevel)) {
    throw new Error('determinismLevel must be full, partial, or none.')
  }
  const manifest = {
    schemaVersion: '1.0.0',
    roundId: ROUND_ID,
    namespace: 'fsbp',
    mode,
    frozenAt: new Date().toISOString(),
    formalEligible: mode === 'formal' && dirtyFiles.length === 0 && formalValidation.status === 'passed',
    formalValidation,
    source: {
      commit: commit.toLowerCase(),
      clean: dirtyFiles.length === 0,
      dirtyFiles,
    },
    annotation_source: annotationSource.source,
    annotation_version: annotationSource.version,
    annotation_hash: annotationHash,
    determinism_level: determinismLevel,
    snapshot,
    hashes: {
      configSha256: sha256(canonicalJson(config)),
      promptBundleSha256: hashJson(config.promptBundle),
      modelSha256: hashJson(config.models),
      parametersSha256: hashJson(config.parameters),
      toolLimitsSha256: hashJson(snapshot.toolLimits),
      seedSha256: sha256(config.seed),
      datasetsSha256: hashJson(
        Object.fromEntries(datasets.map((entry) => [entry.name, entry.sha256])),
      ),
      promptFilesSha256: hashJson(promptFiles),
    },
  }
  manifest.freezeManifestSha256 = hashJson(manifest)

  const outputPath = path.resolve(
    args.output ?? path.join(repositoryRoot, 'FSBP_Test', 'private', ROUND_ID, 'freeze-manifest.json'),
  )
  assertPathInside(
    path.join(repositoryRoot, 'FSBP_Test', 'private', ROUND_ID),
    outputPath,
    'freeze output',
  )
  await writeJsonNew(outputPath, manifest)
  process.stdout.write(`${JSON.stringify({
    roundId: ROUND_ID,
    output: outputPath,
    commit: manifest.source.commit,
    formalEligible: manifest.formalEligible,
    freezeManifestSha256: manifest.freezeManifestSha256,
    datasets: Object.fromEntries(datasets.map((entry) => [entry.name, entry.sha256])),
  }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
