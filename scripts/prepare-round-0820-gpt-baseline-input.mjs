import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultRoundRoot = path.join(projectRoot, 'FSBP_Test', 'private', 'round-0820')
const defaultRunDir = path.join(
  defaultRoundRoot,
  'runs',
  'round-0820-all-gpt-131072-t900-c5-20260823-v2',
)

function option(name, fallback) {
  const prefix = `--${name}=`
  const matches = process.argv.slice(2).filter((argument) => argument.startsWith(prefix))
  if (matches.length > 1) throw new Error(`Duplicate --${name} option`)
  return matches.length ? path.resolve(matches[0].slice(prefix.length)) : fallback
}

const roundRoot = option('round-root', defaultRoundRoot)
const runDir = option('run-dir', roundRoot === defaultRoundRoot
  ? defaultRunDir
  : path.join(roundRoot, 'runs', 'formal'))
const outputDir = option('output-dir', roundRoot)

function normalizeText(value, label) {
  const normalized = String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim()
  if (!normalized) throw new Error(`${label} is empty after normalization`)
  return normalized
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function expectedIds() {
  return Array.from(
    { length: 24 },
    (_, index) => `qgate-${String(index + 1).padStart(2, '0')}`,
  )
}

function parsePrivateSource(text, label) {
  const normalized = normalizeText(text, label)
  const sections = normalized.split(/^---\s*$/m)
  if (sections.length !== 2) {
    throw new Error(`${label} must contain exactly one standalone --- source/task-note divider`)
  }
  return {
    sourceText: normalizeText(sections[0], `${label} source body`),
    taskNote: normalizeText(sections[1], `${label} task note`),
  }
}

async function readJsonlWithLines(filePath) {
  const text = await readFile(filePath, 'utf8')
  const lines = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => line.trim())
  const records = lines.map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`${path.basename(filePath)}:${index + 1}: invalid JSON: ${error.message}`)
    }
  })
  return { lines, records }
}

function exactRecordsById(records, idField, label) {
  const ids = expectedIds()
  if (records.length !== ids.length) {
    throw new Error(`${label} must contain exactly 24 records, received ${records.length}`)
  }
  const byId = new Map()
  for (const record of records) {
    const id = record?.[idField]
    if (typeof id !== 'string' || !id) throw new Error(`${label} contains a record without ${idField}`)
    if (byId.has(id)) throw new Error(`${label} contains duplicate ${idField} ${id}`)
    byId.set(id, record)
  }
  const missing = ids.filter((id) => !byId.has(id))
  const extra = [...byId.keys()].filter((id) => !ids.includes(id))
  if (missing.length || extra.length) {
    throw new Error(`${label} id mismatch; missing=${missing.join(',') || 'none'}; extra=${extra.join(',') || 'none'}`)
  }
  return byId
}

function assertBaselineRecord(record, authority, label) {
  if (record.id !== authority.sampleId) throw new Error(`${label}: id differs from formal authority`)
  if (record.direction !== authority.direction) {
    throw new Error(`${label}: direction differs from formal authority`)
  }
  if (record.sourceText !== authority.sourceText) {
    throw new Error(`${label}: sourceText differs from formal authority`)
  }
  if (record.taskBrief !== authority.taskBrief) {
    throw new Error(`${label}: taskBrief differs from formal authority`)
  }
}

function textMetadata(value, status) {
  return {
    sha256: sha256(value),
    length: value.length,
    status,
  }
}

function fileMetadata(bytes, count, status) {
  return {
    sha256: sha256(bytes),
    length: bytes.length,
    count,
    status,
  }
}

const FORBIDDEN_CORRECTION_KEY = /(translation|sourceText|body|content|key|token|secret)/i

function assertCorrectionAuditSafe(value, protectedTexts, location = 'correction') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertCorrectionAuditSafe(item, protectedTexts, `${location}[${index}]`)
    })
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_CORRECTION_KEY.test(key)) {
        throw new Error(`${location}: forbidden correction audit key ${key}`)
      }
      assertCorrectionAuditSafe(item, protectedTexts, `${location}.${key}`)
    }
    return
  }
  if (typeof value === 'string' && protectedTexts.has(value)) {
    throw new Error(`${location}: correction audit contains protected source or output text`)
  }
}

async function writeAtomically(filePath, contents) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  await rm(temporaryPath, { force: true })
  await writeFile(temporaryPath, contents)
  await rename(temporaryPath, filePath)
}

async function main() {
  const paths = {
    quality: path.join(roundRoot, 'quality-simplified.jsonl'),
    formalFinal: path.join(runDir, 'final.jsonl'),
    initialInput: path.join(roundRoot, 'gpt-baseline-input.jsonl'),
    initialOutput: path.join(roundRoot, 'gpt-baseline-output.jsonl'),
    v2Input: path.join(roundRoot, 'gpt-baseline-input-v2.jsonl'),
    v2Output: path.join(roundRoot, 'gpt-baseline-output-v2.jsonl'),
    qgate08Correction: path.join(roundRoot, 'qgate-08-gpt-baseline-correction.txt'),
    qgate09Correction: path.join(roundRoot, 'qgate-09-gpt-baseline-correction.txt'),
    w1: path.join(roundRoot, '01-source', 'private', 'W-1.txt'),
    w2: path.join(roundRoot, '01-source', 'private', 'W-2.txt'),
  }
  const outputPaths = {
    input: path.join(outputDir, 'gpt-baseline-input-v3.jsonl'),
    output: path.join(outputDir, 'gpt-baseline-output-v3.jsonl'),
    correction: path.join(outputDir, 'gpt-baseline-correction-v3.json'),
  }

  const [
    quality,
    formalFinal,
    initialInput,
    initialOutput,
    v2Input,
    v2Output,
    qgate08CorrectionBytes,
    qgate09CorrectionBytes,
    w1Bytes,
    w2Bytes,
  ] = await Promise.all([
    readJsonlWithLines(paths.quality),
    readJsonlWithLines(paths.formalFinal),
    readJsonlWithLines(paths.initialInput),
    readJsonlWithLines(paths.initialOutput),
    readJsonlWithLines(paths.v2Input),
    readJsonlWithLines(paths.v2Output),
    readFile(paths.qgate08Correction),
    readFile(paths.qgate09Correction),
    readFile(paths.w1),
    readFile(paths.w2),
  ])

  const qualityById = exactRecordsById(quality.records, 'id', 'quality-simplified.jsonl')
  const formalConditions = ['direct', 'multi_raw', 'multi_fsbp']
  if (formalFinal.records.length !== 72) {
    throw new Error(`formal final.jsonl must contain exactly 72 records, received ${formalFinal.records.length}`)
  }
  const formalDirectRecords = formalFinal.records.filter((record) => record.condition === 'direct')
  const formalById = exactRecordsById(formalDirectRecords, 'sampleId', 'formal direct outcomes')
  const initialInputById = exactRecordsById(initialInput.records, 'id', 'initial baseline input')
  const initialOutputById = exactRecordsById(initialOutput.records, 'id', 'initial baseline output')
  const v2InputById = exactRecordsById(v2Input.records, 'id', 'v2 baseline input')
  const v2OutputById = exactRecordsById(v2Output.records, 'id', 'v2 baseline output')

  for (const id of expectedIds()) {
    const outcomes = formalFinal.records.filter((record) => record.sampleId === id)
    if (outcomes.length !== formalConditions.length) {
      throw new Error(`${id}: formal final must contain exactly three conditions`)
    }
    for (const condition of formalConditions) {
      const matches = outcomes.filter((record) => record.condition === condition)
      if (matches.length !== 1 || matches[0].status !== 'complete') {
        throw new Error(`${id}:${condition}: formal outcome is missing or incomplete`)
      }
      const formalOutcome = matches[0]
      const directAuthority = formalById.get(id)
      for (const field of ['direction', 'sourceText', 'taskBrief']) {
        if (formalOutcome[field] !== directAuthority[field]) {
          throw new Error(`${id}:${condition}: ${field} differs from direct formal authority`)
        }
      }
    }
    const authority = formalById.get(id)
    const qualityRecord = qualityById.get(id)
    for (const field of ['direction', 'sourceText', 'taskBrief']) {
      if (qualityRecord[field] !== authority[field]) {
        throw new Error(`${id}: quality ${field} differs from formal run authority`)
      }
    }
  }

  const privateSources = new Map([
    ['qgate-08', parsePrivateSource(w1Bytes.toString('utf8'), 'W-1.txt')],
    ['qgate-09', parsePrivateSource(w2Bytes.toString('utf8'), 'W-2.txt')],
  ])
  for (const [id, parsed] of privateSources) {
    const authority = formalById.get(id)
    if (authority.sourceText.includes('\n---\n') || authority.sourceText.includes(parsed.taskNote)) {
      throw new Error(`${id}: task-note suffix contaminated formal sourceText`)
    }
    if (parsed.sourceText !== authority.sourceText) {
      throw new Error(`${id}: private source body differs from formal run authority`)
    }
  }

  const correctionTranslations = new Map([
    ['qgate-08', normalizeText(qgate08CorrectionBytes.toString('utf8'), 'qgate-08 correction')],
    ['qgate-09', normalizeText(qgate09CorrectionBytes.toString('utf8'), 'qgate-09 correction')],
  ])
  const correctedIds = new Set(correctionTranslations.keys())

  const v3InputLines = initialInput.records.map((record, index) => {
    const authority = formalById.get(record.id)
    if (!correctedIds.has(record.id)) {
      assertBaselineRecord(record, authority, `initial baseline input ${record.id}`)
      return initialInput.lines[index]
    }
    return JSON.stringify({
      id: authority.sampleId,
      direction: authority.direction,
      taskBrief: authority.taskBrief,
      sourceText: authority.sourceText,
    })
  })

  const v3OutputLines = initialOutput.records.map((record, index) => {
    const authority = formalById.get(record.id)
    if (record.direction !== authority.direction) {
      throw new Error(`initial baseline output ${record.id}: direction differs from formal authority`)
    }
    if (!correctedIds.has(record.id)) return initialOutput.lines[index]
    return JSON.stringify({
      id: record.id,
      direction: record.direction,
      translation: correctionTranslations.get(record.id),
    })
  })

  const v3InputText = `${v3InputLines.join('\n')}\n`
  const v3OutputText = `${v3OutputLines.join('\n')}\n`
  const v3Input = v3InputLines.map((line) => JSON.parse(line))
  const v3Output = v3OutputLines.map((line) => JSON.parse(line))
  for (const record of v3Input) {
    assertBaselineRecord(record, formalById.get(record.id), `v3 baseline input ${record.id}`)
  }

  const findById = (records, id) => records.find((record) => record.id === id)
  const inputInitialChanged = expectedIds().filter(
    (id) => JSON.stringify(initialInputById.get(id)) !== JSON.stringify(findById(v3Input, id)),
  )
  const outputInitialChanged = expectedIds().filter(
    (id) => JSON.stringify(initialOutputById.get(id)) !== JSON.stringify(findById(v3Output, id)),
  )
  const inputV2Changed = expectedIds().filter(
    (id) => JSON.stringify(v2InputById.get(id)) !== JSON.stringify(findById(v3Input, id)),
  )
  const outputV2Changed = expectedIds().filter(
    (id) => JSON.stringify(v2OutputById.get(id)) !== JSON.stringify(findById(v3Output, id)),
  )
  const assertChangedIds = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${label} changed ids must be ${expected.join(',')}; received ${actual.join(',') || 'none'}`)
    }
  }
  assertChangedIds(inputInitialChanged, ['qgate-08', 'qgate-09'], 'initial-to-v3 input')
  assertChangedIds(outputInitialChanged, ['qgate-08', 'qgate-09'], 'initial-to-v3 output')
  assertChangedIds(inputV2Changed, ['qgate-08', 'qgate-09'], 'v2-to-v3 input')
  assertChangedIds(outputV2Changed, ['qgate-09'], 'v2-to-v3 output')

  const fileBytes = {
    initialInput: Buffer.from(`${initialInput.lines.join('\n')}\n`, 'utf8'),
    initialOutput: Buffer.from(`${initialOutput.lines.join('\n')}\n`, 'utf8'),
    v2Input: Buffer.from(`${v2Input.lines.join('\n')}\n`, 'utf8'),
    v2Output: Buffer.from(`${v2Output.lines.join('\n')}\n`, 'utf8'),
    v3Input: Buffer.from(v3InputText, 'utf8'),
    v3Output: Buffer.from(v3OutputText, 'utf8'),
  }
  const sampleMetadata = {}
  for (const id of correctedIds) {
    const initialIn = initialInputById.get(id)
    const initialOut = initialOutputById.get(id)
    const v2In = v2InputById.get(id)
    const v2Out = v2OutputById.get(id)
    const v3In = findById(v3Input, id)
    const v3Out = findById(v3Output, id)
    sampleMetadata[id] = {
      initialInput: textMetadata(JSON.stringify(initialIn), 'superseded'),
      initialOutput: textMetadata(JSON.stringify(initialOut), 'superseded'),
      v2Input: textMetadata(JSON.stringify(v2In), 'superseded'),
      v2Output: textMetadata(
        JSON.stringify(v2Out),
        id === 'qgate-08' ? 'retained' : 'superseded',
      ),
      v3Input: textMetadata(JSON.stringify(v3In), 'complete'),
      v3Output: textMetadata(JSON.stringify(v3Out), 'complete'),
      sourceArtifact: textMetadata(v3In.sourceText, 'exact_formal_authority'),
      outputArtifact: textMetadata(v3Out.translation, 'complete'),
    }
  }

  const correction = {
    schemaVersion: '1.0.0',
    status: 'complete',
    count: 24,
    files: {
      initialInput: fileMetadata(fileBytes.initialInput, 24, 'superseded'),
      initialOutput: fileMetadata(fileBytes.initialOutput, 24, 'superseded'),
      v2Input: fileMetadata(fileBytes.v2Input, 24, 'superseded'),
      v2Output: fileMetadata(fileBytes.v2Output, 24, 'superseded'),
      v3Input: fileMetadata(fileBytes.v3Input, 24, 'complete'),
      v3Output: fileMetadata(fileBytes.v3Output, 24, 'complete'),
    },
    relativeToInitial: {
      inputCorrectedCount: inputInitialChanged.length,
      inputUnchangedCount: 24 - inputInitialChanged.length,
      outputCorrectedCount: outputInitialChanged.length,
      outputUnchangedCount: 24 - outputInitialChanged.length,
      status: 'two_inputs_two_outputs_corrected',
    },
    relativeToV2: {
      inputCorrectedCount: inputV2Changed.length,
      inputUnchangedCount: 24 - inputV2Changed.length,
      outputCorrectedCount: outputV2Changed.length,
      outputUnchangedCount: 24 - outputV2Changed.length,
      status: 'formal_task_briefs_and_qgate_09_translation_corrected',
    },
    authority: {
      exactRecordCount: v3Input.length,
      mismatchCount: 0,
      status: 'exact_formal_run_authority',
    },
    samples: sampleMetadata,
  }
  const protectedTexts = new Set([
    ...quality.records.map((record) => record.sourceText),
    ...initialInput.records.map((record) => record.sourceText),
    ...v2Input.records.map((record) => record.sourceText),
    ...v3Input.map((record) => record.sourceText),
    ...initialOutput.records.map((record) => record.translation),
    ...v2Output.records.map((record) => record.translation),
    ...v3Output.map((record) => record.translation),
  ].filter((value) => typeof value === 'string' && value.length))
  assertCorrectionAuditSafe(correction, protectedTexts)
  const correctionText = `${JSON.stringify(correction, null, 2)}\n`

  await mkdir(outputDir, { recursive: true })
  await Promise.all([
    writeAtomically(outputPaths.input, fileBytes.v3Input),
    writeAtomically(outputPaths.output, fileBytes.v3Output),
    writeAtomically(outputPaths.correction, correctionText),
  ])

  process.stdout.write(`${JSON.stringify({
    status: 'complete',
    records: 24,
    inputSha256: sha256(fileBytes.v3Input),
    outputSha256: sha256(fileBytes.v3Output),
    correctionSha256: sha256(Buffer.from(correctionText, 'utf8')),
    relativeToInitial: correction.relativeToInitial,
    relativeToV2: correction.relativeToV2,
  })}\n`)
}

await main()
