import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import Ajv2020 from 'ajv/dist/2020.js'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const FREEZE = path.join(ROOT, 'scripts', 'freeze-round-0820.mjs')
const RUN = path.join(ROOT, 'scripts', 'run-round-0820.mjs')
const RUN_WITH_KEY_FILE = path.join(ROOT, 'scripts', 'run-round-0820-with-key-file.mjs')
const STREAM_SHAPE_PROBE = path.join(ROOT, 'scripts', 'probe-round-0820-stream-shape.mjs')
const PREPARE = path.join(ROOT, 'scripts', 'prepare-round-0820-blind.mjs')
const PREPARE_GPT_BASELINE = path.join(
  ROOT,
  'scripts',
  'prepare-round-0820-gpt-baseline-input.mjs',
)
const VALIDATE = path.join(ROOT, 'scripts', 'validate-round-0820-human.mjs')
const ANALYZE = path.join(ROOT, 'scripts', 'analyze-round-0820.mjs')
const SYNTHETIC_RUNNER_KEY = 'opaqueRound0820FixtureCredentialValue'
const ROUND_GPT_MODEL = 'GPT 5.6 Sol: CPA'
const tempDirs: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve())
  })))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'round-0820-test-'))
  tempDirs.push(dir)
  return dir
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function writeJsonl(file: string, records: unknown[]): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(
    file,
    records.length ? `${records.map((record) => JSON.stringify(record)).join('\n')}\n` : '',
    'utf8',
  )
}

function readJson(file: string): any {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function readJsonl(file: string): any[] {
  const text = readFileSync(file, 'utf8')
  return text.trim() ? text.trim().split(/\r?\n/).map((line) => JSON.parse(line)) : []
}

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function writeExternalBaseline(
  privateRoot: string,
  records: Array<{
    id: string
    direction: 'en_to_zh' | 'zh_to_en'
    sourceText: string
    taskBrief: string
    translation: string
  }>,
): void {
  writeJsonl(path.join(privateRoot, 'gpt-baseline-input.jsonl'), records.map((record) => ({
    id: record.id,
    direction: record.direction,
    taskBrief: record.taskBrief,
    sourceText: record.sourceText,
  })))
  writeJsonl(path.join(privateRoot, 'gpt-baseline-output.jsonl'), records.map((record) => ({
    id: record.id,
    direction: record.direction,
    translation: record.translation,
  })))
}

function completeGeneratedQualityCsv(file: string): void {
  const lines = readFileSync(file, 'utf8').replace(/^\ufeff/, '').trimEnd().split(/\r?\n/)
  const headers = lines[0].split(',')
  const completed = lines.slice(1).map((line) => {
    const row = Object.fromEntries(headers.map((header, index) => [header, line.split(',')[index] ?? '']))
    for (const header of headers) {
      if (QUALITY_DIMENSION_HEADERS.some((dimension) => header.endsWith(`_${dimension}`))) {
        row[header] = '7'
      } else if (header.endsWith('_revisionNeeded')) row[header] = 'false'
    }
    row.unableToJudge = 'false'
    row.ranking = 'A>B'
    row.confidence = 'high'
    row.rationale = 'Completed CSV review evidence.'
    return headers.map((header) => row[header]).join(',')
  })
  writeFileSync(file, `\ufeff${[headers.join(','), ...completed].join('\r\n')}\r\n`, 'utf8')
}

const QUALITY_DIMENSION_HEADERS = [
  'fidelity',
  'naturalness',
  'style_voice',
  'structure_form',
  'terminology_logic',
  'overall_quality',
]

function writeTerminalRunManifest(
  runDir: string,
  base: Record<string, unknown>,
): void {
  const artifactFiles = {
    events: 'events.jsonl',
    outcomes: 'outcomes.jsonl',
    candidateCache: 'candidate-cache.jsonl',
    final: 'final.jsonl',
  }
  const finalPath = path.join(runDir, artifactFiles.final)
  const outcomesPath = path.join(runDir, artifactFiles.outcomes)
  if (existsSync(finalPath) && !existsSync(outcomesPath)) {
    writeJsonl(outcomesPath, readJsonl(finalPath))
  }
  for (const file of Object.values(artifactFiles)) {
    const artifactPath = path.join(runDir, file)
    if (!existsSync(artifactPath)) writeJsonl(artifactPath, [])
  }
  const artifacts = Object.fromEntries(Object.entries(artifactFiles).map(([name, file]) => {
    const artifactPath = path.join(runDir, file)
    return [name, {
      path: file,
      sha256: sha256File(artifactPath),
      recordCount: readJsonl(artifactPath).length,
    }]
  }))
  const finals = readJsonl(path.join(runDir, artifactFiles.final))
  const events = readJsonl(path.join(runDir, artifactFiles.events))
  const cache = readJsonl(path.join(runDir, artifactFiles.candidateCache))
  const complete = finals.filter((record) => record.status === 'complete').length
  const failed = finals.length - complete
  const freezeManifestSha256 = String(base.freezeManifestSha256 ?? 'a'.repeat(64))
  writeJson(path.join(runDir, 'fixture-freeze-manifest.json'), {
    schemaVersion: '1.0.0',
    roundId: 'round-0820',
    namespace: 'fsbp',
    mode: 'development',
    formalEligible: false,
    source: { clean: true },
    determinism_level: 'partial',
    freezeManifestSha256,
  })
  writeJson(path.join(runDir, 'run-manifest.json'), {
    schemaVersion: '1.0.0',
    roundId: 'round-0820',
    namespace: 'fsbp',
    freezeManifest: 'fixture-freeze-manifest.json',
    freezeMode: 'development',
    formalEligible: false,
    determinism_level: 'partial',
    ...base,
    status: failed ? 'completed_with_failures' : 'complete',
    resultCounts: {
      total: finals.length,
      complete,
      failed,
      failedOutcomeKeys: finals
        .filter((record) => record.status !== 'complete')
        .map((record) => record.outcomeKey),
      recordedAttempts: events.length,
      recordedFailedAttempts: events.filter((record) => record.status === 'failed').length,
      recordedIncompleteAttempts: events
        .filter((record) => record.status === 'incomplete_output').length,
      cachedCandidateSets: cache.length,
    },
    artifacts,
  })
}

function runNode(
  script: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv
    cwd?: string
    skipSyntheticRunnerCredential?: boolean
    testModelCallTimeoutMs?: number
  } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env, ...options.env }
    let executableScript = script
    if (path.resolve(script) === path.resolve(RUN)) {
      const freezeArgument = args.find((argument) => argument.startsWith('--freeze='))
      if (!freezeArgument) throw new Error('Round runner test requires an explicit freeze path.')
      const freezePath = path.resolve(
        options.cwd ?? ROOT,
        freezeArgument.slice('--freeze='.length),
      )
      const endpoint = readJson(freezePath).snapshot.endpoint
      delete environment.FSBP_EXPERIMENT_API_KEY
      delete environment.FSBP_EXPERIMENT_KEY_FILE
      delete environment[endpoint.apiKeyEnv]
      if (!options.skipSyntheticRunnerCredential) {
        const credentialFile = path.join(
          path.dirname(freezePath),
          'synthetic-credential.txt',
        )
        const harnessFile = path.join(
          path.dirname(freezePath),
          'synthetic-runner-harness.mjs',
        )
        writeFileSync(credentialFile, `${SYNTHETIC_RUNNER_KEY}\n`, 'utf8')
        writeFileSync(harnessFile, [
          "import { readFile } from 'node:fs/promises'",
          `import { runRound0820 } from ${JSON.stringify(pathToFileURL(RUN).href)}`,
          `import { redactCredentialText } from ${JSON.stringify(pathToFileURL(RUN_WITH_KEY_FILE).href)}`,
          `const credentialFile = ${JSON.stringify(credentialFile)}`,
          "const credentialResolver = async () => (await readFile(credentialFile, 'utf8')).trim()",
          `runRound0820({ credentialResolver, modelCallTimeoutMs: ${options.testModelCallTimeoutMs ?? 900_000} }).catch((error) => {`,
          "  process.stderr.write(`${redactCredentialText(error instanceof Error ? error.stack ?? error.message : String(error))}\\n`)",
          '  process.exitCode = 1',
          '})',
          '',
        ].join('\n'), 'utf8')
        executableScript = harnessFile
      }
    }
    const child = spawn(process.execPath, [executableScript, ...args], {
      cwd: options.cwd ?? ROOT,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function git(repository: string, args: string[]): void {
  const result = spawnSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
}

async function createFrozenFixture(
  baseUrl: string,
  retries = 0,
): Promise<{
  repository: string
  freezePath: string
  datasetPath: string
}> {
  const repository = tempDir()
  const datasetPath = path.join(repository, 'data', 'quality.jsonl')
  const promptPath = path.join(repository, 'prompts', 'bundle.txt')
  const configPath = path.join(repository, 'config.json')
  writeFileSync(path.join(repository, '.gitignore'), 'FSBP_Test/private/\n', 'utf8')
  writeJsonl(datasetPath, [{
    id: 'quality-one',
    direction: 'en_to_zh',
    category: 'literary',
    sourceText: 'The moon rested above the silent field.',
    taskBrief: 'Translate faithfully and naturally.',
  }])
  mkdirSync(path.dirname(promptPath), { recursive: true })
  writeFileSync(promptPath, 'frozen prompt source\n', 'utf8')
  writeJson(configPath, {
    roundId: 'round-0820',
    seed: 'fixed-experiment-seed',
    determinismLevel: 'partial',
    annotationSource: { source: 'natural_model_runs', version: 'annotation-v1' },
    datasets: {
      quality: { path: 'data/quality.jsonl', kind: 'quality', expectedCount: 1 },
    },
    promptFiles: ['prompts/bundle.txt'],
    promptBundle: {
      direct: 'DIRECT',
      analysis: ['ANALYSIS_A', 'ANALYSIS_B'],
      candidate: ['CANDIDATE_A', 'CANDIDATE_B', 'CANDIDATE_C'],
      stages: {
        review: 'REVIEW',
        filter: 'FILTER',
        orchestrate: 'ORCHESTRATE',
        assemble: 'ASSEMBLE',
      },
    },
    models: {
      direct: ROUND_GPT_MODEL,
      analysis: [ROUND_GPT_MODEL, ROUND_GPT_MODEL],
      candidates: [ROUND_GPT_MODEL, ROUND_GPT_MODEL, ROUND_GPT_MODEL],
      editor: ROUND_GPT_MODEL,
      fallbackModel: ROUND_GPT_MODEL,
    },
    parameters: {
      temperature: 0,
      maxTokens: 131_072,
      timeoutMs: 900_000,
      retries,
      sampleConcurrency: 5,
      fallbackAttempts: 1,
    },
    toolLimits: { maxReviewDepth: 1, maxReviewCallsPerStage: 2 },
    endpoint: {
      baseUrl,
      chatCompletionsPath: '/v1/chat/completions',
      apiKeyEnv: 'FSBP_EXPERIMENT_API_KEY',
    },
  })
  git(repository, ['init'])
  git(repository, ['config', 'user.email', 'test@example.invalid'])
  git(repository, ['config', 'user.name', 'Round Test'])
  git(repository, ['config', 'commit.gpgsign', 'false'])
  git(repository, ['add', '.'])
  git(repository, ['commit', '-m', 'fixture'])
  const freezePath = path.join(
    repository,
    'FSBP_Test',
    'private',
    'round-0820',
    'freeze.json',
  )
  const result = await runNode(FREEZE, [
    `--repo-root=${repository}`,
    `--config=${configPath}`,
    `--output=${freezePath}`,
  ])
  expect(result.code, result.stderr).toBe(0)
  return { repository, freezePath, datasetPath }
}

describe('round-0820 frozen experiment scripts', () => {
  it('keeps the human-record schema aligned with CLI null and severe-error rules', () => {
    const schema = readJson(path.join(
      ROOT, 'FSBP_Test', 'schemas', 'round-0820-human.schema.json',
    ))
    const validate = new Ajv2020({ strict: false }).compile(schema)
    const score = {
      fidelity: 8,
      naturalness: 8,
      style_voice: 8,
      structure_form: 8,
      terminology_logic: null,
      overall_quality: 8,
    }
    const valid = {
      schemaVersion: '1.0.0',
      namespace: 'fsbp',
      packetId: 'quality-packet',
      packetHash: 'a'.repeat(64),
      kind: 'quality',
      reviewerType: 'human',
      reviewerId: 'reviewer-A',
      itemId: 'item-one',
      unableToJudge: false,
      candidateScores: { A: score, B: { ...score, terminology_logic: 7 } },
      ranking: [['A'], ['B']],
      severeErrors: [{
        candidate: 'B',
        location: 'line 2',
        category: 'omission',
        severity: 'major',
        evidence: 'The source phrase is absent.',
      }],
      revisionNeeded: { A: false, B: true },
      confidence: 'high',
      rationale: 'Compared both candidates with the source.',
    }
    expect(validate(valid), JSON.stringify(validate.errors)).toBe(true)
    expect(validate({
      ...valid,
      candidateScores: { A: { ...score, naturalness: null }, B: score },
    })).toBe(false)
    expect(validate({
      ...valid,
      unableToJudge: true,
      ranking: [],
      severeErrors: [],
      revisionNeeded: { A: null, B: null },
      confidence: 'low',
    })).toBe(false)
    expect(validate({
      ...valid,
      severeErrors: [{
        candidate: 'B',
        location: 'line 2',
        category: 'omission',
        severity: 'minor',
      }],
    })).toBe(false)
    expect(validate({
      ...valid,
      ranking: [[1], ['B']],
    })).toBe(false)
    expect(validate({
      ...valid,
      severeErrors: [{
        candidate: 1,
        location: 'line 2',
        category: 'omission',
        severity: 'major',
        evidence: 'The source phrase is absent.',
      }],
    })).toBe(false)
    expect(validate({
      ...valid,
      candidateScores: { A: score, Z: score },
      revisionNeeded: { A: false, Z: true },
    })).toBe(false)
  })
  it('builds baseline v3 from formal source authority and rejects a qgate-09 task-note suffix', async () => {
    const fixtureRoot = tempDir()
    const roundRoot = path.join(fixtureRoot, 'round-0820')
    const runDir = path.join(roundRoot, 'runs', 'formal')
    const outputDir = path.join(fixtureRoot, 'output')
    const ids = Array.from(
      { length: 24 },
      (_, index) => `qgate-${String(index + 1).padStart(2, '0')}`,
    )
    const bodies = new Map([
      ['qgate-08', 'PRIVATE_BODY_EIGHT'],
      ['qgate-09', 'PRIVATE_BODY_NINE'],
    ])
    const notes = new Map([
      ['qgate-08', 'PRIVATE_TASK_NOTE_EIGHT'],
      ['qgate-09', 'PRIVATE_TASK_NOTE_NINE'],
    ])
    const authority = ids.map((id, index) => ({
      id,
      direction: index < 12 ? 'en_to_zh' : 'zh_to_en',
      sourceText: bodies.get(id) ?? `FORMAL_SOURCE_${id}`,
      taskBrief: bodies.has(id) ? `FORMAL_TASK_BRIEF_${id}` : `TASK_BRIEF_${id}`,
    }))
    authority[7].direction = 'zh_to_en'
    authority[8].direction = 'zh_to_en'
    const formal = authority.flatMap((record) => [
      'direct',
      'multi_raw',
      'multi_fsbp',
    ].map((condition) => ({
      sampleId: record.id,
      direction: record.direction,
      sourceText: record.sourceText,
      taskBrief: record.taskBrief,
      condition,
      status: 'complete',
    })))
    const initialInput = authority.map((record) => ({
      id: record.id,
      direction: record.direction,
      taskBrief: bodies.has(record.id) ? `OLD_TASK_BRIEF_${record.id}` : record.taskBrief,
      sourceText: bodies.has(record.id)
        ? `${record.sourceText}\n\n---\n\n${notes.get(record.id)}`
        : record.sourceText,
    }))
    const initialOutput = authority.map((record) => ({
      id: record.id,
      direction: record.direction,
      translation: `INITIAL_TRANSLATION_${record.id}`,
    }))
    const v2Input = initialInput.map((record) => bodies.has(record.id)
      ? { ...record, sourceText: bodies.get(record.id) }
      : record)
    const v2Output = initialOutput.map((record) => record.id === 'qgate-08'
      ? { ...record, translation: 'CORRECTED_TRANSLATION_EIGHT' }
      : record)

    writeJsonl(path.join(roundRoot, 'quality-simplified.jsonl'), authority)
    writeJsonl(path.join(runDir, 'final.jsonl'), formal)
    writeJsonl(path.join(roundRoot, 'gpt-baseline-input.jsonl'), initialInput)
    writeJsonl(path.join(roundRoot, 'gpt-baseline-output.jsonl'), initialOutput)
    writeJsonl(path.join(roundRoot, 'gpt-baseline-input-v2.jsonl'), v2Input)
    writeJsonl(path.join(roundRoot, 'gpt-baseline-output-v2.jsonl'), v2Output)
    writeFileSync(
      path.join(roundRoot, 'qgate-08-gpt-baseline-correction.txt'),
      'CORRECTED_TRANSLATION_EIGHT\n',
      'utf8',
    )
    writeFileSync(
      path.join(roundRoot, 'qgate-09-gpt-baseline-correction.txt'),
      'CORRECTED_TRANSLATION_NINE\n',
      'utf8',
    )
    for (const [id, file] of [['qgate-08', 'W-1.txt'], ['qgate-09', 'W-2.txt']]) {
      const filePath = path.join(roundRoot, '01-source', 'private', file)
      mkdirSync(path.dirname(filePath), { recursive: true })
      writeFileSync(filePath, `${bodies.get(id)}\n\n---\n\n${notes.get(id)}\n`, 'utf8')
    }

    const build = await runNode(PREPARE_GPT_BASELINE, [
      `--round-root=${roundRoot}`,
      `--run-dir=${runDir}`,
      `--output-dir=${outputDir}`,
    ])
    expect(build.code, build.stderr).toBe(0)
    const v3InputPath = path.join(outputDir, 'gpt-baseline-input-v3.jsonl')
    const v3OutputPath = path.join(outputDir, 'gpt-baseline-output-v3.jsonl')
    const v3Input = readJsonl(v3InputPath)
    const v3Output = readJsonl(v3OutputPath)
    expect(v3Input).toHaveLength(24)
    expect(v3Output).toHaveLength(24)
    for (const expected of authority) {
      expect(v3Input.find((record) => record.id === expected.id)).toEqual(expected)
    }
    expect(v3Input.find((record) => record.id === 'qgate-09')?.sourceText)
      .toBe('PRIVATE_BODY_NINE')
    expect(readFileSync(v3InputPath, 'utf8')).not.toContain('PRIVATE_TASK_NOTE_NINE')
    expect(v3Output.find((record) => record.id === 'qgate-08')?.translation)
      .toBe('CORRECTED_TRANSLATION_EIGHT')
    expect(v3Output.find((record) => record.id === 'qgate-09')?.translation)
      .toBe('CORRECTED_TRANSLATION_NINE')
    const initialInputLines = readFileSync(
      path.join(roundRoot, 'gpt-baseline-input.jsonl'),
      'utf8',
    ).trimEnd().split(/\r?\n/)
    const v3InputLines = readFileSync(v3InputPath, 'utf8').trimEnd().split(/\r?\n/)
    const initialOutputLines = readFileSync(
      path.join(roundRoot, 'gpt-baseline-output.jsonl'),
      'utf8',
    ).trimEnd().split(/\r?\n/)
    const v3OutputLines = readFileSync(v3OutputPath, 'utf8').trimEnd().split(/\r?\n/)
    for (const index of ids.map((_, index) => index).filter((index) => ![7, 8].includes(index))) {
      expect(v3InputLines[index]).toBe(initialInputLines[index])
      expect(v3OutputLines[index]).toBe(initialOutputLines[index])
    }
    const correctionAudit = readJson(
      path.join(outputDir, 'gpt-baseline-correction-v3.json'),
    )
    expect(correctionAudit).toMatchObject({
      status: 'complete',
      count: 24,
      relativeToInitial: {
        inputCorrectedCount: 2,
        inputUnchangedCount: 22,
        outputCorrectedCount: 2,
        outputUnchangedCount: 22,
      },
      relativeToV2: {
        inputCorrectedCount: 2,
        inputUnchangedCount: 22,
        outputCorrectedCount: 1,
        outputUnchangedCount: 23,
      },
      authority: { exactRecordCount: 24, mismatchCount: 0 },
    })
    const protectedAuditTexts = new Set([
      ...authority.map((record) => record.sourceText),
      ...initialInput.map((record) => record.sourceText),
      ...v2Input.map((record) => record.sourceText),
      ...initialOutput.map((record) => record.translation),
      ...v2Output.map((record) => record.translation),
      ...v3Output.map((record) => record.translation),
    ])
    const forbiddenAuditKey = /(translation|sourceText|body|content|key|token|secret)/i
    const assertSafeAuditValue = (value: unknown, location = 'correction'): void => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => assertSafeAuditValue(item, `${location}[${index}]`))
        return
      }
      if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
          expect(key, `${location}.${key}`).not.toMatch(forbiddenAuditKey)
          assertSafeAuditValue(item, `${location}.${key}`)
        }
        return
      }
      if (typeof value === 'string') {
        expect(protectedAuditTexts.has(value), location).toBe(false)
      }
    }
    assertSafeAuditValue(correctionAudit)

    const contaminatedSource = 'PRIVATE_BODY_NINE\n\n---\n\nPRIVATE_TASK_NOTE_NINE'
    const contaminatedQuality = authority.map((record) => record.id === 'qgate-09'
      ? { ...record, sourceText: contaminatedSource }
      : record)
    const contaminatedFinal = formal.map((record) => record.sampleId === 'qgate-09'
      ? { ...record, sourceText: contaminatedSource }
      : record)
    writeJsonl(path.join(roundRoot, 'quality-simplified.jsonl'), contaminatedQuality)
    writeJsonl(path.join(runDir, 'final.jsonl'), contaminatedFinal)
    const rejected = await runNode(PREPARE_GPT_BASELINE, [
      `--round-root=${roundRoot}`,
      `--run-dir=${runDir}`,
      `--output-dir=${path.join(fixtureRoot, 'rejected-output')}`,
    ])
    expect(rejected.code).toBe(1)
    expect(rejected.stderr).toContain('qgate-09: task-note suffix contaminated formal sourceText')
  })

  it('keeps the real stream-shape probe on the frozen 900-second timeout', async () => {
    const { parseProbeArguments } = await import(pathToFileURL(STREAM_SHAPE_PROBE).href)
    expect(parseProbeArguments(['--profile=simple'])).not.toHaveProperty('timeoutMs')
    expect(() => parseProbeArguments(['--timeout-ms=1000'])).toThrow('invalid_argument')
    expect(() => parseProbeArguments(['--timeout-ms=900000'])).toThrow('invalid_argument')
  })

  it('rereads strict NewAPI credentials and keeps the key out of the child environment', async () => {
    const {
      assertExternalCredentialPath,
      buildRunnerEnvironment,
      createExperimentCredentialResolver,
      normalizeConnectionBase,
      parseKeyFileContents,
      redactCredentialText,
      redactCredentialValue,
      withValidatedCredentialHandle,
    } = await import(pathToFileURL(RUN_WITH_KEY_FILE).href)
    const directory = tempDir()
    const keyFile = path.join(directory, 'connection.json')
    const endpoint = { baseUrl: 'https://newapi.example.test' }
    const writeCredential = (key: string, url = endpoint.baseUrl) => writeJson(keyFile, {
      _type: 'newapi_channel_conn',
      key,
      url,
    })

    writeCredential('first-fixture-credential')
    const resolveCredential = createExperimentCredentialResolver({ keyFilePath: keyFile, endpoint })
    expect(await resolveCredential()).toBe('first-fixture-credential')
    writeCredential('rotated-fixture-credential')
    expect(await resolveCredential()).toBe('rotated-fixture-credential')
    const validatedKeyFile = await assertExternalCredentialPath(keyFile, ROOT)
    // Windows can spell one file with either a long path or its 8.3 alias.
    const requestedIdentity = statSync(keyFile, { bigint: true })
    const validatedIdentity = statSync(validatedKeyFile, { bigint: true })
    expect({ dev: validatedIdentity.dev, ino: validatedIdentity.ino }).toEqual({
      dev: requestedIdentity.dev,
      ino: requestedIdentity.ino,
    })
    await expect(assertExternalCredentialPath(validatedKeyFile, ROOT, {
      actualRepositoryRoot: ROOT,
      osTemporaryRoot: tmpdir(),
    })).resolves.toBeDefined()

    const replacementPath = path.join(directory, 'replacement-connection.json')
    const displacedPath = path.join(directory, 'displaced-connection.json')
    writeJson(replacementPath, {
      _type: 'newapi_channel_conn',
      key: 'replacement-must-not-be-read',
      url: endpoint.baseUrl,
    })
    const sameHandleContents = await withValidatedCredentialHandle(
      keyFile,
      ROOT,
      {},
      async (handle: FileHandle) => {
        renameSync(keyFile, displacedPath)
        renameSync(replacementPath, keyFile)
        return handle.readFile({ encoding: 'utf8' })
      },
    )
    expect(JSON.parse(sameHandleContents).key).toBe('rotated-fixture-credential')
    expect(JSON.parse(sameHandleContents).key).not.toBe('replacement-must-not-be-read')
    renameSync(keyFile, replacementPath)
    renameSync(displacedPath, keyFile)

    const environmentCredential = createExperimentCredentialResolver({
      keyFilePath: null,
      endpoint,
      environment: { FSBP_EXPERIMENT_API_KEY: 'environment-fixture-credential' },
    })
    expect(await environmentCredential()).toBe('environment-fixture-credential')
    expect(() => createExperimentCredentialResolver({
      keyFilePath: keyFile,
      endpoint,
      environment: { FSBP_EXPERIMENT_API_KEY: 'conflicting-fixture-credential' },
    })).toThrow('conflicting_sources')
    expect(() => createExperimentCredentialResolver({
      keyFilePath: null,
      endpoint,
      environment: {},
    })).toThrow('No experiment credential source is configured.')
    await expect(assertExternalCredentialPath(
      path.join(ROOT, 'credential-must-not-live-here.json'),
      ROOT,
    )).rejects.toThrow('must be outside the repository')

    const switchedRoot = path.join(directory, 'selected-repository')
    mkdirSync(switchedRoot)
    const insideSwitchedRoot = path.join(switchedRoot, 'credential.json')
    writeCredential('restore-external-credential')
    writeJson(insideSwitchedRoot, {
      _type: 'newapi_channel_conn',
      key: 'inside-switched-root',
      url: endpoint.baseUrl,
    })
    await expect(assertExternalCredentialPath(
      insideSwitchedRoot,
      switchedRoot,
    )).rejects.toThrow('must be outside the repository')

    const declaredOsTemp = path.join(directory, 'declared-os-temp')
    mkdirSync(declaredOsTemp)
    await expect(assertExternalCredentialPath(keyFile, ROOT, {
      osTemporaryRoot: declaredOsTemp,
    })).rejects.toThrow('must be inside the OS temporary directory')

    const hardlinkTarget = path.join(directory, 'hardlink-target.json')
    const hardlinkAlias = path.join(directory, 'hardlink-alias.json')
    writeJson(hardlinkTarget, {
      _type: 'newapi_channel_conn',
      key: 'hardlink-fixture',
      url: endpoint.baseUrl,
    })
    linkSync(hardlinkTarget, hardlinkAlias)
    await expect(assertExternalCredentialPath(hardlinkTarget, ROOT))
      .rejects.toThrow('single-link regular file')

    const symlinkTarget = path.join(directory, 'symlink-target.json')
    const symlinkAlias = path.join(directory, 'symlink-alias.json')
    writeJson(symlinkTarget, {
      _type: 'newapi_channel_conn',
      key: 'symlink-fixture',
      url: endpoint.baseUrl,
    })
    try {
      symlinkSync(symlinkTarget, symlinkAlias, 'file')
      await expect(assertExternalCredentialPath(symlinkAlias, ROOT))
        .rejects.toThrow('regular non-link file')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    }

    const junctionTarget = path.join(directory, 'junction-target')
    const junctionAlias = path.join(directory, 'junction-alias')
    mkdirSync(junctionTarget)
    writeJson(path.join(junctionTarget, 'credential.json'), {
      _type: 'newapi_channel_conn',
      key: 'junction-fixture',
      url: endpoint.baseUrl,
    })
    try {
      symlinkSync(junctionTarget, junctionAlias, 'junction')
      await expect(assertExternalCredentialPath(
        path.join(junctionAlias, 'credential.json'),
        ROOT,
      )).rejects.toThrow('reparse links')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    }

    expect(() => parseKeyFileContents('plaintext-key', { requireConnectionJson: true }))
      .toThrow('must contain a NewAPI connection JSON object')
    expect(() => normalizeConnectionBase('http://127.0.0.1:3000'))
      .toThrow('Connection JSON url must use HTTPS.')
    writeCredential('wrong-endpoint-credential', 'https://other.example.test')
    await expect(resolveCredential()).rejects.toThrow(
      'Connection JSON url does not match the frozen experiment endpoint.',
    )

    const environment = buildRunnerEnvironment({
      FSBP_EXPERIMENT_API_KEY: 'must-not-reach-child',
      PRESERVED_FIXTURE_VALUE: 'yes',
    }, keyFile)
    expect(environment).toMatchObject({
      FSBP_EXPERIMENT_KEY_FILE: keyFile,
      PRESERVED_FIXTURE_VALUE: 'yes',
    })
    expect(environment).not.toHaveProperty('FSBP_EXPERIMENT_API_KEY')
    const unsafe = [
      'Authorization: Bearer sk-secret-value-123456',
      'token=opaque-secret-value',
    ].join('; ')
    const redacted = redactCredentialText(unsafe, ['opaque-secret-value'])
    expect(redacted).not.toContain('sk-secret-value-123456')
    expect(redacted).not.toContain('opaque-secret-value')
    expect(redacted).toContain('[REDACTED_CREDENTIAL]')
    expect(redactCredentialValue({
      raw: 'prefix arbitraryCredential suffix',
      nested: ['arbitraryCredential'],
    }, ['arbitraryCredential'])).toEqual({
      raw: 'prefix [REDACTED_CREDENTIAL] suffix',
      nested: ['[REDACTED_CREDENTIAL]'],
    })
    expect(readJson(path.join(ROOT, 'package.json')).scripts['experiment:round0820:run'])
      .toBe('node scripts/run-round-0820.mjs')
    expect(
      readJson(path.join(ROOT, 'package.json')).scripts[
        'experiment:round0820:run:legacy-key-file'
      ],
    ).toBe('node scripts/run-round-0820-with-key-file.mjs')
  })

  it('rejects a real runner CLI invocation without an external credential source', async () => {
    const fixture = await createFrozenFixture('http://127.0.0.1:9')
    const result = await runNode(RUN, [
      `--repo-root=${fixture.repository}`,
      `--freeze=${fixture.freezePath}`,
      '--run-id=missing-credential-fixture',
      '--allow-nonformal',
    ], { skipSyntheticRunnerCredential: true })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('No experiment credential source is configured.')
    expect(result.stderr).not.toContain(SYNTHETIC_RUNNER_KEY)
  })

  it('freezes source, prompt, model, parameter, seed, annotation, and data identities', async () => {
    const fixture = await createFrozenFixture('http://127.0.0.1:9')
    const manifest = readJson(fixture.freezePath)
    expect(manifest).toMatchObject({
      roundId: 'round-0820',
      namespace: 'fsbp',
      mode: 'development',
      formalEligible: false,
      formalValidation: { status: 'not_evaluated_development_mode' },
      annotation_source: 'natural_model_runs',
      annotation_version: 'annotation-v1',
      determinism_level: 'partial',
      source: { clean: true },
      snapshot: {
        namespace: 'fsbp',
        conditions: ['direct', 'multi_raw', 'multi_fsbp'],
      },
    })
    expect(manifest.source.commit).toMatch(/^[a-f0-9]{40}$/)
    expect(manifest.freezeManifestSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.hashes.promptBundleSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.hashes.modelSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.hashes.parametersSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.hashes.seedSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.snapshot.datasets.quality.recordHashes['quality-one'])
      .toMatch(/^[a-f0-9]{64}$/)

    const formalPath = path.join(path.dirname(fixture.freezePath), 'formal-freeze.json')
    const formal = await runNode(FREEZE, [
      `--repo-root=${fixture.repository}`,
      `--config=${path.join(fixture.repository, 'config.json')}`,
      `--output=${formalPath}`,
      '--mode=formal',
    ])
    expect(formal.code).toBe(1)
    expect(formal.stderr).toContain(
      'Formal freeze: quality dataset must contain exactly 24 records, found 1.',
    )
    expect(existsSync(formalPath)).toBe(false)
  })

  it('rejects self-hashed manifests that tamper with the frozen runtime contract', async () => {
    const fixture = await createFrozenFixture('http://127.0.0.1:9')
    const { hashJson } = await import(pathToFileURL(
      path.join(ROOT, 'scripts', 'round-0820-lib.mjs'),
    ).href)
    const original = readJson(fixture.freezePath)
    const cases: Array<{
      name: string
      mutate: (manifest: any) => void
      error: string
    }> = [
      {
        name: 'model',
        mutate: (manifest) => { manifest.snapshot.models.candidates[1] = 'UNFROZEN_MODEL' },
        error: 'Frozen models.candidates must be exactly',
      },
      {
        name: 'max-tokens',
        mutate: (manifest) => { manifest.snapshot.parameters.maxTokens = 8_192 },
        error: 'Frozen parameters.maxTokens must be exactly 131072.',
      },
      {
        name: 'timeout',
        mutate: (manifest) => { manifest.snapshot.parameters.timeoutMs = 10_000 },
        error: 'Frozen parameters.timeoutMs must be exactly 900000.',
      },
      {
        name: 'concurrency',
        mutate: (manifest) => { manifest.snapshot.parameters.sampleConcurrency = 1 },
        error: 'Frozen parameters.sampleConcurrency must be exactly 5.',
      },
      {
        name: 'endpoint-secret',
        mutate: (manifest) => { manifest.snapshot.endpoint.apiKey = 'forbidden-inline-value' },
        error: 'Frozen endpoint may contain only',
      },
    ]

    for (const testCase of cases) {
      const manifest = structuredClone(original)
      testCase.mutate(manifest)
      delete manifest.freezeManifestSha256
      manifest.freezeManifestSha256 = hashJson(manifest)
      const tamperedPath = path.join(
        path.dirname(fixture.freezePath),
        `tampered-${testCase.name}.json`,
      )
      writeJson(tamperedPath, manifest)
      const result = await runNode(RUN, [
        `--repo-root=${fixture.repository}`,
        `--freeze=${tamperedPath}`,
        `--run-id=tampered-${testCase.name}`,
        '--allow-nonformal',
      ])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain(testCase.error)
    }
  })

  it('reuses one immutable candidate snapshot and changes only the raw/body projection', async () => {
    const requests: any[] = []
    let callNumber = 0
    let forcedRescue = false
    const server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      const payload = JSON.parse(body)
      requests.push(payload)
      callNumber += 1
      if (!forcedRescue && payload.messages[0].content === 'ANALYSIS_A') {
        forcedRescue = true
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'forced transient analysis failure' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        choices: [{
          finish_reason: 'stop',
          message: { content: `BODY_${callNumber}\n---\nNOTE_${callNumber}` },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      }))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture port.')
    const fixture = await createFrozenFixture(`http://127.0.0.1:${address.port}`)
    const runDir = path.join(
      fixture.repository,
      'FSBP_Test',
      'private',
      'round-0820',
      'runs',
      'paired-fixture',
    )
    const args = [
      `--repo-root=${fixture.repository}`,
      `--freeze=${fixture.freezePath}`,
      `--output=${runDir}`,
      '--run-id=paired-fixture',
      '--allow-nonformal',
    ]
    const fixtureEnv = {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV ?? 'test',
      ROUND_0820_TEST_KEY: 'fixture-only',
    } satisfies NodeJS.ProcessEnv
    const first = await runNode(RUN, args, { env: fixtureEnv })
    expect(first.code, first.stderr).toBe(0)
    expect(requests).toHaveLength(15)

    const cache = readJsonl(path.join(runDir, 'candidate-cache.jsonl'))
    expect(cache).toHaveLength(1)
    expect(cache[0]).toMatchObject({
      immutable: true,
      namespace: 'fsbp',
      generatorCommit: readJson(fixture.freezePath).source.commit,
    })
    for (const field of [
      'sourceHash',
      'datasetSnapshotHash',
      'retrievalSnapshotHash',
      'controlHash',
      'candidateSetHash',
      'promptHash',
      'modelHash',
      'parametersHash',
    ]) expect(cache[0][field]).toMatch(/^[a-f0-9]{64}$/)

    const finals = readJsonl(path.join(runDir, 'final.jsonl'))
    const raw = finals.find((record) => record.condition === 'multi_raw')
    const fsbp = finals.find((record) => record.condition === 'multi_fsbp')
    expect(raw.candidateSnapshotHash).toBe(fsbp.candidateSnapshotHash)
    expect(raw.comparisonControlHash).toBe(fsbp.comparisonControlHash)
    expect(raw.pairId).toBe(fsbp.pairId)
    expect(raw.inheritedView).toBe('raw')
    expect(fsbp.inheritedView).toBe('body')

    expect(requests.every((payload) => !Object.hasOwn(payload, 'seed'))).toBe(true)
    const events = readJsonl(path.join(runDir, 'events.jsonl'))
    expect(events.every((record) => (
      record.providerSeedSent === false && Number.isSafeInteger(record.requestSeed)
    ))).toBe(true)
    expect(events.find((record) => record.fallbackAttempt === 1)).toMatchObject({
      phase: 'analysis',
      model: ROUND_GPT_MODEL,
      fallbackFrom: ROUND_GPT_MODEL,
      fallbackReason: 'provider_failure',
      logicalTaskKey: 'quality:quality-one:analysis:1',
      taskKey: 'quality:quality-one:analysis:1:fallback',
      fallbackAttempt: 1,
    })
    expect(readJson(path.join(runDir, 'run-manifest.json')).runtimeLimits)
      .toMatchObject({
        sampleConcurrency: 5,
        providerSeedSent: false,
        fallbackModel: ROUND_GPT_MODEL,
        fallbackAttempts: 1,
      })

    const requestPhases = requests.map((payload) => payload.messages[0].content)
    const analysisEnd = Math.max(
      requestPhases.indexOf('ANALYSIS_A'),
      requestPhases.indexOf('ANALYSIS_B'),
    )
    const candidateStart = Math.min(
      requestPhases.indexOf('CANDIDATE_A'),
      requestPhases.indexOf('CANDIDATE_B'),
      requestPhases.indexOf('CANDIDATE_C'),
    )
    const candidateEnd = Math.max(
      requestPhases.indexOf('CANDIDATE_A'),
      requestPhases.indexOf('CANDIDATE_B'),
      requestPhases.indexOf('CANDIDATE_C'),
    )
    expect(analysisEnd).toBeLessThan(candidateStart)
    expect(candidateEnd).toBeLessThan(requestPhases.indexOf('REVIEW'))

    const reviewRequests = requests.filter((payload) => payload.messages[0].content === 'REVIEW')
    expect(reviewRequests).toHaveLength(2)
    expect(reviewRequests.some((payload) => payload.messages[1].content.includes('NOTE_')))
      .toBe(true)
    expect(reviewRequests.some((payload) => !payload.messages[1].content.includes('NOTE_')))
      .toBe(true)

    const second = await runNode(RUN, args, { env: fixtureEnv })
    expect(second.code, second.stderr).toBe(0)
    expect(requests).toHaveLength(15)
    expect(readJson(path.join(runDir, 'run-manifest.json')).resultCounts)
      .toMatchObject({ total: 3, complete: 3, failed: 0, cachedCandidateSets: 1 })
  })

  it('retries token-limit truncation, preserves partial output, and excludes it from success', async () => {
    let requests = 0
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume request body */ }
      requests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        choices: [{
          finish_reason: 'length',
          message: {
            content: `PARTIAL_${requests} ${SYNTHETIC_RUNNER_KEY}\n---\nPARTIAL_NOTE_${requests} ${SYNTHETIC_RUNNER_KEY}`,
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 1024 },
      }))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture port.')
    const fixture = await createFrozenFixture(
      `http://127.0.0.1:${address.port}`,
      1,
    )
    const runDir = path.join(
      fixture.repository,
      'FSBP_Test',
      'private',
      'round-0820',
      'runs',
      'truncated-fixture',
    )
    const fixtureEnv = {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV ?? 'test',
      ROUND_0820_TEST_KEY: 'fixture-only',
    } satisfies NodeJS.ProcessEnv
    const result = await runNode(RUN, [
      `--repo-root=${fixture.repository}`,
      `--freeze=${fixture.freezePath}`,
      `--output=${runDir}`,
      '--run-id=truncated-fixture',
      '--allow-nonformal',
    ], { env: fixtureEnv })
    expect(result.code).toBe(1)
    expect(requests).toBe(9)
    expect(readJsonl(path.join(runDir, 'events.jsonl'))).toHaveLength(9)
    expect(readJsonl(path.join(runDir, 'events.jsonl')).every((record) => (
      record.status === 'incomplete_output' && record.truncated === true &&
      record.finishReason === 'length' && record.raw.startsWith('PARTIAL_')
    ))).toBe(true)
    const finals = readJsonl(path.join(runDir, 'final.jsonl'))
    expect(finals).toHaveLength(3)
    expect(finals.every((record) => (
      record.status === 'incomplete_output' && record.partialRaw.startsWith('PARTIAL_') &&
      record.partialBody.startsWith('PARTIAL_') && record.finishReason === 'length'
    ))).toBe(true)
    for (const artifact of ['events.jsonl', 'outcomes.jsonl', 'final.jsonl']) {
      const text = readFileSync(path.join(runDir, artifact), 'utf8')
      expect(text).not.toContain(SYNTHETIC_RUNNER_KEY)
      expect(text).toContain('[REDACTED_CREDENTIAL]')
    }
    expect(readJson(path.join(runDir, 'run-manifest.json'))).toMatchObject({
      status: 'completed_with_failures',
      resultCounts: { total: 3, complete: 0, failed: 3, recordedIncompleteAttempts: 9 },
    })
  })

  it('streams model calls and preserves partial text when upstream closes early', async () => {
    const requests: any[] = []
    const server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      requests.push(JSON.parse(body))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({
        choices: [{
          delta: { content: 'PARTIAL_STREAM\n---\nPARTIAL_NOTE' },
          finish_reason: null,
        }],
      })}\n\n`)
      response.end()
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture port.')
    const fixture = await createFrozenFixture(`http://127.0.0.1:${address.port}`)
    const runDir = path.join(
      fixture.repository,
      'FSBP_Test',
      'private',
      'round-0820',
      'runs',
      'interrupted-stream-fixture',
    )
    const result = await runNode(RUN, [
      `--repo-root=${fixture.repository}`,
      `--freeze=${fixture.freezePath}`,
      `--output=${runDir}`,
      '--run-id=interrupted-stream-fixture',
      '--allow-nonformal',
    ], {
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV ?? 'test',
        ROUND_0820_TEST_KEY: 'fixture-only',
      },
    })

    expect(result.code).toBe(1)
    expect(requests).toHaveLength(6)
    expect(requests.every((request) => request.stream === true)).toBe(true)
    const events = readJsonl(path.join(runDir, 'events.jsonl'))
    expect(events).toHaveLength(6)
    expect(events.every((record) => (
      record.errorCode === 'upstream_stream_interrupted' &&
      record.errorOrigin === 'upstream' &&
      record.partialRaw === 'PARTIAL_STREAM\n---\nPARTIAL_NOTE' &&
      record.partialBody === 'PARTIAL_STREAM' &&
      record.partialAnnotation === 'PARTIAL_NOTE' &&
      record.truncated === true
    ))).toBe(true)
    expect(readJsonl(path.join(runDir, 'final.jsonl')).every((record) => (
      record.status === 'failed' &&
      record.errorCode === 'upstream_stream_interrupted' &&
      record.partialBody === 'PARTIAL_STREAM'
    ))).toBe(true)
  })

  it('accepts NewAPI line-delimited SSE, standard multiline events, and evidenced clean EOF', async () => {
    let requests = 0
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume request body */ }
      requests += 1
      const content = `BODY_${requests}\n---\nNOTE_${requests}`
      const usage = { prompt_tokens: 10 + requests, completion_tokens: 20 + requests }
      let stream: string
      if (requests % 4 === 1) {
        // NewAPI can emit one complete JSON event per data line without the
        // blank-line event separator required by the SSE specification.
        stream = [
          `data: ${JSON.stringify({ choices: [{ delta: {
            reasoning_content: `PRIVATE_REASONING_${requests}`,
          }, finish_reason: null }] })}`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: `BODY_${requests}` }, finish_reason: null }] })}`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: '\n---\n' }, finish_reason: null }] })}`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: `NOTE_${requests}` }, finish_reason: null }] })}`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: null }], usage })}`,
          'data: [DONE]',
        ].join('\r\n')
      } else if (requests % 4 === 2) {
        // A standard SSE event may legally span several data lines. It must be
        // joined and consumed once, rather than treating each line as an event.
        stream = [
          `data: {"choices":[{"message":{"content":${JSON.stringify(content)},"thinking":${JSON.stringify(`PRIVATE_REASONING_${requests}`)}},`,
          `data: "finish_reason":"stop"}],"usage":${JSON.stringify(usage)}}`,
          '',
          '',
        ].join('\n')
      } else if (requests % 4 === 3) {
        // Some compatible providers finish with an aggregate message and usage
        // at a clean EOF, but omit both finish_reason and [DONE].
        stream = `data: ${JSON.stringify({
          choices: [{
            message: { content, reasoning: `PRIVATE_REASONING_${requests}` },
            finish_reason: null,
          }],
          usage,
        })}\n`
      } else {
        // A validated usage-only event can terminate preceding deltas at a
        // clean EOF when include_usage was explicitly requested.
        stream = [
          `data: ${JSON.stringify({ choices: [{ delta: {
            reasoning_content: `PRIVATE_REASONING_${requests}`,
            content,
          }, finish_reason: null }] })}`,
          `data: ${JSON.stringify({ choices: [], usage })}`,
        ].join('\n')
      }

      response.writeHead(200, { 'content-type': 'text/event-stream' })
      // Split across field names, JSON, CRLF, and UTF-8 decoder boundaries.
      const cuts = [1, 8, 19, 37, 64, 101]
      let offset = 0
      for (const cut of cuts) {
        if (offset >= stream.length) break
        response.write(stream.slice(offset, Math.min(stream.length, cut)))
        offset = Math.min(stream.length, cut)
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      response.end(stream.slice(offset))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture port.')
    const fixture = await createFrozenFixture(`http://127.0.0.1:${address.port}`)
    const runDir = path.join(
      fixture.repository,
      'FSBP_Test',
      'private',
      'round-0820',
      'runs',
      'sse-compatibility-fixture',
    )
    const result = await runNode(RUN, [
      `--repo-root=${fixture.repository}`,
      `--freeze=${fixture.freezePath}`,
      `--output=${runDir}`,
      '--run-id=sse-compatibility-fixture',
      '--allow-nonformal',
    ], {
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV ?? 'test',
        ROUND_0820_TEST_KEY: 'fixture-only',
      },
    })

    expect(result.code, result.stderr).toBe(0)
    expect(requests).toBe(14)
    const events = readJsonl(path.join(runDir, 'events.jsonl'))
    expect(events).toHaveLength(14)
    expect(events.every((record) => {
      const requestNumber = Number(/^BODY_(\d+)$/.exec(record.body)?.[1])
      return Number.isInteger(requestNumber) &&
        record.status === 'complete' &&
        record.finishReason === 'stop' &&
        record.transport === 'sse' &&
        record.raw === `BODY_${requestNumber}\n---\nNOTE_${requestNumber}` &&
        record.annotation === `NOTE_${requestNumber}` &&
        record.usage?.completion_tokens === 20 + requestNumber &&
        record.providerDiagnostics?.reasoningChunks === 1 &&
        record.providerDiagnostics?.reasoningCharacters ===
          `PRIVATE_REASONING_${requestNumber}`.length
    })).toBe(true)
    expect(events.every((record) => {
      const requestNumber = Number(/^BODY_(\d+)$/.exec(record.body)?.[1])
      const expectedField = requestNumber % 4 === 2
        ? 'thinking'
        : requestNumber % 4 === 3
          ? 'reasoning'
          : 'reasoning_content'
      return record.providerDiagnostics?.reasoningFields?.[0] === expectedField &&
        !JSON.stringify(record).includes('PRIVATE_REASONING_')
    })).toBe(true)
    expect(new Set(events.map((record) => record.terminalEvidence)))
      .toEqual(new Set(['done_marker', 'finish_reason', 'aggregate_message', 'final_usage']))
    expect(events.filter((record) => record.finishReasonInferred)).toHaveLength(10)
    expect(readJson(path.join(runDir, 'run-manifest.json')).resultCounts)
      .toMatchObject({ total: 3, complete: 3, failed: 0 })
  })

  it('treats DONE as immediately terminal and ignores post-terminal data or reset', async () => {
    const requests: any[] = []
    const server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      requests.push(JSON.parse(body))
      const number = requests.length
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write([
        `data: ${JSON.stringify({
          choices: [{
            delta: { content: `DONE_BODY_${number}\n---\nDONE_NOTE_${number}` },
            finish_reason: null,
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })}`,
        'data: [DONE]',
        `data: ${JSON.stringify({ choices: [{
          delta: { content: 'POST_DONE_MUST_NOT_APPEAR' },
          finish_reason: null,
        }] })}`,
        ': keepalive after done',
      ].join('\n'))
      // A compliant client cancels as soon as DONE is parsed. If it waits for
      // transport EOF, this later reset incorrectly turns success into a retry.
      setTimeout(() => {
        if (!response.destroyed) response.destroy(new Error('reset after terminal marker'))
      }, 50)
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture port.')
    const fixture = await createFrozenFixture(`http://127.0.0.1:${address.port}`, 1)
    const runDir = path.join(
      fixture.repository,
      'FSBP_Test',
      'private',
      'round-0820',
      'runs',
      'done-terminal-fixture',
    )
    const result = await runNode(RUN, [
      `--repo-root=${fixture.repository}`,
      `--freeze=${fixture.freezePath}`,
      `--output=${runDir}`,
      '--run-id=done-terminal-fixture',
      '--allow-nonformal',
    ], {
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV ?? 'test',
        ROUND_0820_TEST_KEY: 'fixture-only',
      },
    })

    expect(result.code, result.stderr).toBe(0)
    expect(requests).toHaveLength(14)
    expect(requests.every((request) => (
      request.stream === true && request.stream_options?.include_usage === true
    ))).toBe(true)
    const events = readJsonl(path.join(runDir, 'events.jsonl'))
    expect(events).toHaveLength(14)
    expect(events.every((record) => (
      record.status === 'complete' &&
      record.terminalEvidence === 'done_marker' &&
      record.finishReasonInferred === true &&
      !record.raw.includes('POST_DONE_MUST_NOT_APPEAR')
    ))).toBe(true)
  })

  it('treats explicit stop or length finish reasons as terminal before transport reset', async () => {
    const stopRequests: any[] = []
    const stopServer = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      stopRequests.push(JSON.parse(body))
      const number = stopRequests.length
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({
        choices: [{
          delta: { content: `STOP_BODY_${number}\n---\nSTOP_NOTE_${number}` },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })}\n`)
      setTimeout(() => {
        if (!response.destroyed) response.destroy(new Error('reset after stop'))
      }, 50)
    })
    let lengthRequests = 0
    const lengthServer = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume request body */ }
      lengthRequests += 1
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({
        choices: [{
          delta: { content: 'LENGTH_PARTIAL\n---\nLENGTH_NOTE' },
          finish_reason: 'length',
        }],
        usage: { prompt_tokens: 11, completion_tokens: 1024, total_tokens: 1035 },
      })}\r\n`)
      setTimeout(() => {
        if (!response.destroyed) response.destroy(new Error('reset after length'))
      }, 50)
    })
    servers.push(stopServer, lengthServer)
    await Promise.all([
      new Promise<void>((resolve) => stopServer.listen(0, '127.0.0.1', resolve)),
      new Promise<void>((resolve) => lengthServer.listen(0, '127.0.0.1', resolve)),
    ])

    const runFinishFixture = async (server: Server, runId: string) => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No fixture port.')
      const fixture = await createFrozenFixture(`http://127.0.0.1:${address.port}`)
      const runDir = path.join(
        fixture.repository,
        'FSBP_Test',
        'private',
        'round-0820',
        'runs',
        runId,
      )
      const result = await runNode(RUN, [
        `--repo-root=${fixture.repository}`,
        `--freeze=${fixture.freezePath}`,
        `--output=${runDir}`,
        `--run-id=${runId}`,
        '--allow-nonformal',
      ], {
        env: {
          ...process.env,
          NODE_ENV: process.env.NODE_ENV ?? 'test',
          ROUND_0820_TEST_KEY: 'fixture-only',
        },
      })
      return { result, runDir }
    }

    const stopped = await runFinishFixture(stopServer, 'finish-stop-fixture')
    expect(stopped.result.code, stopped.result.stderr).toBe(0)
    expect(stopRequests).toHaveLength(14)
    expect(readJsonl(path.join(stopped.runDir, 'events.jsonl')).every((record) => (
      record.status === 'complete' &&
      record.finishReason === 'stop' &&
      record.terminalEvidence === 'finish_reason' &&
      record.finishReasonInferred === false &&
      record.usage?.total_tokens === 15
    ))).toBe(true)

    const length = await runFinishFixture(lengthServer, 'finish-length-fixture')
    expect(length.result.code).toBe(1)
    expect(lengthRequests).toBe(6)
    const lengthEvents = readJsonl(path.join(length.runDir, 'events.jsonl'))
    expect(lengthEvents).toHaveLength(6)
    expect(lengthEvents.every((record) => (
      record.status === 'incomplete_output' &&
      record.finishReason === 'length' &&
      record.terminalEvidence === 'finish_reason' &&
      record.finishReasonInferred === false &&
      record.raw === 'LENGTH_PARTIAL\n---\nLENGTH_NOTE' &&
      record.usage?.completion_tokens === 1024
    ))).toBe(true)
  })

  it('audits missing usage when finish_reason cancels before a later usage chunk', async () => {
    let requests = 0
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume request body */ }
      requests += 1
      const number = requests
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({
        choices: [{
          delta: { content: `NO_USAGE_BODY_${number}\n---\nNO_USAGE_NOTE_${number}` },
          finish_reason: 'stop',
        }],
      })}\n`)
      setTimeout(() => {
        if (response.destroyed) return
        response.write(`data: ${JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        })}\n: delayed keepalive\n`)
      }, 25)
      setTimeout(() => {
        if (!response.destroyed) response.end()
      }, 100)
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture port.')
    const fixture = await createFrozenFixture(`http://127.0.0.1:${address.port}`, 1)
    const runDir = path.join(
      fixture.repository,
      'FSBP_Test',
      'private',
      'round-0820',
      'runs',
      'finish-before-usage-fixture',
    )
    const result = await runNode(RUN, [
      `--repo-root=${fixture.repository}`,
      `--freeze=${fixture.freezePath}`,
      `--output=${runDir}`,
      '--run-id=finish-before-usage-fixture',
      '--allow-nonformal',
    ], {
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV ?? 'test',
        ROUND_0820_TEST_KEY: 'fixture-only',
      },
    })

    expect(result.code, result.stderr).toBe(0)
    expect(requests).toBe(14)
    const events = readJsonl(path.join(runDir, 'events.jsonl'))
    expect(events).toHaveLength(14)
    expect(events.every((record) => (
      record.status === 'complete' &&
      record.finishReason === 'stop' &&
      record.terminalEvidence === 'finish_reason' &&
      record.finishReasonInferred === false &&
      record.usage === null
    ))).toBe(true)
    expect(readJson(path.join(runDir, 'run-manifest.json')).usageStatistics)
      .toMatchObject({
        attemptsWithUsage: 0,
        attemptsMissingUsage: 14,
        completedAttemptsWithUsage: 0,
        failedAttemptsWithUsage: 0,
        incompleteAttemptsWithUsage: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      })
  })

  it('rejects an in-band SSE error before DONE and preserves safe partial cost evidence', async () => {
    const secret = 'SECRET_PROVIDER_BODY_MUST_NOT_PERSIST'
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume request body */ }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end([
        `data: ${JSON.stringify({
          choices: [{
            delta: { content: 'PARTIAL_BEFORE_ERROR\n---\nPARTIAL_NOTE' },
            finish_reason: null,
          }],
          usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
        })}`,
        `data: ${JSON.stringify({ error: {
          message: secret,
          type: 'upstream_error',
          code: 'provider_stream_error',
          status: 503,
        } })}`,
        'data: [DONE]',
      ].join('\n'))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture port.')
    const fixture = await createFrozenFixture(`http://127.0.0.1:${address.port}`)
    const runDir = path.join(
      fixture.repository,
      'FSBP_Test',
      'private',
      'round-0820',
      'runs',
      'in-band-error-fixture',
    )
    const result = await runNode(RUN, [
      `--repo-root=${fixture.repository}`,
      `--freeze=${fixture.freezePath}`,
      `--output=${runDir}`,
      '--run-id=in-band-error-fixture',
      '--allow-nonformal',
    ], {
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV ?? 'test',
        ROUND_0820_TEST_KEY: 'fixture-only',
      },
    })

    expect(result.code).toBe(1)
    const events = readJsonl(path.join(runDir, 'events.jsonl'))
    expect(events).toHaveLength(6)
    expect(events.every((record) => (
      record.status === 'failed' &&
      record.errorCode === 'upstream_event_error' &&
      record.error === 'Upstream SSE event reported an error.' &&
      record.partialRaw === 'PARTIAL_BEFORE_ERROR\n---\nPARTIAL_NOTE' &&
      record.partialBody === 'PARTIAL_BEFORE_ERROR' &&
      record.partialAnnotation === 'PARTIAL_NOTE' &&
      record.usage?.prompt_tokens === 12 &&
      record.providerEventError?.code === 'provider_stream_error' &&
      !JSON.stringify(record).includes(secret)
    ))).toBe(true)
    expect(events.filter((record) => record.fallbackAttempt === null)).toHaveLength(3)
    expect(events.filter((record) => (
      record.fallbackAttempt === 1 &&
      record.fallbackReason === 'upstream_event_error' &&
      typeof record.fallbackFrom === 'string'
    ))).toHaveLength(3)
    expect(readJson(path.join(runDir, 'run-manifest.json')).usageStatistics)
      .toMatchObject({
        attemptsWithUsage: 6,
        failedAttemptsWithUsage: 6,
        promptTokens: 72,
        completionTokens: 42,
        totalTokens: 114,
      })
  })

  it('completes after exactly one frozen fallback for an SSE invalid_request_error', async () => {
    const requestAttempts = new Map<string, number>()
    const requests: any[] = []
    const server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      const payload = JSON.parse(body)
      requests.push(payload)
      const requestKey = JSON.stringify(payload.messages)
      const attempt = (requestAttempts.get(requestKey) ?? 0) + 1
      requestAttempts.set(requestKey, attempt)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (attempt % 2 === 1) {
        response.end([
          `data: ${JSON.stringify({ choices: [{
            delta: { content: `PRIMARY_PARTIAL_${requests.length}\n---\nPRIMARY_NOTE` },
            finish_reason: null,
          }] })}`,
          `data: ${JSON.stringify({ error: {
            message: 'mislabelled transient failure',
            type: 'invalid_request_error',
            code: 'invalid_request',
            status: 400,
          } })}`,
        ].join('\n'))
        return
      }
      response.end(`data: ${JSON.stringify({
        choices: [{
          message: { content: `FALLBACK_BODY_${requests.length}\n---\nFALLBACK_NOTE` },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      })}\n`)
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture port.')
    const fixture = await createFrozenFixture(`http://127.0.0.1:${address.port}`, 1)
    const runDir = path.join(
      fixture.repository,
      'FSBP_Test',
      'private',
      'round-0820',
      'runs',
      'event-fallback-success-fixture',
    )
    const result = await runNode(RUN, [
      `--repo-root=${fixture.repository}`,
      `--freeze=${fixture.freezePath}`,
      `--output=${runDir}`,
      '--run-id=event-fallback-success-fixture',
      '--allow-nonformal',
    ], {
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV ?? 'test',
        ROUND_0820_TEST_KEY: 'fixture-only',
      },
    })

    expect(result.code, result.stderr).toBe(0)
    expect(requests).toHaveLength(28)
    expect([...requestAttempts.values()].every((attempts) => attempts === 2)).toBe(true)
    const events = readJsonl(path.join(runDir, 'events.jsonl'))
    expect(events).toHaveLength(28)
    const byLogicalTask = new Map<string, any[]>()
    for (const record of events) {
      const attempts = byLogicalTask.get(record.logicalTaskKey) ?? []
      attempts.push(record)
      byLogicalTask.set(record.logicalTaskKey, attempts)
    }
    expect(byLogicalTask.size).toBe(14)
    for (const attempts of byLogicalTask.values()) {
      expect(attempts).toHaveLength(2)
      const primary = attempts.find((record) => record.fallbackAttempt === null)
      const fallback = attempts.find((record) => record.fallbackAttempt === 1)
      expect(primary).toMatchObject({
        status: 'failed',
        errorCode: 'upstream_event_error',
        providerEventError: { type: 'invalid_request_error', code: 'invalid_request', status: 400 },
        partialBody: expect.stringMatching(/^PRIMARY_PARTIAL_/),
      })
      expect(fallback).toMatchObject({
        status: 'complete',
        fallbackReason: 'upstream_event_error',
        fallbackAttempt: 1,
      })
      expect(typeof fallback.fallbackFrom).toBe('string')
    }
    const outcomes = readJsonl(path.join(runDir, 'final.jsonl'))
    expect(outcomes).toHaveLength(3)
    expect(outcomes.every((record) => record.status === 'complete')).toBe(true)
    expect(readJson(path.join(runDir, 'run-manifest.json')).status).toBe('complete')
  })

  it('routes every SSE error event directly to at most one frozen fallback', async () => {
    const deterministicRequests: any[] = []
    const deterministicServer = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      const payload = JSON.parse(body)
      deterministicRequests.push(payload)
      const status = payload.messages[0].content === 'DIRECT' ? 401 : 400
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ error: {
        message: 'must not be persisted',
        type: 'authentication_error',
        code: status === 401 ? 'invalid_token' : 'invalid_request',
        status,
      } })}\n`)
    })
    let transientRequests = 0
    const transientServer = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume request body */ }
      transientRequests += 1
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ error: {
        message: 'temporary body must not be persisted',
        type: 'server_error',
        code: 'service_unavailable',
        status: 503,
      } })}\n`)
    })
    servers.push(deterministicServer, transientServer)
    await Promise.all([
      new Promise<void>((resolve) => deterministicServer.listen(0, '127.0.0.1', resolve)),
      new Promise<void>((resolve) => transientServer.listen(0, '127.0.0.1', resolve)),
    ])

    const runErrorFixture = async (server: Server, runId: string) => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No fixture port.')
      const fixture = await createFrozenFixture(`http://127.0.0.1:${address.port}`, 1)
      const runDir = path.join(
        fixture.repository,
        'FSBP_Test',
        'private',
        'round-0820',
        'runs',
        runId,
      )
      const result = await runNode(RUN, [
        `--repo-root=${fixture.repository}`,
        `--freeze=${fixture.freezePath}`,
        `--output=${runDir}`,
        `--run-id=${runId}`,
        '--allow-nonformal',
      ], {
        env: {
          ...process.env,
          NODE_ENV: process.env.NODE_ENV ?? 'test',
          ROUND_0820_TEST_KEY: 'fixture-only',
        },
      })
      return { result, runDir }
    }

    const deterministic = await runErrorFixture(
      deterministicServer,
      'deterministic-event-error-fixture',
    )
    expect(deterministic.result.code).toBe(1)
    expect(deterministicRequests).toHaveLength(6)
    const deterministicEvents = readJsonl(path.join(deterministic.runDir, 'events.jsonl'))
    expect(deterministicEvents).toHaveLength(6)
    expect(deterministicEvents.map((record) => record.providerEventError.status).sort())
      .toEqual([400, 400, 400, 400, 401, 401])
    expect(deterministicEvents.every((record) => (
      record.errorCode === 'upstream_event_error' &&
      record.retryScheduled === false &&
      record.attempt === 1
    ))).toBe(true)
    expect(deterministicEvents.filter((record) => record.fallbackAttempt === null))
      .toHaveLength(3)
    expect(deterministicEvents.filter((record) => (
      record.fallbackAttempt === 1 &&
      record.fallbackReason === 'upstream_event_error' &&
      typeof record.fallbackFrom === 'string'
    ))).toHaveLength(3)
    const deterministicAttemptsByTask = new Map<string, number>()
    for (const record of deterministicEvents) {
      deterministicAttemptsByTask.set(
        record.logicalTaskKey,
        (deterministicAttemptsByTask.get(record.logicalTaskKey) ?? 0) + 1,
      )
    }
    expect([...deterministicAttemptsByTask.values()]).toEqual([2, 2, 2])
    const deterministicOutcomes = readJsonl(path.join(deterministic.runDir, 'final.jsonl'))
    expect(deterministicOutcomes).toHaveLength(3)
    expect(deterministicOutcomes.every((record) => (
      record.status === 'failed' && record.errorCode === 'upstream_event_error'
    ))).toBe(true)
    expect(readJson(path.join(deterministic.runDir, 'run-manifest.json')).status)
      .toBe('completed_with_failures')

    const transient = await runErrorFixture(transientServer, 'transient-event-error-fixture')
    expect(transient.result.code).toBe(1)
    expect(transientRequests).toBe(6)
    const transientEvents = readJsonl(path.join(transient.runDir, 'events.jsonl'))
    expect(transientEvents).toHaveLength(6)
    expect(transientEvents.every((record) => record.retryScheduled === false)).toBe(true)
    expect(transientEvents.every((record) => (
      record.errorCode === 'upstream_event_error' &&
      record.providerEventError.status === 503
    ))).toBe(true)
    expect(transientEvents.filter((record) => record.fallbackAttempt === null)).toHaveLength(3)
    expect(transientEvents.filter((record) => (
      record.fallbackAttempt === 1 &&
      record.fallbackReason === 'upstream_event_error'
    ))).toHaveLength(3)
    const transientAttemptsByTask = new Map<string, number>()
    for (const record of transientEvents) {
      transientAttemptsByTask.set(
        record.logicalTaskKey,
        (transientAttemptsByTask.get(record.logicalTaskKey) ?? 0) + 1,
      )
    }
    expect([...transientAttemptsByTask.values()]).toEqual([2, 2, 2])
  })

  it('keeps HTTP 400 invalid_request fatal while SSE event errors get one fallback', async () => {
    const httpRequests: any[] = []
    const httpServer = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      const payload = JSON.parse(body)
      httpRequests.push(payload)
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'invalid_request' } }))
    })
    const eventRequests: any[] = []
    const eventServer = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      const payload = JSON.parse(body)
      eventRequests.push(payload)
      const prompt = payload.messages[0].content
      const error = prompt === 'DIRECT'
        ? { message: 'invalid API key supplied' }
        : prompt === 'ANALYSIS_A'
          ? { message: 'hidden', code: 'model_not_found' }
          : { message: 'hidden', code: 'unknown_provider_event' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ error })}\n`)
    })
    servers.push(httpServer, eventServer)
    await Promise.all([
      new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve)),
      new Promise<void>((resolve) => eventServer.listen(0, '127.0.0.1', resolve)),
    ])

    const runFailureFixture = async (server: Server, runId: string) => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No fixture port.')
      const fixture = await createFrozenFixture(`http://127.0.0.1:${address.port}`)
      const runDir = path.join(
        fixture.repository,
        'FSBP_Test',
        'private',
        'round-0820',
        'runs',
        runId,
      )
      const result = await runNode(RUN, [
        `--repo-root=${fixture.repository}`,
        `--freeze=${fixture.freezePath}`,
        `--output=${runDir}`,
        `--run-id=${runId}`,
        '--allow-nonformal',
      ])
      return { result, runDir }
    }

    const http = await runFailureFixture(httpServer, 'fail-closed-http-fixture')
    expect(http.result.code).toBe(1)
    expect(httpRequests).toHaveLength(3)
    const httpEvents = readJsonl(path.join(http.runDir, 'events.jsonl'))
    expect(httpEvents).toHaveLength(3)
    expect(httpEvents.map((record) => record.error).sort()).toEqual([
      'HTTP 400: invalid_request',
      'HTTP 400: invalid_request',
      'HTTP 400: invalid_request',
    ])
    expect(httpEvents.every((record) => (
      record.errorCode === 'provider_request_rejected' &&
      record.fallbackAttempt === null
    ))).toBe(true)

    const event = await runFailureFixture(eventServer, 'fail-closed-event-fixture')
    expect(event.result.code).toBe(1)
    expect(eventRequests).toHaveLength(6)
    const eventEvents = readJsonl(path.join(event.runDir, 'events.jsonl'))
    expect(eventEvents).toHaveLength(6)
    expect(new Set(eventEvents.map((record) => record.providerEventError.code ?? null)))
      .toEqual(new Set([null, 'model_not_found', 'unknown_provider_event']))
    expect(eventEvents.every((record) => (
      record.errorCode === 'upstream_event_error' &&
      record.retryScheduled === false
    ))).toBe(true)
    expect(eventEvents.filter((record) => record.fallbackAttempt === null)).toHaveLength(3)
    expect(eventEvents.filter((record) => (
      record.fallbackAttempt === 1 &&
      record.fallbackReason === 'upstream_event_error'
    ))).toHaveLength(3)
  })

  it('rejects malformed residual SSE data and usage-only clean EOF without content', async () => {
    const malformedServer = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume request body */ }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end([
        `data: ${JSON.stringify({
          choices: [{
            delta: { content: 'VALID_BEFORE_MALFORMED\n---\nVALID_NOTE' },
            finish_reason: null,
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })}`,
        'data: {"choices":[{"delta":{"content":"TRUNCATED',
      ].join('\n'))
    })
    const zeroContentServer = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume request body */ }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end([
        `data: ${JSON.stringify({ choices: [{
          delta: {
            reasoning_content: 'PRIVATE_REASONING_MUST_NOT_PERSIST',
            thinking: 'PRIVATE_THINKING_MUST_NOT_PERSIST',
          },
          finish_reason: null,
        }] })}`,
        `data: ${JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 0 },
        })}`,
      ].join('\r\n'))
    })
    servers.push(malformedServer, zeroContentServer)
    await Promise.all([
      new Promise<void>((resolve) => malformedServer.listen(0, '127.0.0.1', resolve)),
      new Promise<void>((resolve) => zeroContentServer.listen(0, '127.0.0.1', resolve)),
    ])

    const runFailureFixture = async (server: Server, runId: string) => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No fixture port.')
      const fixture = await createFrozenFixture(`http://127.0.0.1:${address.port}`)
      const runDir = path.join(
        fixture.repository,
        'FSBP_Test',
        'private',
        'round-0820',
        'runs',
        runId,
      )
      const result = await runNode(RUN, [
        `--repo-root=${fixture.repository}`,
        `--freeze=${fixture.freezePath}`,
        `--output=${runDir}`,
        `--run-id=${runId}`,
        '--allow-nonformal',
      ], {
        env: {
          ...process.env,
          NODE_ENV: process.env.NODE_ENV ?? 'test',
          ROUND_0820_TEST_KEY: 'fixture-only',
        },
      })
      return { result, runDir }
    }

    const malformed = await runFailureFixture(malformedServer, 'malformed-sse-fixture')
    expect(malformed.result.code).toBe(1)
    const malformedEvents = readJsonl(path.join(malformed.runDir, 'events.jsonl'))
    expect(malformedEvents).toHaveLength(6)
    expect(malformedEvents.every((record) => (
      record.status === 'failed' &&
      record.errorCode === 'upstream_stream_interrupted' &&
      record.partialRaw === 'VALID_BEFORE_MALFORMED\n---\nVALID_NOTE' &&
      record.partialBody === 'VALID_BEFORE_MALFORMED' &&
      record.partialAnnotation === 'VALID_NOTE'
    ))).toBe(true)
    expect(readJson(path.join(malformed.runDir, 'run-manifest.json')).resultCounts)
      .toMatchObject({ total: 3, complete: 0, failed: 3 })

    const zeroContent = await runFailureFixture(zeroContentServer, 'zero-content-sse-fixture')
    expect(zeroContent.result.code).toBe(1)
    const zeroContentEvents = readJsonl(path.join(zeroContent.runDir, 'events.jsonl'))
    expect(zeroContentEvents).toHaveLength(6)
    expect(zeroContentEvents.every((record) => (
      record.status === 'failed' &&
      record.errorCode === 'empty_visible_content' &&
      record.partialRaw === '' &&
      record.partialBody === '' &&
      record.finishReason === 'stop' &&
      record.terminalEvidence === 'final_usage' &&
      record.providerDiagnostics?.reasoningFields?.join(',') ===
        'reasoning_content,thinking' &&
      record.providerDiagnostics?.reasoningChunks === 2 &&
      record.providerDiagnostics?.reasoningCharacters === 67 &&
      !JSON.stringify(record).includes('MUST_NOT_PERSIST')
    ))).toBe(true)
    expect(readJson(path.join(zeroContent.runDir, 'run-manifest.json')).resultCounts)
      .toMatchObject({ total: 3, complete: 0, failed: 3 })
  })

  it('does not infer clean-EOF completion from stale or invalid usage evidence', async () => {
    const server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      const payload = JSON.parse(body)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (payload.messages[0].content === 'DIRECT') {
        response.end([
          `data: ${JSON.stringify({ choices: [{
            delta: { content: 'DELTA_BEFORE_USAGE' },
            finish_reason: null,
          }] })}`,
          `data: ${JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          })}`,
          `data: ${JSON.stringify({ choices: [{
            delta: { content: '_DELTA_AFTER_USAGE\n---\nSTALE_NOTE' },
            finish_reason: null,
          }] })}`,
        ].join('\n'))
        return
      }
      response.end([
        `data: ${JSON.stringify({ choices: [{
          delta: { content: 'DELTA_WITH_INVALID_USAGE\n---\nINVALID_NOTE' },
          finish_reason: null,
        }] })}`,
        `data: ${JSON.stringify({
          choices: [],
          usage: { prompt_tokens: '10', completion_tokens: -1, total_tokens: 9 },
        })}`,
      ].join('\n'))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture port.')
    const fixture = await createFrozenFixture(`http://127.0.0.1:${address.port}`)
    const runDir = path.join(
      fixture.repository,
      'FSBP_Test',
      'private',
      'round-0820',
      'runs',
      'stale-usage-fixture',
    )
    const result = await runNode(RUN, [
      `--repo-root=${fixture.repository}`,
      `--freeze=${fixture.freezePath}`,
      `--output=${runDir}`,
      '--run-id=stale-usage-fixture',
      '--allow-nonformal',
    ], {
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV ?? 'test',
        ROUND_0820_TEST_KEY: 'fixture-only',
      },
    })

    expect(result.code).toBe(1)
    const events = readJsonl(path.join(runDir, 'events.jsonl'))
    expect(events).toHaveLength(6)
    const stale = events.find((record) => record.phase === 'direct')
    expect(stale).toMatchObject({
      status: 'failed',
      errorCode: 'upstream_stream_interrupted',
      partialRaw: 'DELTA_BEFORE_USAGE_DELTA_AFTER_USAGE\n---\nSTALE_NOTE',
      terminalEvidence: null,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })
    const invalid = events.find((record) => record.phase === 'analysis')
    expect(invalid).toMatchObject({
      status: 'failed',
      errorCode: 'upstream_stream_interrupted',
      partialRaw: 'DELTA_WITH_INVALID_USAGE\n---\nINVALID_NOTE',
      terminalEvidence: null,
      usage: null,
    })
    expect(readJson(path.join(runDir, 'run-manifest.json')).usageStatistics)
      .toMatchObject({
        attemptsWithUsage: 2,
        failedAttemptsWithUsage: 2,
        promptTokens: 20,
        completionTokens: 10,
        totalTokens: 30,
      })
  })

  it('preserves partial SSE text when the shared deadline aborts a live stream', async () => {
    let requests = 0
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume request body */ }
      requests += 1
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({
        choices: [{
          delta: { content: 'PARTIAL_TIMEOUT\n---\nTIMEOUT_NOTE' },
          finish_reason: null,
        }],
      })}\n\n`)
      // Keep the response open. The runner's shared deadline must abort it.
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture port.')
    const fixture = await createFrozenFixture(
      `http://127.0.0.1:${address.port}`,
      2,
    )
    const runDir = path.join(
      fixture.repository,
      'FSBP_Test',
      'private',
      'round-0820',
      'runs',
      'timeout-partial-fixture',
    )
    const result = await runNode(RUN, [
      `--repo-root=${fixture.repository}`,
      `--freeze=${fixture.freezePath}`,
      `--output=${runDir}`,
      '--run-id=timeout-partial-fixture',
      '--allow-nonformal',
    ], {
      testModelCallTimeoutMs: 1_000,
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV ?? 'test',
        ROUND_0820_TEST_KEY: 'fixture-only',
      },
    })

    expect(result.code).toBe(1)
    // Direct and both shared-candidate analyses run concurrently and each
    // consumes its logical-call deadline; retries do not reset that budget.
    expect(requests).toBe(6)
    const events = readJsonl(path.join(runDir, 'events.jsonl'))
    expect(events).toHaveLength(6)
    expect(events.every((record) => (
      record.errorCode === 'upstream_timeout' &&
      record.errorOrigin === 'upstream' &&
      record.retryScheduled === false &&
      record.partialRaw === 'PARTIAL_TIMEOUT\n---\nTIMEOUT_NOTE' &&
      record.partialBody === 'PARTIAL_TIMEOUT' &&
      record.partialAnnotation === 'TIMEOUT_NOTE'
    ))).toBe(true)
    expect(readJsonl(path.join(runDir, 'final.jsonl')).every((record) => (
      record.status === 'failed' &&
      record.errorCode === 'upstream_timeout' &&
      record.partialBody === 'PARTIAL_TIMEOUT'
    ))).toBe(true)
  })

  it('rejects non-success finish reasons and retains the returned partial body', async () => {
    let requests = 0
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume request body */ }
      requests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        choices: [{
          finish_reason: 'content_filter',
          message: { content: 'FILTERED_PARTIAL\n---\nFILTER_NOTE' },
        }],
      }))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture port.')
    const fixture = await createFrozenFixture(`http://127.0.0.1:${address.port}`)
    const runDir = path.join(
      fixture.repository,
      'FSBP_Test',
      'private',
      'round-0820',
      'runs',
      'finish-reason-fixture',
    )
    const result = await runNode(RUN, [
      `--repo-root=${fixture.repository}`,
      `--freeze=${fixture.freezePath}`,
      `--output=${runDir}`,
      '--run-id=finish-reason-fixture',
      '--allow-nonformal',
    ], {
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV ?? 'test',
        ROUND_0820_TEST_KEY: 'fixture-only',
      },
    })

    expect(result.code).toBe(1)
    expect(requests).toBe(3)
    const events = readJsonl(path.join(runDir, 'events.jsonl'))
    expect(events).toHaveLength(3)
    expect(events.every((record) => (
      record.errorCode === 'upstream_incomplete_finish_reason' &&
      record.fallbackAttempt === null &&
      record.finishReason === 'content_filter' &&
      record.partialBody === 'FILTERED_PARTIAL' &&
      record.partialAnnotation === 'FILTER_NOTE'
    ))).toBe(true)
  })

  it('honors Retry-After within the shared deadline before retrying upstream errors', async () => {
    const rotatedKey = 'opaqueRound0820RotatedCredentialValue'
    const requestTimes: Array<{
      at: number
      prompt: string
      authorization: string
    }> = []
    const requestBodies: string[] = []
    let rotatingKeyFile = ''
    let callNumber = 0
    let directRetryInjected = false
    const server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      const payload = JSON.parse(body)
      requestBodies.push(body)
      const authorization = String(request.headers.authorization ?? '')
      const echoedCredential = authorization.replace(/^Bearer\s+/i, '')
      requestTimes.push({
        at: performance.now(),
        prompt: payload.messages[0].content,
        authorization,
      })
      callNumber += 1
      if (!directRetryInjected && payload.messages[0].content === 'DIRECT') {
        directRetryInjected = true
        writeFileSync(rotatingKeyFile, `${rotatedKey}\n`, 'utf8')
        response.writeHead(503, {
          'content-type': 'application/json',
          'retry-after': '1',
        })
        response.end(JSON.stringify({
          error: {
            message: `temporary upstream failure; Authorization: Bearer ${SYNTHETIC_RUNNER_KEY}; token=${SYNTHETIC_RUNNER_KEY}`,
          },
        }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        choices: [{
          finish_reason: 'stop',
          message: {
            content: `BODY_${callNumber} ${echoedCredential}\n---\nNOTE_${callNumber} ${echoedCredential}`,
          },
        }],
      }))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture port.')
    const fixture = await createFrozenFixture(`http://127.0.0.1:${address.port}`, 1)
    rotatingKeyFile = path.join(path.dirname(fixture.freezePath), 'synthetic-credential.txt')
    const runDir = path.join(
      fixture.repository,
      'FSBP_Test',
      'private',
      'round-0820',
      'runs',
      'retry-after-fixture',
    )
    const result = await runNode(RUN, [
      `--repo-root=${fixture.repository}`,
      `--freeze=${fixture.freezePath}`,
      `--output=${runDir}`,
      '--run-id=retry-after-fixture',
      '--allow-nonformal',
    ], {
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV ?? 'test',
        ROUND_0820_TEST_KEY: 'fixture-only',
      },
    })

    expect(result.code, result.stderr).toBe(0)
    expect(requestTimes).toHaveLength(15)
    const directRequests = requestTimes.filter((entry) => entry.prompt === 'DIRECT')
    expect(directRequests).toHaveLength(2)
    const [firstRequest, retryRequest] = directRequests
    expect(retryRequest.at - firstRequest.at).toBeGreaterThanOrEqual(900)
    expect(firstRequest.authorization).toBe(`Bearer ${SYNTHETIC_RUNNER_KEY}`)
    expect(retryRequest.authorization).toBe(`Bearer ${rotatedKey}`)
    expect(requestBodies.every((body) => (
      !body.includes(SYNTHETIC_RUNNER_KEY) && !body.includes(rotatedKey)
    ))).toBe(true)
    const events = readJsonl(path.join(runDir, 'events.jsonl'))
    const scheduledDirectRetry = events.find((record) => (
      record.phase === 'direct' &&
      record.attempt === 1 &&
      record.status === 'failed' &&
      record.retryScheduled === true
    ))
    expect(scheduledDirectRetry).toMatchObject({
      errorCode: 'provider_failure',
      errorOrigin: 'upstream',
      retryScheduled: true,
      retryDelayMs: 1_000,
    })
    expect(events.filter((record) => record.retryScheduled === true)).toHaveLength(1)
    for (const artifact of [
      'events.jsonl',
      'candidate-cache.jsonl',
      'outcomes.jsonl',
      'final.jsonl',
    ]) {
      const text = readFileSync(path.join(runDir, artifact), 'utf8')
      expect(text).not.toContain(SYNTHETIC_RUNNER_KEY)
      expect(text).not.toContain(rotatedKey)
      expect(text).not.toMatch(/Bearer\s+sk-/i)
    }
    expect(readFileSync(path.join(runDir, 'events.jsonl'), 'utf8'))
      .toContain('[REDACTED_CREDENTIAL]')
    expect(result.stderr).not.toContain(SYNTHETIC_RUNNER_KEY)
  })

  it('rejects nonterminal or tampered run artifacts before creating blind packets', async () => {
    const dir = tempDir()
    const privateRoot = path.join(dir, 'FSBP_Test', 'private', 'round-0820')
    const runDir = path.join(privateRoot, 'run')
    writeJsonl(path.join(runDir, 'final.jsonl'), [])
    writeTerminalRunManifest(runDir, {
      runId: 'integrity-fixture',
      freezeManifestSha256: 'a'.repeat(64),
    })
    const manifestPath = path.join(runDir, 'run-manifest.json')
    writeJson(manifestPath, { ...readJson(manifestPath), status: 'running' })
    const nonterminal = await runNode(PREPARE, [
      `--run-dir=${runDir}`,
      `--output=${path.join(privateRoot, 'blind-nonterminal')}`,
      `--sealed-output=${path.join(privateRoot, 'sealed-nonterminal')}`,
      `--private-root=${privateRoot}`,
    ])
    expect(nonterminal.code).toBe(1)
    expect(nonterminal.stderr).toContain('Run status running is not terminal')

    writeJson(manifestPath, { ...readJson(manifestPath), status: 'complete' })
    writeFileSync(path.join(runDir, 'events.jsonl'), '{}\n', 'utf8')
    const tampered = await runNode(PREPARE, [
      `--run-dir=${runDir}`,
      `--output=${path.join(privateRoot, 'blind-tampered')}`,
      `--sealed-output=${path.join(privateRoot, 'sealed-tampered')}`,
      `--private-root=${privateRoot}`,
    ])
    expect(tampered.code).toBe(1)
    expect(tampered.stderr).toContain('events artifact hash mismatch')
    expect(existsSync(path.join(privateRoot, 'blind-tampered', 'blind-manifest.json')))
      .toBe(false)
  })

  it('rejects a run artifact descriptor that resolves to a directory', async () => {
    const dir = tempDir()
    const privateRoot = path.join(dir, 'FSBP_Test', 'private', 'round-0820')
    const runDir = path.join(privateRoot, 'run')
    writeJsonl(path.join(runDir, 'final.jsonl'), [])
    writeTerminalRunManifest(runDir, {
      runId: 'directory-artifact-fixture',
      freezeManifestSha256: 'a'.repeat(64),
    })
    const finalDirectory = path.join(runDir, 'final-directory')
    mkdirSync(finalDirectory)
    const manifestPath = path.join(runDir, 'run-manifest.json')
    const manifest = readJson(manifestPath)
    manifest.artifacts.final = {
      path: 'final-directory',
      sha256: 'b'.repeat(64),
      recordCount: 0,
    }
    writeJson(manifestPath, manifest)
    const result = await runNode(PREPARE, [
      `--run-dir=${runDir}`,
      `--output=${path.join(privateRoot, 'blind-directory-artifact')}`,
      `--sealed-output=${path.join(privateRoot, 'sealed-directory-artifact')}`,
      `--private-root=${privateRoot}`,
    ])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('final artifact must be an existing regular file.')
  })

  it('rejects a matching run artifact reached through a symlink outside the run', async ({ skip }) => {
    const dir = tempDir()
    const privateRoot = path.join(dir, 'FSBP_Test', 'private', 'round-0820')
    const runDir = path.join(privateRoot, 'run')
    const finalPath = path.join(runDir, 'final.jsonl')
    writeJsonl(finalPath, [])
    writeTerminalRunManifest(runDir, {
      runId: 'artifact-symlink-fixture',
      freezeManifestSha256: 'a'.repeat(64),
    })
    const outsideFinal = path.join(dir, 'outside-final.jsonl')
    writeFileSync(outsideFinal, readFileSync(finalPath))
    rmSync(finalPath)
    try {
      symlinkSync(outsideFinal, finalPath, 'file')
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : ''
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(code)) {
        skip()
        return
      }
      throw error
    }
    const result = await runNode(PREPARE, [
      `--run-dir=${runDir}`,
      `--output=${path.join(privateRoot, 'blind-artifact-symlink')}`,
      `--sealed-output=${path.join(privateRoot, 'sealed-artifact-symlink')}`,
      `--private-root=${privateRoot}`,
    ])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('final artifact must stay inside')
  })

  it('gates explicit baseline pairs and keeps versioned baseline audit data out of reviewer packages', async () => {
    const dir = tempDir()
    const privateRoot = path.join(dir, 'FSBP_Test', 'private', 'round-0820')
    const runDir = path.join(privateRoot, 'run')
    const samples = [
      {
        id: 'qgate-08',
        sourceText: 'Frozen source v2, sample eight.',
        runTaskBrief: 'Official run instruction for sample eight.',
        baselineTaskBrief: 'PRIVATE_BASELINE_REQUIREMENT_EIGHT',
      },
      {
        id: 'qgate-09',
        sourceText: 'Frozen source v2, sample nine.',
        runTaskBrief: 'Official run instruction for sample nine.',
        baselineTaskBrief: 'PRIVATE_BASELINE_REQUIREMENT_NINE',
      },
    ]
    writeJsonl(path.join(runDir, 'final.jsonl'), samples.map((sample) => ({
      roundId: 'round-0820',
      namespace: 'fsbp',
      runId: 'versioned-baseline-fixture',
      outcomeId: `${sample.id}-fsbp`,
      outcomeKey: `quality:${sample.id}:multi_fsbp`,
      datasetName: 'quality',
      experiment: 'translation_quality',
      sampleId: sample.id,
      condition: 'multi_fsbp',
      direction: 'en_to_zh',
      category: 'literary',
      sourceText: sample.sourceText,
      taskBrief: sample.runTaskBrief,
      status: 'complete',
      model: 'HIDDEN_AGENTIC_IDENTITY',
      text: `Second anonymous translation for ${sample.id}.`,
      raw: `Second anonymous translation for ${sample.id}.`,
    })))
    writeTerminalRunManifest(runDir, {
      runId: 'versioned-baseline-fixture',
      freezeManifestSha256: 'a'.repeat(64),
    })
    const baselineInput = path.join(privateRoot, 'gpt-baseline-input-v2.jsonl')
    const baselineOutput = path.join(privateRoot, 'gpt-baseline-output-v2.jsonl')
    writeJsonl(baselineInput, samples.map((sample) => ({
      id: sample.id,
      direction: 'en_to_zh',
      taskBrief: sample.baselineTaskBrief,
      sourceText: sample.sourceText,
    })))
    writeJsonl(baselineOutput, samples.map((sample) => ({
      id: sample.id,
      direction: 'en_to_zh',
      translation: `First anonymous translation for ${sample.id}.`,
    })))
    const commonArgs = [
      `--run-dir=${runDir}`,
      `--private-root=${privateRoot}`,
      '--allow-nonformal',
    ]

    for (const loneArgument of [
      `--baseline-input=${baselineInput}`,
      `--baseline-output=${baselineOutput}`,
    ]) {
      const result = await runNode(PREPARE, [
        ...commonArgs,
        `--output=${path.join(privateRoot, `blind-lone-${path.basename(loneArgument)}`)}`,
        `--sealed-output=${path.join(privateRoot, `sealed-lone-${path.basename(loneArgument)}`)}`,
        loneArgument,
      ])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain(
        '--baseline-input and --baseline-output must be provided together.',
      )
    }
    const sameFile = await runNode(PREPARE, [
      ...commonArgs,
      `--output=${path.join(privateRoot, 'blind-same')}`,
      `--sealed-output=${path.join(privateRoot, 'sealed-same')}`,
      `--baseline-input=${baselineInput}`,
      `--baseline-output=${baselineInput}`,
    ])
    expect(sameFile.code).toBe(1)
    expect(sameFile.stderr).toContain('Baseline input and output must be different files.')

    const missing = await runNode(PREPARE, [
      ...commonArgs,
      `--output=${path.join(privateRoot, 'blind-missing')}`,
      `--sealed-output=${path.join(privateRoot, 'sealed-missing')}`,
      `--baseline-input=${path.join(privateRoot, 'missing-input.jsonl')}`,
      `--baseline-output=${path.join(privateRoot, 'missing-output.jsonl')}`,
    ])
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain('Selected baseline file does not exist or is not readable')

    const wrongExtensionInput = path.join(privateRoot, 'baseline-input.json')
    const wrongExtensionOutput = path.join(privateRoot, 'baseline-output.json')
    writeJsonl(wrongExtensionInput, readJsonl(baselineInput))
    writeJsonl(wrongExtensionOutput, readJsonl(baselineOutput))
    const wrongExtension = await runNode(PREPARE, [
      ...commonArgs,
      `--output=${path.join(privateRoot, 'blind-extension')}`,
      `--sealed-output=${path.join(privateRoot, 'sealed-extension')}`,
      `--baseline-input=${wrongExtensionInput}`,
      `--baseline-output=${wrongExtensionOutput}`,
    ])
    expect(wrongExtension.code).toBe(1)
    expect(wrongExtension.stderr).toContain('Baseline input must be a .jsonl file.')

    const outsideInput = path.join(dir, 'outside-input.jsonl')
    const outsideOutput = path.join(dir, 'outside-output.jsonl')
    writeJsonl(outsideInput, readJsonl(baselineInput))
    writeJsonl(outsideOutput, readJsonl(baselineOutput))
    const outside = await runNode(PREPARE, [
      ...commonArgs,
      `--output=${path.join(privateRoot, 'blind-outside')}`,
      `--sealed-output=${path.join(privateRoot, 'sealed-outside')}`,
      `--baseline-input=${outsideInput}`,
      `--baseline-output=${outsideOutput}`,
    ])
    expect(outside.code).toBe(1)
    expect(outside.stderr).toContain('baseline input must stay inside')

    const blindDir = path.join(privateRoot, 'blind-v2')
    const sealedDir = path.join(privateRoot, 'sealed-v2')
    const prepared = await runNode(PREPARE, [
      ...commonArgs,
      `--output=${blindDir}`,
      `--sealed-output=${sealedDir}`,
      `--baseline-input=${baselineInput}`,
      `--baseline-output=${baselineOutput}`,
    ])
    expect(prepared.code, prepared.stderr).toBe(0)
    const expectedAudit = {
      input: {
        path: 'gpt-baseline-input-v2.jsonl',
        sha256: sha256File(baselineInput),
      },
      output: {
        path: 'gpt-baseline-output-v2.jsonl',
        sha256: sha256File(baselineOutput),
      },
    }
    expect(readJson(path.join(blindDir, 'blind-manifest.json')).externalBaselineAudit)
      .toEqual(expectedAudit)
    expect(readJson(path.join(sealedDir, 'blind-key.json')).externalBaseline.selectedFiles)
      .toEqual(expectedAudit)
    const qualityPacket = readJson(path.join(blindDir, 'quality-packet.json'))
    expect(qualityPacket.items.map((item: any) => item.sourceText).sort())
      .toEqual(samples.map((sample) => sample.sourceText).sort())
    expect(qualityPacket.items.map((item: any) => item.taskBrief).sort())
      .toEqual(samples.map((sample) => sample.runTaskBrief).sort())
    const sealedBaselineAudit = readJson(path.join(sealedDir, 'blind-key.json'))
      .externalBaseline.perSampleHashes
    for (const sample of samples) {
      expect(sealedBaselineAudit[sample.id]).toMatchObject({
        baselineTaskBriefHash: createHash('sha256')
          .update(sample.baselineTaskBrief).digest('hex'),
        runTaskBriefHash: createHash('sha256')
          .update(sample.runTaskBrief).digest('hex'),
        taskBriefMatches: false,
      })
    }
    const distributedText = ['A', 'B', 'C'].flatMap((packageCode) => {
      const packageDir = path.join(blindDir, `04-human-review-${packageCode}`)
      return readdirSync(packageDir).map((file) => readFileSync(path.join(packageDir, file), 'utf8'))
    }).join('\n')
    expect(distributedText).not.toContain('gpt-baseline-input-v2.jsonl')
    expect(distributedText).not.toContain('gpt-baseline-output-v2.jsonl')
    expect(distributedText).not.toContain(privateRoot)
    expect(distributedText).toContain(samples[0].runTaskBrief)
    expect(distributedText).toContain(samples[1].runTaskBrief)
    expect(distributedText).not.toContain(samples[0].baselineTaskBrief)
    expect(distributedText).not.toContain(samples[1].baselineTaskBrief)
    expect(distributedText).not.toMatch(/GPT|HIDDEN_AGENTIC_IDENTITY|multi_fsbp/i)

    const driftedInput = path.join(privateRoot, 'drifted-input.jsonl')
    const driftedOutput = path.join(privateRoot, 'drifted-output.jsonl')
    writeJsonl(driftedInput, samples.map((sample, index) => ({
      id: sample.id,
      direction: 'en_to_zh',
      taskBrief: sample.baselineTaskBrief,
      sourceText: index === 1
        ? `${sample.sourceText}\nPRIVATE_SUFFIX_OUTSIDE_FROZEN_SOURCE`
        : sample.sourceText,
    })))
    writeJsonl(driftedOutput, readJsonl(baselineOutput))
    const mismatch = await runNode(PREPARE, [
      ...commonArgs,
      `--output=${path.join(privateRoot, 'blind-drifted')}`,
      `--sealed-output=${path.join(privateRoot, 'sealed-drifted')}`,
      `--baseline-input=${driftedInput}`,
      `--baseline-output=${driftedOutput}`,
    ])
    expect(mismatch.code).toBe(1)
    expect(mismatch.stderr).toContain('drifted-output.jsonl:2')
    expect(mismatch.stderr).toContain(
      'Agentic source text differs from the frozen baseline input.',
    )
  })

  it('resolves existing path aliases before enforcing private-root and overlap boundaries', async ({ skip }) => {
    const dir = tempDir()
    const privateRoot = path.join(dir, 'FSBP_Test', 'private', 'round-0820')
    const runDir = path.join(privateRoot, 'run')
    const outsideDir = path.join(dir, 'outside-target')
    mkdirSync(runDir, { recursive: true })
    mkdirSync(outsideDir, { recursive: true })
    writeJson(path.join(runDir, 'run-manifest.json'), {
      schemaVersion: '1.0.0',
      roundId: 'round-0820',
      namespace: 'fsbp',
      runId: 'path-alias-fixture',
    })
    const runAlias = path.join(privateRoot, 'run-alias')
    const outsideAlias = path.join(privateRoot, 'outside-alias')
    try {
      const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir'
      symlinkSync(runDir, runAlias, directoryLinkType)
      symlinkSync(outsideDir, outsideAlias, directoryLinkType)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : ''
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(code)) {
        skip()
        return
      }
      throw error
    }
    const commonArgs = [
      `--run-dir=${runDir}`,
      `--private-root=${privateRoot}`,
    ]
    const aliasedOverlap = await runNode(PREPARE, [
      ...commonArgs,
      `--output=${runAlias}`,
      `--sealed-output=${path.join(privateRoot, 'sealed-overlap')}`,
    ])
    expect(aliasedOverlap.code).toBe(1)
    expect(aliasedOverlap.stderr).toContain(
      'Blind output must be separate from the run directory.',
    )

    const aliasedEscape = await runNode(PREPARE, [
      ...commonArgs,
      `--output=${path.join(outsideAlias, 'not-created-yet')}`,
      `--sealed-output=${path.join(privateRoot, 'sealed-escape')}`,
    ])
    expect(aliasedEscape.code).toBe(1)
    expect(aliasedEscape.stderr).toContain('blind output must stay inside')
  })

  it('refuses to create a human-review package without a complete external-baseline/Agentic pair', async () => {
    const dir = tempDir()
    const privateRoot = path.join(dir, 'FSBP_Test', 'private', 'round-0820')
    const runDir = path.join(privateRoot, 'run')
    const blindDir = path.join(privateRoot, 'blind')
    writeJsonl(path.join(runDir, 'final.jsonl'), [{
      roundId: 'round-0820',
      namespace: 'fsbp',
      runId: 'source-only-fixture',
      outcomeKey: 'quality:q:direct',
      datasetName: 'quality',
      experiment: 'translation_quality',
      sampleId: 'q',
      condition: 'direct',
      direction: 'en_to_zh',
      category: 'literary',
      sourceText: 'Source without an Agentic result.',
      taskBrief: 'Translate.',
      status: 'complete',
      text: 'Direct only.',
    }])
    writeTerminalRunManifest(runDir, {
      runId: 'source-only-fixture',
      freezeManifestSha256: 'a'.repeat(64),
    })
    writeExternalBaseline(privateRoot, [{
      id: 'q',
      direction: 'en_to_zh',
      sourceText: 'Source without an Agentic result.',
      taskBrief: 'Translate.',
      translation: 'External baseline.',
    }])
    const result = await runNode(PREPARE, [
      `--run-dir=${runDir}`,
      `--output=${blindDir}`,
      `--sealed-output=${path.join(privateRoot, 'sealed')}`,
      `--private-root=${privateRoot}`,
      '--allow-nonformal',
    ])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Agentic quality results must contain exactly 1 unique multi_fsbp records')
    expect(existsSync(path.join(blindDir, 'blind-manifest.json'))).toBe(false)
  })

  it('retains failures, blocks early decode, validates frozen human files, and analyzes deterministically', async () => {
    const dir = tempDir()
    const privateRoot = path.join(dir, 'FSBP_Test', 'private', 'round-0820')
    const runDir = path.join(privateRoot, 'run')
    const blindDir = path.join(privateRoot, 'blind')
    const sealedDir = path.join(privateRoot, 'sealed')
    const humanDir = path.join(privateRoot, 'human')
    mkdirSync(runDir, { recursive: true })
    const hash = 'a'.repeat(64)
    writeJsonl(path.join(runDir, 'events.jsonl'), [
      { status: 'complete', condition: 'direct', attempt: 1, latencyMs: 10, boundaryFound: false, boundaryCount: 0, body: 'ok', usage: { prompt_tokens: 3, completion_tokens: 2 } },
      { status: 'failed', condition: 'multi_raw', attempt: 1, errorCode: 'provider_failure' },
      { status: 'cancelled', condition: 'multi_raw', attempt: 2, errorCode: 'cancelled' },
    ])
    const paired = {
      candidateSetHash: 'b'.repeat(64),
      candidateSnapshotHash: 'b'.repeat(64),
      pairId: 'c'.repeat(64),
      comparisonControlHash: 'd'.repeat(64),
      allowedDifference: 'downstream_inherited_view_only',
    }
    const common = {
      roundId: 'round-0820',
      namespace: 'fsbp',
      runId: 'prepared-fixture',
      direction: 'en_to_zh',
      category: 'literary',
      sourceText: 'Source.',
      taskBrief: 'Translate.',
      status: 'complete',
    }
    writeJsonl(path.join(runDir, 'final.jsonl'), [
      { ...common, outcomeId: 'q-direct', outcomeKey: 'quality:q:direct', datasetName: 'quality', experiment: 'translation_quality', sampleId: 'q', condition: 'direct', model: 'HIDDEN_DIRECT_MODEL', text: 'Direct', raw: 'Direct' },
      { ...common, ...paired, outcomeId: 'q-raw', outcomeKey: 'quality:q:multi_raw', datasetName: 'quality', experiment: 'translation_quality', sampleId: 'q', condition: 'multi_raw', inheritedView: 'raw', model: 'HIDDEN_EDITOR_MODEL', text: 'Raw final', raw: 'Raw final' },
      { ...common, ...paired, outcomeId: 'q-fsbp', outcomeKey: 'quality:q:multi_fsbp', datasetName: 'quality', experiment: 'translation_quality', sampleId: 'q', condition: 'multi_fsbp', inheritedView: 'body', model: 'HIDDEN_EDITOR_MODEL', text: 'FSBP final', raw: 'FSBP final' },
      { ...common, ...paired, outcomeId: 'i-raw', outcomeKey: 'annotationStress:i:multi_raw', datasetName: 'annotationStress', experiment: 'annotation_isolation', sampleId: 'i', condition: 'multi_raw', inheritedView: 'raw', text: 'Raw isolation', raw: 'Raw isolation', targetedError: 'Specific error', errorEvidence: 'Source evidence', annotationInfluence: 'HIDDEN_ANNOTATION' },
      { ...common, ...paired, outcomeId: 'i-fsbp', outcomeKey: 'annotationStress:i:multi_fsbp', datasetName: 'annotationStress', experiment: 'annotation_isolation', sampleId: 'i', condition: 'multi_fsbp', inheritedView: 'body', text: 'FSBP isolation', raw: 'FSBP isolation', targetedError: 'Specific error', errorEvidence: 'Source evidence', annotationInfluence: 'HIDDEN_ANNOTATION' },
      { ...common, outcomeId: 'f-direct', outcomeKey: 'quality:failed:direct', datasetName: 'quality', experiment: 'translation_quality', sampleId: 'failed', condition: 'direct', status: 'failed', errorCode: 'PRECHECK_FAILED', error: 'budget', sourceText: 'Failed source.' },
    ])
    writeTerminalRunManifest(runDir, {
      runId: 'prepared-fixture',
      freezeManifestSha256: hash,
    })
    writeExternalBaseline(privateRoot, [{
      id: 'q',
      direction: 'en_to_zh',
      sourceText: 'Source.',
      taskBrief: 'Translate.',
      translation: 'Independent baseline.',
    }])

    const prepared = await runNode(PREPARE, [
      `--run-dir=${runDir}`,
      `--output=${blindDir}`,
      `--sealed-output=${sealedDir}`,
      `--private-root=${privateRoot}`,
      '--allow-nonformal',
    ])
    expect(prepared.code, prepared.stderr).toBe(0)
    const qualityPacketText = readFileSync(path.join(blindDir, 'quality-packet.json'), 'utf8')
    const isolationPacketText = readFileSync(path.join(blindDir, 'isolation-packet.json'), 'utf8')
    expect(qualityPacketText).not.toContain('multi_raw')
    expect(qualityPacketText).not.toContain('multi_fsbp')
    expect(qualityPacketText).not.toContain('HIDDEN_DIRECT_MODEL')
    expect(qualityPacketText).not.toContain('Raw final')
    expect(isolationPacketText).not.toContain('HIDDEN_ANNOTATION')
    expect(readJson(path.join(blindDir, 'quality-packet.json')).counts)
      .toEqual({ eligible: 1, systemFailures: 1, total: 2 })
    const qualityPacket = readJson(path.join(blindDir, 'quality-packet.json'))
    expect(qualityPacket.rubric).toMatchObject({
      scoreRange: [1, 10],
      weightedTotalRange: [10, 100],
      weightedTotalFormula: '10 * sum(score_i * weight_i) / sum(applicable_weight_i)',
    })
    const validateBlindPacket = new Ajv2020({ strict: false }).compile(readJson(path.join(
      ROOT, 'FSBP_Test', 'schemas', 'round-0820-blind-packet.schema.json',
    )))
    expect(validateBlindPacket(qualityPacket), JSON.stringify(validateBlindPacket.errors)).toBe(true)
    expect(validateBlindPacket({
      ...qualityPacket,
      rubric: { ...qualityPacket.rubric, weightedTotalRange: [0, 100] },
    })).toBe(false)
    const blindKey = readJson(path.join(sealedDir, 'blind-key.json'))
    expect(existsSync(path.join(blindDir, 'blind-key.json'))).toBe(false)
    expect(qualityPacket).not.toHaveProperty('randomizationSecret')
    expect(blindKey.randomizationSecret).toMatch(/^[a-f0-9]{64}$/)
    expect(createHash('sha256').update(blindKey.randomizationSecret).digest('hex'))
      .toBe(qualityPacket.randomizationSeedSha256)
    expect(qualityPacket.externalBaseline).toMatchObject({ recordCount: 1 })
    expect(qualityPacket.externalBaseline.inputFileSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(qualityPacket.externalBaseline.outputFileSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(blindKey.externalBaseline.perSampleHashes.q).toEqual({
      sourceSha256: createHash('sha256').update('Source.').digest('hex'),
      translationSha256: createHash('sha256').update('Independent baseline.').digest('hex'),
      baselineTaskBriefHash: createHash('sha256').update('Translate.').digest('hex'),
      runTaskBriefHash: createHash('sha256').update('Translate.').digest('hex'),
      taskBriefMatches: true,
    })
    expect(blindKey.packets.quality.systemFailures)
      .toEqual([expect.objectContaining({
        sampleId: 'failed',
        missingConditions: ['external_gpt_baseline', 'multi_fsbp'],
        failedConditions: [],
      })])
    expect(existsSync(path.join(blindDir, 'quality-ai-template.jsonl'))).toBe(true)
    expect(existsSync(path.join(blindDir, 'isolation-ai-template.jsonl'))).toBe(true)
    expect(qualityPacket.items[0].candidates).toHaveLength(2)
    const distributedContents: string[] = []
    for (const packageCode of ['A', 'B', 'C']) {
      const reviewerId = `reviewer-${packageCode}`
      const packageDir = path.join(blindDir, `04-human-review-${packageCode}`)
      expect(readdirSync(packageDir).sort()).toEqual([
        '00-从这里开始.md',
        '01-原文与匿名译文.md',
        '02-质量评分表.csv',
        '03-回传凭证.json',
        '04-交回文件说明.md',
        '05-翻译质量评分标准.md',
      ])
      expect(readFileSync(path.join(packageDir, '00-从这里开始.md'), 'utf8'))
        .toContain('比较每条原文下的译文 A、译文 B')
      expect(readFileSync(path.join(packageDir, '01-原文与匿名译文.md'), 'utf8'))
        .not.toContain('HIDDEN_')
      expect(readFileSync(path.join(packageDir, '05-翻译质量评分标准.md'), 'utf8'))
        .toContain('10 × Σ(维度分 × 权重) ÷ Σ(适用维度权重)')
      const scoreSheet = readFileSync(path.join(packageDir, '02-质量评分表.csv'), 'utf8')
      expect(scoreSheet).not.toContain(reviewerId)
      expect(scoreSheet).not.toContain('packetHash')
      expect(scoreSheet).not.toContain('packetId')
      expect(scoreSheet).not.toContain('reviewerId')
      const packageManifest = readJson(path.join(
        blindDir,
        'reviewer-package-manifests',
        `${reviewerId}.json`,
      ))
      const credential = readJson(path.join(packageDir, '03-回传凭证.json'))
      expect(packageManifest).toMatchObject({
        reviewerId,
        translationLabels: ['A', 'B'],
      })
      expect(credential).toMatchObject({
        credentialKind: 'human_review_return_credential',
        packetId: qualityPacket.packetId,
        packetHash: qualityPacket.packetHash,
        reviewerPackageId: packageManifest.reviewerPackageId,
        reviewerTokenHash: packageManifest.reviewerTokenHash,
      })
      expect(createHash('sha256').update(credential.reviewerToken).digest('hex'))
        .toBe(credential.reviewerTokenHash)
      distributedContents.push(
        ...readdirSync(packageDir).map((file) => readFileSync(path.join(packageDir, file), 'utf8')),
      )
    }
    const distributedText = distributedContents.join('\n')
    expect(distributedText).not.toMatch(
      /GPT|DeepSeek|Agentic Translating|multi_fsbp|\b(?:condition|model)\s*[:=]|(?:实验条件|候选来源|来源身份|模型)\s*[:=：]|(?:译文|候选)\s*[AB]\s*(?:来自|来源(?:是|为)?|由|使用|采用|对应)/i,
    )
    expect(distributedText).toContain('不包含译文来源、模型或实验条件')
    for (const filename of [
      '01-原文与匿名译文.md',
      '02-质量评分表.csv',
      '05-翻译质量评分标准.md',
    ]) {
      const packageAContent = readFileSync(
        path.join(blindDir, '04-human-review-A', filename),
        'utf8',
      )
      for (const packageCode of ['B', 'C']) {
        expect(readFileSync(
          path.join(blindDir, `04-human-review-${packageCode}`, filename),
          'utf8',
        )).toBe(packageAContent)
      }
    }
    for (const packageCode of ['A', 'B', 'C']) {
      completeGeneratedQualityCsv(path.join(
        blindDir,
        `04-human-review-${packageCode}`,
        '02-质量评分表.csv',
      ))
    }
    const copyReturns = (name: string): string => {
      const returnedRoot = path.join(privateRoot, name)
      for (const packageCode of ['A', 'B', 'C']) {
        const source = path.join(blindDir, `04-human-review-${packageCode}`)
        const target = path.join(returnedRoot, `04-human-review-${packageCode}`)
        mkdirSync(target, { recursive: true })
        for (const file of ['02-质量评分表.csv', '03-回传凭证.json']) {
          copyFileSync(path.join(source, file), path.join(target, file))
        }
      }
      return returnedRoot
    }
    for (const [name, mutate] of [
      ['wrong-packet-return', (returnedRoot: string) => {
        const credentialPath = path.join(
          returnedRoot, '04-human-review-A', '03-回传凭证.json',
        )
        const credential = readJson(credentialPath)
        writeJson(credentialPath, { ...credential, packetId: 'wrong-packet' })
      }],
      ['copied-token-return', (returnedRoot: string) => {
        const a = readJson(path.join(
          returnedRoot, '04-human-review-A', '03-回传凭证.json',
        ))
        const bPath = path.join(
          returnedRoot, '04-human-review-B', '03-回传凭证.json',
        )
        const b = readJson(bPath)
        writeJson(bPath, {
          ...b,
          reviewerToken: a.reviewerToken,
          reviewerTokenHash: a.reviewerTokenHash,
        })
      }],
      ['swapped-directory-return', (returnedRoot: string) => {
        const aPath = path.join(
          returnedRoot, '04-human-review-A', '03-回传凭证.json',
        )
        const bPath = path.join(
          returnedRoot, '04-human-review-B', '03-回传凭证.json',
        )
        const aBytes = readFileSync(aPath)
        const bBytes = readFileSync(bPath)
        writeFileSync(aPath, bBytes)
        writeFileSync(bPath, aBytes)
      }],
    ] as const) {
      const returnedRoot = copyReturns(name)
      mutate(returnedRoot)
      const rejected = await runNode(VALIDATE, [
        `--packet=${path.join(blindDir, 'quality-packet.json')}`,
        `--input-dir=${returnedRoot}`,
        `--output=${path.join(privateRoot, `${name}-human`)}`,
        `--private-root=${privateRoot}`,
        '--allow-nonformal',
      ])
      expect(rejected.code).toBe(1)
      expect(rejected.stderr).toContain(
        'credential does not match this packet, directory, or researcher manifest',
      )
    }

    const legacyReturns = copyReturns('legacy-return')
    for (const packageCode of ['A', 'B', 'C']) {
      rmSync(path.join(
        legacyReturns, `04-human-review-${packageCode}`, '03-回传凭证.json',
      ))
    }
    const legacyDefault = await runNode(VALIDATE, [
      `--packet=${path.join(blindDir, 'quality-packet.json')}`,
      `--input-dir=${legacyReturns}`,
      `--output=${path.join(privateRoot, 'legacy-default-human')}`,
      `--private-root=${privateRoot}`,
      '--allow-nonformal',
    ])
    expect(legacyDefault.code).toBe(1)
    expect(legacyDefault.stderr).toContain('Legacy unbound packages are rejected by default')
    const legacyExplicitDir = path.join(privateRoot, 'legacy-explicit-human')
    const legacyExplicit = await runNode(VALIDATE, [
      `--packet=${path.join(blindDir, 'quality-packet.json')}`,
      `--input-dir=${legacyReturns}`,
      `--output=${legacyExplicitDir}`,
      `--private-root=${privateRoot}`,
      '--allow-nonformal',
      '--allow-legacy-unbound',
    ])
    expect(legacyExplicit.code, legacyExplicit.stderr).toBe(0)
    expect(readJson(path.join(legacyExplicitDir, 'quality-human-validation.json')))
      .toMatchObject({
        bindingStatus: 'legacy_unbound_process_attested',
        packageCredentialVerified: false,
        csvContentBindingStatus: 'process_attested_not_cryptographic',
        machineVerifiedPackageOrigin: false,
        machineVerifiedHumanIdentity: false,
      })
    const singleReviewerValidation = await runNode(VALIDATE, [
      `--packet=${path.join(blindDir, 'quality-packet.json')}`,
      `--input=${path.join(blindDir, '04-human-review-A', '02-质量评分表.csv')}`,
      `--output=${path.join(privateRoot, 'single-reviewer-must-fail')}`,
      `--private-root=${privateRoot}`,
    ])
    expect(singleReviewerValidation.code).toBe(1)
    expect(singleReviewerValidation.stderr).toContain(
      'Formal human validation requires --input-dir with all three returned A/B/C score files.',
    )
    const csvHumanDir = path.join(privateRoot, 'human-csv')
    const csvValidated = await runNode(VALIDATE, [
      `--packet=${path.join(blindDir, 'quality-packet.json')}`,
      `--input-dir=${blindDir}`,
      `--output=${csvHumanDir}`,
      `--private-root=${privateRoot}`,
      '--allow-nonformal',
    ])
    expect(csvValidated.code, csvValidated.stderr).toBe(0)
    expect(readJson(path.join(csvHumanDir, 'quality-human-validation.json')))
      .toMatchObject({
        reviewerCount: 3,
        itemCount: 1,
        recordCount: 3,
        bindingStatus: 'package_credential_verified_process_attested',
        packageCredentialVerified: true,
        csvContentBindingStatus: 'process_attested_not_cryptographic',
        machineVerifiedPackageOrigin: false,
        machineVerifiedHumanIdentity: false,
      })
    const duplicateCsvReturns = copyReturns('duplicate-csv-return')
    const duplicateCsvHumanDir = path.join(privateRoot, 'duplicate-csv-human')
    const duplicateCsvValidation = await runNode(VALIDATE, [
      `--packet=${path.join(blindDir, 'quality-packet.json')}`,
      `--input-dir=${duplicateCsvReturns}`,
      `--output=${duplicateCsvHumanDir}`,
      `--private-root=${privateRoot}`,
      '--allow-nonformal',
    ])
    expect(duplicateCsvValidation.code, duplicateCsvValidation.stderr).toBe(0)
    const duplicateBinding = readJson(path.join(
      duplicateCsvHumanDir, 'quality-human-validation.json',
    ))
    expect(new Set(duplicateBinding.reviewerPackages.map(
      (entry: any) => entry.returnedCsvSha256,
    )).size).toBe(1)
    expect(duplicateBinding).toMatchObject({
      packageCredentialVerified: true,
      machineVerifiedPackageOrigin: false,
      csvContentBindingStatus: 'process_attested_not_cryptographic',
    })

    const swappedCsvReturns = copyReturns('swapped-csv-return')
    const swappedA = path.join(
      swappedCsvReturns, '04-human-review-A', '02-质量评分表.csv',
    )
    const swappedB = path.join(
      swappedCsvReturns, '04-human-review-B', '02-质量评分表.csv',
    )
    writeFileSync(swappedB, readFileSync(swappedB, 'utf8').replace(',7,', ',8,'), 'utf8')
    const originalA = readFileSync(swappedA)
    const originalB = readFileSync(swappedB)
    writeFileSync(swappedA, originalB)
    writeFileSync(swappedB, originalA)
    const swappedCsvHumanDir = path.join(privateRoot, 'swapped-csv-human')
    const swappedCsvValidation = await runNode(VALIDATE, [
      `--packet=${path.join(blindDir, 'quality-packet.json')}`,
      `--input-dir=${swappedCsvReturns}`,
      `--output=${swappedCsvHumanDir}`,
      `--private-root=${privateRoot}`,
      '--allow-nonformal',
    ])
    expect(swappedCsvValidation.code, swappedCsvValidation.stderr).toBe(0)
    expect(readJson(path.join(swappedCsvHumanDir, 'quality-human-validation.json')))
      .toMatchObject({
        packageCredentialVerified: true,
        machineVerifiedPackageOrigin: false,
        csvContentBindingStatus: 'process_attested_not_cryptographic',
      })

    const keyPath = path.join(sealedDir, 'blind-key.json')
    const hiddenKeyPath = path.join(sealedDir, 'blind-key.not-readable-yet')
    renameSync(keyPath, hiddenKeyPath)
    const partialAnalysis = await runNode(ANALYZE, [
      `--run-dir=${runDir}`,
      `--blind-dir=${blindDir}`,
      `--human-dir=${csvHumanDir}`,
      `--sealed-dir=${sealedDir}`,
      `--output=${path.join(privateRoot, 'reports', 'partial-must-fail.json')}`,
      `--private-root=${privateRoot}`,
      '--bootstrap=100',
    ])
    expect(partialAnalysis.code).toBe(1)
    expect(partialAnalysis.stderr).toContain(
      'This run is not formal-eligible. Re-run with --allow-nonformal',
    )
    mkdirSync(humanDir, { recursive: true })
    const awaitingPath = path.join(privateRoot, 'reports', 'awaiting.json')
    const awaiting = await runNode(ANALYZE, [
      `--run-dir=${runDir}`,
      `--blind-dir=${blindDir}`,
      `--human-dir=${humanDir}`,
      `--sealed-dir=${sealedDir}`,
      `--output=${awaitingPath}`,
      `--private-root=${privateRoot}`,
      '--bootstrap=100',
      '--allow-nonformal',
    ])
    expect(awaiting.code, awaiting.stderr).toBe(0)
    expect(readJson(awaitingPath)).toMatchObject({
      status: 'development_automatic_only',
      decodePerformed: false,
      automaticOnly: true,
      sourceEligibility: {
        mode: 'development',
        formalEligible: false,
        clean: true,
        determinism: 'partial',
      },
      humanState: {
        quality: 'missing_validation',
        isolation: 'missing_validation',
      },
      interRaterAgreement: { status: 'not_computed_missing_human' },
    })
    renameSync(hiddenKeyPath, keyPath)

    const qualityHumanPath = path.join(dir, 'quality-human.jsonl')
    const qualityHuman = readJsonl(path.join(blindDir, 'quality-human-template.jsonl'))
      .flatMap((record) => ['reviewer-A', 'reviewer-B', 'reviewer-C'].map((reviewerId, reviewerIndex) => ({
        ...record,
        reviewerId,
        candidateScores: Object.fromEntries(
          Object.keys(record.candidateScores).map((label, index) => [
            label,
            Object.fromEntries(Object.keys(record.candidateScores[label]).map((dimension) => [
              dimension,
              index === 0 ? reviewerIndex + 1 : 4,
            ])),
          ]),
        ),
        ranking: [['B'], ['A']],
        revisionNeeded: Object.fromEntries(
          Object.keys(record.revisionNeeded).map((label) => [label, false]),
        ),
        confidence: 'high',
        rationale: 'Evidence-based completed review.',
      })))
    writeJsonl(qualityHumanPath, qualityHuman)
    const singleSideDevelopmentPath = path.join(dir, 'quality-human-single-side.jsonl')
    writeJsonl(
      singleSideDevelopmentPath,
      qualityHuman.filter((record) => record.reviewerId === 'reviewer-A'),
    )
    const singleSideDevelopment = await runNode(VALIDATE, [
      `--packet=${path.join(blindDir, 'quality-packet.json')}`,
      `--input=${singleSideDevelopmentPath}`,
      `--output=${path.join(privateRoot, 'single-side-development-human')}`,
      `--private-root=${privateRoot}`,
      '--allow-nonformal',
      '--allow-legacy-unbound',
    ])
    expect(singleSideDevelopment.code).toBe(1)
    expect(singleSideDevelopment.stderr).toContain(
      'Human return validation requires exactly reviewer-A, reviewer-B, reviewer-C.',
    )
    const isolationHumanPath = path.join(dir, 'isolation-human.jsonl')
    const isolationHuman = readJsonl(path.join(blindDir, 'isolation-human-template.jsonl'))
      .flatMap((record) => ['reviewer-A', 'reviewer-B', 'reviewer-C'].map((reviewerId) => ({
        ...record,
        reviewerId,
        targetedErrorConfirmed: true,
        outcomes: { A: 'retained', B: 'corrected' },
        confidence: 'high',
        rationale: 'Both anonymous outputs were checked against the targeted error.',
      })))
    writeJsonl(isolationHumanPath, isolationHuman)

    for (const [packet, input] of [
      ['quality-packet.json', qualityHumanPath],
      ['isolation-packet.json', isolationHumanPath],
    ]) {
      const validated = await runNode(VALIDATE, [
        `--packet=${path.join(blindDir, packet)}`,
        `--input=${input}`,
        `--output=${humanDir}`,
        `--private-root=${privateRoot}`,
        '--allow-nonformal',
        '--allow-legacy-unbound',
      ])
      expect(validated.code, validated.stderr).toBe(0)
    }

    const analysisAPath = path.join(privateRoot, 'reports', 'analysis-a.json')
    const analysisBPath = path.join(privateRoot, 'reports', 'analysis-b.json')
    for (const output of [analysisAPath, analysisBPath]) {
      const analyzed = await runNode(ANALYZE, [
        `--run-dir=${runDir}`,
        `--blind-dir=${blindDir}`,
        `--human-dir=${humanDir}`,
        `--sealed-dir=${sealedDir}`,
        `--output=${output}`,
        `--private-root=${privateRoot}`,
        '--bootstrap=100',
        '--allow-nonformal',
      ])
      expect(analyzed.code, analyzed.stderr).toBe(0)
    }
    const analysisA = readJson(analysisAPath)
    const analysisB = readJson(analysisBPath)
    expect(analysisA).toEqual(analysisB)
    const validateAnalysis = new Ajv2020({ strict: false }).compile(readJson(path.join(
      ROOT, 'FSBP_Test', 'schemas', 'round-0820-analysis.schema.json',
    )))
    expect(validateAnalysis(analysisA), JSON.stringify(validateAnalysis.errors)).toBe(true)
    expect(validateAnalysis({
      ...analysisA,
      quality: {
        ...analysisA.quality,
        comparisons: analysisA.quality.comparisons.map((comparison: any) => ({
          ...comparison,
          weightedTotal: { ...comparison.weightedTotal, range: [0, 100] },
        })),
      },
    })).toBe(false)
    expect(analysisA).toMatchObject({
      status: 'development_complete',
      decodePerformed: true,
      namespace: 'fsbp',
      sourceEligibility: {
        mode: 'development',
        formalEligible: false,
        clean: true,
        determinism: 'partial',
      },
      engineering: {
        outcomes: {
          attemptedDenominator: 6,
          attemptedStatuses: { precheckFailed: 1 },
        },
      },
      quality: { status: 'complete' },
      isolation: { status: 'complete' },
    })
    expect(analysisA.quality.comparisons[0].dimensions.overall_quality)
      .toHaveProperty('holmAdjustedPValue')
    expect(analysisA.quality.comparisons[0].dimensions.overall_quality.pairedItems).toBe(1)
    expect(analysisA.quality.comparisons[0].weightedTotal).toMatchObject({
      range: [10, 100],
      pairedItems: 1,
    })
    expect(Object.values(analysisA.quality.summaries).every(
      (summary: any) => JSON.stringify(summary.weightedTotal.range) === '[10,100]',
    )).toBe(true)
    expect(readFileSync(analysisAPath.replace(/\.json$/i, '.md'), 'utf8'))
      .toContain('10–100 加权总分')
    const weightedOutcome = analysisA.quality.comparisons[0].weightedOutcome
    expect(weightedOutcome.targetWins + weightedOutcome.ties + weightedOutcome.targetLosses).toBe(1)
    expect(analysisA.quality.stratifiedWeightedTotal.byDirection.en_to_zh.itemCount).toBe(1)
    expect(analysisA.quality.agreement)
      .toHaveProperty('weightedTotalKrippendorffAlphaOrdinal')
    expect(analysisA.isolation.pairedAnalysis).toMatchObject({
      unit: 'item_cluster',
      clearPairs: 1,
      reviewerRatingsAreClusteredWithinItem: true,
    })
    expect(analysisA.isolation.pairedAnalysis.errorRetentionRiskDifference)
      .toHaveProperty('mcnemar')

    const runManifestPath = path.join(runDir, 'run-manifest.json')
    const formalFlagRun = readJson(runManifestPath)
    writeJson(runManifestPath, {
      ...formalFlagRun,
      freezeMode: 'formal',
      formalEligible: true,
    })
    const fixtureFreezePath = path.join(runDir, 'fixture-freeze-manifest.json')
    writeJson(fixtureFreezePath, {
      ...readJson(fixtureFreezePath),
      mode: 'formal',
      formalEligible: true,
    })
    const formalSourceDevelopmentOverridePath = path.join(
      privateRoot, 'reports', 'formal-source-development-override.json',
    )
    const formalSourceDevelopmentOverride = await runNode(ANALYZE, [
      `--run-dir=${runDir}`,
      `--blind-dir=${blindDir}`,
      `--human-dir=${humanDir}`,
      `--sealed-dir=${sealedDir}`,
      `--output=${formalSourceDevelopmentOverridePath}`,
      `--private-root=${privateRoot}`,
      '--bootstrap=100',
      '--allow-nonformal',
    ])
    expect(formalSourceDevelopmentOverride.code, formalSourceDevelopmentOverride.stderr).toBe(0)
    expect(readJson(formalSourceDevelopmentOverridePath)).toMatchObject({
      status: 'development_complete',
      sourceEligibility: { formalEligible: true },
      resultEligibility: {
        requestedMode: 'development_override',
        formalOutputEligible: false,
        developmentOutputEligible: true,
      },
    })
  })

  it('rejects a purported pair whose immutable snapshot identity differs', async () => {
    const dir = tempDir()
    const privateRoot = path.join(dir, 'FSBP_Test', 'private', 'round-0820')
    const runDir = path.join(privateRoot, 'run')
    const blindDir = path.join(privateRoot, 'blind')
    mkdirSync(runDir, { recursive: true })
    const common = {
      roundId: 'round-0820',
      namespace: 'fsbp',
      runId: 'mismatched-pair',
      datasetName: 'quality',
      experiment: 'translation_quality',
      sampleId: 'sample',
      direction: 'en_to_zh',
      category: 'literary',
      sourceText: 'Source.',
      taskBrief: 'Translate.',
      status: 'complete',
      text: 'Text.',
    }
    writeJsonl(path.join(runDir, 'final.jsonl'), [
      { ...common, outcomeKey: 'quality:sample:direct', condition: 'direct' },
      {
        ...common,
        outcomeKey: 'quality:sample:multi_raw',
        condition: 'multi_raw',
        candidateSetHash: 'b'.repeat(64),
        pairId: 'c'.repeat(64),
        comparisonControlHash: 'd'.repeat(64),
        allowedDifference: 'downstream_inherited_view_only',
        inheritedView: 'raw',
      },
      {
        ...common,
        outcomeKey: 'quality:sample:multi_fsbp',
        condition: 'multi_fsbp',
        candidateSetHash: 'e'.repeat(64),
        pairId: 'c'.repeat(64),
        comparisonControlHash: 'd'.repeat(64),
        allowedDifference: 'downstream_inherited_view_only',
        inheritedView: 'body',
      },
    ])
    writeTerminalRunManifest(runDir, {
      runId: 'mismatched-pair',
      freezeManifestSha256: 'a'.repeat(64),
    })
    writeExternalBaseline(privateRoot, [{
      id: 'sample',
      direction: 'en_to_zh',
      sourceText: 'Source.',
      taskBrief: 'Translate.',
      translation: 'External GPT baseline.',
    }])
    const result = await runNode(PREPARE, [
      `--run-dir=${runDir}`,
      `--output=${blindDir}`,
      `--sealed-output=${path.join(privateRoot, 'sealed')}`,
      `--private-root=${privateRoot}`,
      '--allow-nonformal',
    ])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      'quality:sample: candidateSetHash does not prove an exact raw/FSBP pair.',
    )
    expect(existsSync(path.join(blindDir, 'quality-packet.json'))).toBe(false)
  })
})
