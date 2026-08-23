import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import ts from '../node_modules/typescript/lib/typescript.js'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const roundRoot = resolve(repositoryRoot, 'FSBP_Test/private/round-0820')
const materializedPath = resolve(roundRoot, 'final-gate.materialized.jsonl')
const simplifiedManifestPath = resolve(roundRoot, 'simplified-snapshot-manifest.json')
const qualityOutputPath = resolve(roundRoot, 'quality-simplified.jsonl')
const freezeConfigPath = resolve(roundRoot, 'freeze-config.json')

let BUILTIN_AGENT_VARIANTS
let BUILTIN_DIRECTION_BUNDLES

const SIMPLIFIED_IDS = new Set([
  'qgate-01',
  'qgate-02',
  'qgate-03',
  'qgate-07',
  'qgate-13',
  'qgate-14',
  'qgate-15',
  'qgate-19',
  'qgate-20',
  'qgate-21',
])

const PRIVATE_SOURCES = new Map([
  ['qgate-08', '01-source/private/W-1.txt'],
  ['qgate-09', '01-source/private/W-2.txt'],
])

const CATEGORY_MAP = Object.freeze({
  poetry_formal: 'poetry',
  literary_narrative: 'literary',
  cultural_argument: 'cultural_argument',
  dense_nonfiction: 'nonliterary',
})

const GPT_MODEL = 'GPT 5.6 Sol: CPA'
const PROMPT_FILES = [
  'scripts/run-fsbp-quality-experiment.mjs',
  'src/lib/prompts/bidirectional.ts',
  'src/lib/prompts/bidirectional/index.ts',
  'src/lib/prompts/bidirectional/archetypes.ts',
  'src/lib/prompts/bidirectional/common.ts',
  'src/lib/prompts/bidirectional/en-to-zh.ts',
  'src/lib/prompts/bidirectional/zh-to-en.ts',
]

function fail(message) {
  throw new Error(`PRECHECK_FAILED: ${message}`)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeText(value, label) {
  const normalized = String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim()
  if (!normalized) fail(`${label} is empty after normalization.`)
  return normalized
}

function parseJsonl(text, label) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line)
      } catch (error) {
        fail(`${label}:${index + 1} is not valid JSON: ${error.message}`)
      }
    })
}

async function loadRepositoryPromptExports() {
  const sourceRoot = resolve(repositoryRoot, 'src/lib/prompts/bidirectional')
  const moduleNames = [
    'index',
    'archetypes',
    'common',
    'en-to-zh',
    'zh-to-en',
  ]
  const tempRoot = await mkdtemp(resolve(tmpdir(), 'round-0820-prompts-'))
  try {
    for (const moduleName of moduleNames) {
      const source = await readFile(resolve(sourceRoot, `${moduleName}.ts`), 'utf8')
      const transpiled = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
        fileName: `${moduleName}.ts`,
        reportDiagnostics: true,
      })
      const errors = (transpiled.diagnostics ?? []).filter(
        (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
      )
      if (errors.length) {
        fail(`TypeScript prompt transpilation failed for ${moduleName}.ts.`)
      }
      const output = transpiled.outputText.replace(
        /from\s+(['"])(\.\/[A-Za-z0-9-]+)\1/g,
        (_match, quote, specifier) => `from ${quote}${specifier}.mjs${quote}`,
      )
      await writeFile(resolve(tempRoot, `${moduleName}.mjs`), output, 'utf8')
    }
    const exports = await import(pathToFileURL(resolve(tempRoot, 'index.mjs')).href)
    if (
      !Array.isArray(exports.BUILTIN_AGENT_VARIANTS) ||
      !Array.isArray(exports.BUILTIN_DIRECTION_BUNDLES)
    ) {
      fail('Repository prompt modules did not export the expected runtime catalogs.')
    }
    return {
      variants: exports.BUILTIN_AGENT_VARIANTS,
      bundles: exports.BUILTIN_DIRECTION_BUNDLES,
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

function assertExactIds(records) {
  if (records.length !== 24) {
    fail(`final-gate.materialized.jsonl must contain 24 records, found ${records.length}.`)
  }
  const ids = records.map((record) => record.id)
  if (new Set(ids).size !== ids.length) fail('Quality sample IDs are not unique.')
  const expected = Array.from({ length: 24 }, (_, index) =>
    `qgate-${String(index + 1).padStart(2, '0')}`,
  )
  for (const id of expected) {
    if (!ids.includes(id)) fail(`Missing required sample ${id}.`)
  }
  for (const id of ids) {
    if (!expected.includes(id)) fail(`Unexpected quality sample ${id}.`)
  }
}

function assertOriginalMaterialization(records) {
  for (const record of records) {
    if (!record.id || !record.direction || !record.category) {
      fail('Materialized records must contain id, direction, and category.')
    }
    if (!record.author || !record.work || !record.licenseEvidence) {
      fail(`${record.id} is missing source metadata.`)
    }
    if (!record.sourceRef || typeof record.sourceRef !== 'object') {
      fail(`${record.id} is missing sourceRef metadata.`)
    }
    if (record.sourceText !== null) {
      const sourceText = normalizeText(record.sourceText, `${record.id}.sourceText`)
      if (record.contentSha256 !== sha256(sourceText)) {
        fail(`${record.id}.contentSha256 does not match its normalized sourceText.`)
      }
    } else if (!PRIVATE_SOURCES.has(record.id)) {
      fail(`${record.id} has null sourceText but is not an approved private-source record.`)
    }
  }
}

function parsePrivateSource(text, label) {
  const normalized = normalizeText(text, label)
  const sections = normalized.split(/^---\s*$/m)
  if (sections.length !== 2) {
    fail(`${label} must contain exactly one standalone --- source/task-note divider.`)
  }
  return {
    sourceText: normalizeText(sections[0], `${label} source body`),
    taskNote: normalizeText(sections[1], `${label} task note`),
  }
}

function requirePromptString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    fail(`${label} is missing from the repository prompt bundle.`)
  }
  return value.trim()
}

function bundleFor(direction) {
  const matches = BUILTIN_DIRECTION_BUNDLES.filter(
    (bundle) => bundle.direction === direction,
  )
  if (matches.length !== 1) {
    fail(`Expected exactly one ${direction} prompt bundle, found ${matches.length}.`)
  }
  const bundle = matches[0]
  for (const field of [
    'workerBasePrompt',
    'reviewPrompt',
    'filterPrompt',
    'orchestratePrompt',
    'assemblePrompt',
  ]) {
    requirePromptString(bundle[field], `${direction}.${field}`)
  }
  return bundle
}

function variantFor(archetypeId, direction) {
  const matches = BUILTIN_AGENT_VARIANTS.filter(
    (variant) =>
      variant.archetypeId === archetypeId && variant.direction === direction,
  )
  if (matches.length !== 1) {
    fail(
      `Expected exactly one ${direction}/${archetypeId} prompt variant, found ${matches.length}.`,
    )
  }
  return requirePromptString(
    matches[0].rolePrompt,
    `${direction}.${archetypeId}.rolePrompt`,
  )
}

function directionRouter(purpose, enToZhPrompt, zhToEnPrompt) {
  return [
    `Frozen direction router for ${purpose}. Read the exact Direction value in the user message. Apply only the matching repository prompt block; never combine directions.`,
    '',
    '=== Direction: en_to_zh ===',
    requirePromptString(enToZhPrompt, `${purpose}.en_to_zh`),
    '',
    '=== Direction: zh_to_en ===',
    requirePromptString(zhToEnPrompt, `${purpose}.zh_to_en`),
  ].join('\n')
}

function categoryRouter(direction, bundle, categories) {
  const blocks = Object.entries(categories).map(([category, archetypeId]) => [
    `=== Category: ${category} ===`,
    variantFor(archetypeId, direction),
  ].join('\n'))
  return [
    requirePromptString(bundle.workerBasePrompt, `${direction}.workerBasePrompt`),
    '',
    'Use the source form and Task brief to select exactly one matching research category block below. Apply only that specialist block.',
    ...blocks.flatMap((block) => ['', block]),
  ].join('\n')
}

async function buildPromptBundle() {
  for (const portablePath of PROMPT_FILES) {
    const contents = await readFile(resolve(repositoryRoot, portablePath), 'utf8')
    if (!contents.trim()) fail(`Prompt source file is empty: ${portablePath}`)
  }

  const legacyRunner = await readFile(
    resolve(repositoryRoot, 'scripts/run-fsbp-quality-experiment.mjs'),
    'utf8',
  )
  const directEnToZh = '直接独立完成一份完整译文，不使用候选译文。先输出译文正文；必要说明可放在独立“---”之后。'
  const directZhToEn = 'Produce one complete direct translation without using candidate translations. Output the translation first; optional notes may follow a standalone "---".'
  if (!legacyRunner.includes(directEnToZh) || !legacyRunner.includes(directZhToEn)) {
    fail('The frozen direct-translation instructions drifted from the repository runner.')
  }

  const enToZh = bundleFor('en_to_zh')
  const zhToEn = bundleFor('zh_to_en')
  const workerPrompt = (direction, bundle, archetypeId) => [
    bundle.workerBasePrompt,
    variantFor(archetypeId, direction),
  ].join('\n\n')

  const analysis = directionRouter(
    'independent pre-translation analysis',
    variantFor('cultural-context', 'en_to_zh'),
    variantFor('cultural-context', 'zh_to_en'),
  )

  return {
    direct: directionRouter(
      'direct translation baseline',
      `${enToZh.workerBasePrompt}\n\n${directEnToZh}`,
      `${zhToEn.workerBasePrompt}\n\n${directZhToEn}`,
    ),
    analysis: [analysis, analysis],
    candidate: [
      directionRouter(
        'candidate 1 semantic fidelity',
        workerPrompt('en_to_zh', enToZh, 'semantic-fidelity'),
        workerPrompt('zh_to_en', zhToEn, 'semantic-fidelity'),
      ),
      directionRouter(
        'candidate 2 target-language naturalness',
        workerPrompt('en_to_zh', enToZh, 'target-naturalness'),
        workerPrompt('zh_to_en', zhToEn, 'target-naturalness'),
      ),
      directionRouter(
        'candidate 3 category specialist',
        categoryRouter('en_to_zh', enToZh, {
          poetry: 'poetry-form',
          literary: 'literary-prose',
          cultural_argument: 'dissenting',
          nonliterary: 'long-context',
        }),
        categoryRouter('zh_to_en', zhToEn, {
          poetry: 'poetry-form',
          literary: 'literary-prose',
          cultural_argument: 'dissenting',
          nonliterary: 'long-context',
        }),
      ),
    ],
    stages: {
      review: directionRouter(
        'review stage',
        enToZh.reviewPrompt,
        zhToEn.reviewPrompt,
      ),
      filter: directionRouter(
        'filter stage',
        enToZh.filterPrompt,
        zhToEn.filterPrompt,
      ),
      orchestrate: directionRouter(
        'orchestration stage',
        enToZh.orchestratePrompt,
        zhToEn.orchestratePrompt,
      ),
      assemble: directionRouter(
        'assembly stage',
        enToZh.assemblePrompt,
        zhToEn.assemblePrompt,
      ),
    },
  }
}

function sourceMetadata(record, overrides = {}) {
  return {
    author: record.author,
    title: record.work,
    year: Number.isInteger(record.year) ? record.year : null,
    url: overrides.url ?? record.sourceUrl ?? null,
    rightsBasis: overrides.rightsBasis ?? record.licenseEvidence,
    licenseStatus: record.licenseStatus,
    retrievedOn: record.retrievedOn,
    rightsAssessment: record.rightsAssessment ?? null,
  }
}

function qualityRecord(record, sourceText, category, taskBrief, sourceRef, retrievalSnapshot, source) {
  const contentHash = sha256(sourceText)
  return {
    schemaVersion: 'round-0820.quality-sample.v1',
    id: record.id,
    candidateId: record.candidateId,
    externalResearchId: record.externalResearchId,
    direction: record.direction,
    category,
    originalCategory: record.category,
    sourceText,
    taskBrief,
    source,
    sourceRef,
    selectionReason: record.selectionReason,
    contentHash,
    contentSha256: contentHash,
    retrievalSnapshot,
  }
}

async function main() {
  const promptExports = await loadRepositoryPromptExports()
  BUILTIN_AGENT_VARIANTS = promptExports.variants
  BUILTIN_DIRECTION_BUNDLES = promptExports.bundles
  const [materializedText, simplifiedManifestText] = await Promise.all([
    readFile(materializedPath, 'utf8'),
    readFile(simplifiedManifestPath, 'utf8'),
  ])
  const materialized = parseJsonl(materializedText, 'final-gate.materialized.jsonl')
  assertExactIds(materialized)
  assertOriginalMaterialization(materialized)

  let simplifiedManifest
  try {
    simplifiedManifest = JSON.parse(simplifiedManifestText)
  } catch (error) {
    fail(`simplified-snapshot-manifest.json is invalid JSON: ${error.message}`)
  }
  if (
    simplifiedManifest.roundId !== 'round-0820' ||
    simplifiedManifest.sampleCount !== SIMPLIFIED_IDS.size ||
    !Array.isArray(simplifiedManifest.records) ||
    !Array.isArray(simplifiedManifest.reviewExcerpts)
  ) {
    fail('Simplified snapshot manifest identity/counts are invalid.')
  }

  const simplifiedById = new Map()
  for (const id of SIMPLIFIED_IDS) {
    const excerpts = simplifiedManifest.reviewExcerpts.filter(
      (entry) => entry.sampleId === id,
    )
    if (excerpts.length !== 1) {
      fail(`${id} must have exactly one simplified review excerpt.`)
    }
    const excerpt = excerpts[0]
    const excerptPath = resolve(roundRoot, excerpt.path)
    const excerptBytes = await readFile(excerptPath)
    if (sha256(excerptBytes) !== excerpt.sha256) {
      fail(`${id} simplified excerpt hash mismatch: ${excerpt.path}`)
    }
    const sourceText = normalizeText(excerptBytes.toString('utf8'), `${id} simplified excerpt`)
    const snapshots = simplifiedManifest.records.filter(
      (entry) => entry.sampleId === id,
    )
    if (!snapshots.length) fail(`${id} has no simplified raw snapshot provenance.`)
    for (const snapshot of snapshots) {
      const rawPath = resolve(roundRoot, snapshot.rawSnapshotPath)
      const rawBytes = await readFile(rawPath)
      if (sha256(rawBytes) !== snapshot.rawSha256) {
        fail(`${id} simplified raw snapshot hash mismatch: ${snapshot.rawSnapshotPath}`)
      }
    }
    simplifiedById.set(id, { excerpt, snapshots, sourceText })
  }

  const privateById = new Map()
  for (const [id, portablePath] of PRIVATE_SOURCES) {
    const record = materialized.find((item) => item.id === id)
    const filePath = resolve(roundRoot, portablePath)
    const fileBytes = await readFile(filePath)
    const fileHash = sha256(fileBytes)
    if (
      fileHash !== record.sourceRef.rawFileSha256 ||
      fileHash !== record.sourceRef.excerptFileSha256 ||
      fileHash !== record.contentSha256
    ) {
      fail(`${id} private source hash does not match materialized metadata.`)
    }
    privateById.set(id, {
      portablePath,
      fileHash,
      ...parsePrivateSource(fileBytes.toString('utf8'), portablePath),
    })
  }

  const fallbackLiteraryBrief = materialized.find(
    (record) =>
      record.category === 'literary_narrative' &&
      typeof record.taskBrief === 'string' &&
      record.taskBrief.trim(),
  )?.taskBrief
  if (!fallbackLiteraryBrief) fail('No repository literary task brief is available for W-1/W-2.')

  const quality = materialized.map((record) => {
    const category = CATEGORY_MAP[record.category]
    if (!category) fail(`${record.id} uses unmapped category ${record.category}.`)

    if (SIMPLIFIED_IDS.has(record.id)) {
      const simplified = simplifiedById.get(record.id)
      const primary = simplified.snapshots[0]
      const rightsBasis = [
        record.licenseEvidence,
        primary.license,
      ].filter(Boolean).join(' ')
      const sourceRef = {
        kind: 'wikisource_fixed_revision_zh_hans_variant',
        locator: 'whole_review_excerpt',
        excerptPath: simplified.excerpt.path,
        excerptFileSha256: simplified.excerpt.sha256,
        rawSnapshots: simplified.snapshots.map((snapshot) => ({
          part: snapshot.part,
          title: snapshot.title,
          oldid: snapshot.oldid,
          pageUrl: snapshot.pageUrl,
          rawSnapshotPath: snapshot.rawSnapshotPath,
          rawSha256: snapshot.rawSha256,
          plainSnapshotPath: snapshot.plainSnapshotPath,
          plainSha256: snapshot.plainSha256,
          conversionMode: snapshot.conversionMode,
        })),
      }
      return qualityRecord(
        record,
        simplified.sourceText,
        category,
        normalizeText(record.taskBrief, `${record.id}.taskBrief`),
        sourceRef,
        {
          sourceType: primary.sourceType,
          conversionMode: primary.conversionMode,
          independentSimplifiedEdition: primary.independentSimplifiedEdition,
          excerpt: simplified.excerpt,
          snapshots: simplified.snapshots,
          retrievedOn: primary.retrievedOn,
          license: primary.license,
        },
        sourceMetadata(record, { url: primary.pageUrl, rightsBasis }),
      )
    }

    if (PRIVATE_SOURCES.has(record.id)) {
      const privateSource = privateById.get(record.id)
      let taskBrief = fallbackLiteraryBrief
      if (record.id === 'qgate-08') {
        if (!privateSource.taskNote.includes('白翼 Whitewing') || !privateSource.taskNote.includes('云羽 Lofty Feather')) {
          fail('W-1 task note no longer contains the approved proper-name mappings.')
        }
        taskBrief = `${taskBrief} 专名固定为：白翼译作 Whitewing，云羽译作 Lofty Feather。`
      } else {
        if (!privateSource.taskNote.includes('保留中文')) {
          fail('W-2 task note no longer contains the Chinese-riddle preservation requirement.')
        }
        taskBrief = `${taskBrief} 原文包含依赖汉字字形的字谜；保留谜面中的中文字符，并用简洁英文说明其拆字关系，不把字谜改造成无依据的英文文字游戏。`
      }
      return qualityRecord(
        record,
        privateSource.sourceText,
        category,
        taskBrief,
        {
          kind: 'private_author_owned_file',
          path: privateSource.portablePath,
          locator: 'body_before_standalone_divider',
          rawFileSha256: privateSource.fileHash,
        },
        {
          sourceType: 'private_author_owned_file',
          path: privateSource.portablePath,
          fileSha256: privateSource.fileHash,
          sourceBodyRule: 'body_before_single_standalone_divider',
          taskNoteRetainedInTaskBrief: true,
        },
        sourceMetadata(record),
      )
    }

    const sourceText = normalizeText(record.sourceText, `${record.id}.sourceText`)
    return qualityRecord(
      record,
      sourceText,
      category,
      normalizeText(record.taskBrief, `${record.id}.taskBrief`),
      record.sourceRef,
      {
        sourceType: record.sourceRef.kind,
        sourceRef: record.sourceRef,
        retrievedOn: record.retrievedOn,
      },
      sourceMetadata(record),
    )
  })

  const directionCounts = { en_to_zh: 0, zh_to_en: 0 }
  const categoryCounts = {
    poetry: 0,
    literary: 0,
    cultural_argument: 0,
    nonliterary: 0,
  }
  const crossCounts = new Map()
  for (const record of quality) {
    if (!(record.direction in directionCounts)) fail(`${record.id} has invalid direction.`)
    if (!(record.category in categoryCounts)) fail(`${record.id} has invalid normalized category.`)
    if (record.contentHash !== sha256(record.sourceText)) fail(`${record.id} contentHash drift.`)
    directionCounts[record.direction] += 1
    categoryCounts[record.category] += 1
    const key = `${record.direction}:${record.category}`
    crossCounts.set(key, (crossCounts.get(key) ?? 0) + 1)
  }
  for (const [direction, count] of Object.entries(directionCounts)) {
    if (count !== 12) fail(`${direction} must contain 12 samples, found ${count}.`)
  }
  for (const [category, count] of Object.entries(categoryCounts)) {
    if (count !== 6) fail(`${category} must contain 6 samples, found ${count}.`)
    for (const direction of Object.keys(directionCounts)) {
      const cross = crossCounts.get(`${direction}:${category}`) ?? 0
      if (cross !== 3) fail(`${direction}:${category} must contain 3 samples, found ${cross}.`)
    }
  }

  const promptBundle = await buildPromptBundle()
  const config = {
    roundId: 'round-0820',
    mode: 'development',
    determinismLevel: 'partial',
    seed: 'round-0820-development-seed-20260822-v1',
    datasets: {
      quality: {
        path: 'FSBP_Test/private/round-0820/quality-simplified.jsonl',
        kind: 'quality',
        expectedCount: 24,
      },
    },
    promptFiles: PROMPT_FILES,
    promptBundle,
    models: {
      direct: GPT_MODEL,
      analysis: [GPT_MODEL, GPT_MODEL],
      candidates: [GPT_MODEL, GPT_MODEL, GPT_MODEL],
      editor: GPT_MODEL,
      fallbackModel: GPT_MODEL,
    },
    parameters: {
      temperature: 0.3,
      maxTokens: 131072,
      timeoutMs: 900000,
      retries: 1,
      sampleConcurrency: 5,
      fallbackAttempts: 1,
    },
    endpoint: {
      baseUrl: 'https://newapi.wingsandasoul.vip',
      chatCompletionsPath: '/v1/chat/completions',
      apiKeyEnv: 'FSBP_EXPERIMENT_API_KEY',
    },
  }

  const qualityText = `${quality.map((record) => JSON.stringify(record)).join('\n')}\n`
  const configText = `${JSON.stringify(config, null, 2)}\n`
  const qualityTemp = `${qualityOutputPath}.tmp`
  const configTemp = `${freezeConfigPath}.tmp`
  await Promise.all([rm(qualityTemp, { force: true }), rm(configTemp, { force: true })])
  try {
    await Promise.all([
      writeFile(qualityTemp, qualityText, 'utf8'),
      writeFile(configTemp, configText, 'utf8'),
    ])
    await rename(qualityTemp, qualityOutputPath)
    await rename(configTemp, freezeConfigPath)
  } catch (error) {
    await Promise.all([rm(qualityTemp, { force: true }), rm(configTemp, { force: true })])
    throw error
  }

  process.stdout.write(
    `${JSON.stringify({
      records: quality.length,
      directionCounts,
      categoryCounts,
      qualitySha256: sha256(qualityText),
      freezeConfigSha256: sha256(configText),
      replacedWithSimplified: [...SIMPLIFIED_IDS],
      privateSources: [...PRIVATE_SOURCES.keys()],
      models: config.models,
      perSampleScheduledLogicalCallAllocation: {
        total: 14,
        gpt: 12,
        deepseek: 2,
      },
      fallbackPolicy: {
        model: config.models.fallbackModel,
        attempts: config.parameters.fallbackAttempts,
        scope: 'all_logical_paid_calls_after_primary_policy_exhaustion',
      },
      timeoutMs: config.parameters.timeoutMs,
      sampleConcurrency: config.parameters.sampleConcurrency,
    })}\n`,
  )
}

await main()
