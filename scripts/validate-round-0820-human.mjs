import { readFile, writeFile } from 'node:fs/promises'
import { mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {
  ISOLATION_OUTCOMES,
  QUALITY_DIMENSIONS,
  ROUND_ID,
  assertPacketHash,
  assertPathInside,
  hashJson,
  packetHash,
  parseArgs,
  readJson,
  readJsonl,
  sha256,
  writeJsonNew,
} from './round-0820-lib.mjs'

const CONFIDENCE = new Set(['high', 'medium', 'low'])
const FORMAL_REVIEWER_IDS = ['reviewer-A', 'reviewer-B', 'reviewer-C']
const FORMAL_QUALITY_ITEM_COUNT = 24

function usage() {
  return [
    'Usage: node scripts/validate-round-0820-human.mjs --packet <blind-packet.json>',
    '  --input-dir <directory-containing-the-three-returned-quality-CSVs>',
    '  [--private-root <FSBP_Test/private/round-0820>]',
    '  [--allow-nonformal --input <development-fixture.jsonl>]',
    '  [--allow-legacy-unbound]  # only for already-returned packages created without credentials',
    '',
    'This command validates and hashes blinded human records. It never accepts or reads a blind key.',
  ].join('\n')
}

function assertExactKeys(record, allowed, label) {
  const extras = Object.keys(record).filter((key) => !allowed.has(key))
  if (extras.length) throw new Error(`${label}: unexpected field(s): ${extras.join(', ')}`)
}

function assertReviewer(record, label) {
  if (record.reviewerType !== 'human') {
    throw new Error(`${label}: reviewerType must be human.`)
  }
  if (!FORMAL_REVIEWER_IDS.includes(record.reviewerId)) {
    throw new Error(`${label}: reviewerId must be reviewer-A, reviewer-B, or reviewer-C.`)
  }
  if (!CONFIDENCE.has(record.confidence)) {
    throw new Error(`${label}: confidence must be high, medium, or low.`)
  }
  if (typeof record.rationale !== 'string' || !record.rationale.trim()) {
    throw new Error(`${label}: rationale is required.`)
  }
}

function validateRanking(ranking, labels, recordLabel) {
  if (!Array.isArray(ranking) || !ranking.length) {
    throw new Error(`${recordLabel}: ranking must contain one or more rank groups.`)
  }
  const flattened = []
  for (const [index, group] of ranking.entries()) {
    if (!Array.isArray(group) || !group.length) {
      throw new Error(`${recordLabel}: ranking[${index}] must be a non-empty label array.`)
    }
    flattened.push(...group)
  }
  if (
    flattened.length !== labels.length ||
    new Set(flattened).size !== labels.length ||
    flattened.some((label) => !labels.includes(label))
  ) {
    throw new Error(`${recordLabel}: ranking must contain every anonymous label exactly once.`)
  }
}

function validateQuality(record, item, recordLabel) {
  assertExactKeys(record, new Set([
    'schemaVersion', 'packetId', 'packetHash', 'kind', 'reviewerType',
    'namespace',
    'reviewerId', 'itemId', 'candidateScores', 'ranking', 'severeErrors',
    'revisionNeeded', 'confidence', 'rationale', 'unableToJudge',
  ]), recordLabel)
  const labels = item.candidates.map((candidate) => candidate.label)
  if (record.unableToJudge !== undefined && typeof record.unableToJudge !== 'boolean') {
    throw new Error(`${recordLabel}: unableToJudge must be boolean when present.`)
  }
  const unableToJudge = record.unableToJudge === true
  if (!record.candidateScores || typeof record.candidateScores !== 'object') {
    throw new Error(`${recordLabel}: candidateScores is required.`)
  }
  if (Object.keys(record.candidateScores).sort().join(',') !== [...labels].sort().join(',')) {
    throw new Error(`${recordLabel}: candidateScores labels do not match the packet.`)
  }
  for (const label of labels) {
    const scores = record.candidateScores[label]
    if (!scores || typeof scores !== 'object') {
      throw new Error(`${recordLabel}: scores for ${label} are required.`)
    }
    if (Object.keys(scores).sort().join(',') !== [...QUALITY_DIMENSIONS].sort().join(',')) {
      throw new Error(`${recordLabel}: ${label} must contain the six frozen dimensions.`)
    }
    for (const dimension of QUALITY_DIMENSIONS) {
      const value = scores[dimension]
      if (unableToJudge && value === null) continue
      if (value === null && dimension === 'terminology_logic') continue
      if (!Number.isInteger(value) || value < 1 || value > 10) {
        throw new Error(`${recordLabel}: ${label}.${dimension} must be 1-10${
          dimension === 'terminology_logic' ? ' or null (N/A)' : ''
        }.`)
      }
    }
  }
  if (unableToJudge) {
    if (!Array.isArray(record.ranking) || record.ranking.length) {
      throw new Error(`${recordLabel}: unable-to-judge records must have an empty ranking.`)
    }
  } else {
    validateRanking(record.ranking, labels, recordLabel)
  }
  if (!Array.isArray(record.severeErrors)) {
    throw new Error(`${recordLabel}: severeErrors must be an array.`)
  }
  for (const [index, issue] of record.severeErrors.entries()) {
    if (
      !issue || typeof issue !== 'object' ||
      !labels.includes(issue.candidate) ||
      typeof issue.location !== 'string' || !issue.location.trim() ||
      typeof issue.category !== 'string' || !issue.category.trim() ||
      !['major', 'critical'].includes(issue.severity) ||
      typeof issue.evidence !== 'string' || !issue.evidence.trim()
    ) {
      throw new Error(`${recordLabel}: severeErrors[${index}] is invalid.`)
    }
  }
  if (!record.revisionNeeded || typeof record.revisionNeeded !== 'object' ||
      Object.keys(record.revisionNeeded).sort().join(',') !== [...labels].sort().join(',')) {
    throw new Error(`${recordLabel}: revisionNeeded must map every anonymous label.`)
  }
  if (unableToJudge) {
    if (labels.some((label) => record.revisionNeeded[label] !== null) || record.severeErrors.length) {
      throw new Error(`${recordLabel}: unable-to-judge records must leave revision and severe errors empty.`)
    }
    if (record.confidence !== 'low') {
      throw new Error(`${recordLabel}: unable-to-judge records must use low confidence.`)
    }
  } else if (labels.some((label) => typeof record.revisionNeeded[label] !== 'boolean')) {
    throw new Error(`${recordLabel}: revisionNeeded must map every label to a boolean.`)
  }
}

function parseCsv(text, label) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  const input = text.replace(/^\ufeff/, '')
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (character === '"') quoted = false
      else field += character
    } else if (character === '"') quoted = true
    else if (character === ',') {
      row.push(field)
      field = ''
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''))
      if (row.some((value) => value !== '')) rows.push(row)
      row = []
      field = ''
    } else field += character
  }
  if (quoted) throw new Error(`${label}: unterminated quoted CSV field.`)
  if (field || row.length) {
    row.push(field.replace(/\r$/, ''))
    if (row.some((value) => value !== '')) rows.push(row)
  }
  if (rows.length < 2) throw new Error(`${label}: CSV has no score rows.`)
  const headers = rows[0]
  if (new Set(headers).size !== headers.length || headers.some((header) => !header)) {
    throw new Error(`${label}: CSV headers must be non-empty and unique.`)
  }
  return rows.slice(1).map((values, index) => {
    if (values.length !== headers.length) {
      throw new Error(`${label}:${index + 2}: expected ${headers.length} columns, found ${values.length}.`)
    }
    return Object.fromEntries(headers.map((header, column) => [header, values[column]]))
  })
}

function parseBoolean(value, label, { allowBlank = false } = {}) {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (allowBlank && !normalized) return null
  if (['true', 'yes', '1', '是'].includes(normalized)) return true
  if (['false', 'no', '0', '否'].includes(normalized)) return false
  throw new Error(`${label}: expected true/false.`)
}

function parseScore(value, label, { unableToJudge, terminology }) {
  const normalized = String(value ?? '').trim()
  if (unableToJudge && !normalized) return null
  if (terminology && ['n/a', 'na', '不适用'].includes(normalized.toLowerCase())) return null
  const score = Number(normalized)
  if (!Number.isInteger(score) || score < 1 || score > 10) {
    throw new Error(`${label}: score must be an integer from 1 through 10${terminology ? ' or N/A' : ''}.`)
  }
  return score
}

function parseRanking(value, labels, label, unableToJudge) {
  const normalized = String(value ?? '').trim().toUpperCase()
  if (unableToJudge && !normalized) return []
  if (!normalized) throw new Error(`${label}: ranking is required.`)
  const ranking = normalized.split('>').map((group) => group.split('=').map((entry) => entry.trim()))
  validateRanking(ranking, labels, label)
  return ranking
}

function qualityRecordsFromCsv(packet, text, fileLabel, expectedReviewerId = null) {
  if (packet.kind !== 'quality') {
    throw new Error(`${fileLabel}: CSV input is supported only for quality packets.`)
  }
  const labels = packet.items[0]?.candidates.map((candidate) => candidate.label) ?? []
  return parseCsv(text, fileLabel).map((row, index) => {
    const rowLabel = `${fileLabel}:${index + 2}`
    const unableToJudge = parseBoolean(row.unableToJudge, `${rowLabel}.unableToJudge`)
    const candidateScores = {}
    const revisionNeeded = {}
    const severeErrors = []
    for (const candidate of labels) {
      candidateScores[candidate] = Object.fromEntries(QUALITY_DIMENSIONS.map((dimension) => [
        dimension,
        parseScore(row[`${candidate}_${dimension}`], `${rowLabel}.${candidate}_${dimension}`, {
          unableToJudge,
          terminology: dimension === 'terminology_logic',
        }),
      ]))
      revisionNeeded[candidate] = unableToJudge
        ? null
        : parseBoolean(row[`${candidate}_revisionNeeded`], `${rowLabel}.${candidate}_revisionNeeded`)
      const errorFields = {
        location: String(row[`${candidate}_severeErrorLocation`] ?? '').trim(),
        category: String(row[`${candidate}_severeErrorCategory`] ?? '').trim(),
        severity: String(row[`${candidate}_severeErrorSeverity`] ?? '').trim().toLowerCase(),
        evidence: String(row[`${candidate}_severeErrorEvidence`] ?? '').trim(),
      }
      const present = Object.values(errorFields).filter(Boolean).length
      if (present && present !== 4) {
        throw new Error(`${rowLabel}: all four ${candidate} severe-error fields are required together.`)
      }
      if (present) severeErrors.push({ candidate, ...errorFields })
    }
    const submittedReviewerId = String(row.reviewerId ?? '').trim()
    if (
      expectedReviewerId && submittedReviewerId &&
      submittedReviewerId !== expectedReviewerId
    ) {
      throw new Error(
        `${rowLabel}.reviewerId must stay blank or match ${expectedReviewerId}.`,
      )
    }
    return {
      schemaVersion: '1.0.0',
      namespace: 'fsbp',
      packetId: packet.packetId,
      packetHash: packet.packetHash,
      kind: 'quality',
      reviewerType: 'human',
      reviewerId: expectedReviewerId ?? submittedReviewerId,
      itemId: row.itemId,
      unableToJudge,
      candidateScores,
      ranking: parseRanking(row.ranking, labels, `${rowLabel}.ranking`, unableToJudge),
      severeErrors,
      revisionNeeded,
      confidence: String(row.confidence ?? '').trim().toLowerCase(),
      rationale: String(row.rationale ?? '').trim(),
    }
  })
}

async function collectScoreFiles(inputDir) {
  const matches = []
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(target)
      else if (entry.name === '02-质量评分表.csv') {
        const packageMatch = path.basename(directory).match(/^04-human-review-([ABC])$/)
        matches.push({
          path: target,
          reviewerId: packageMatch ? `reviewer-${packageMatch[1]}` : null,
          packageCode: packageMatch?.[1] ?? null,
          credentialPath: path.join(directory, '03-回传凭证.json'),
        })
      }
    }
  }
  await visit(inputDir)
  matches.sort((left, right) => left.path.localeCompare(right.path))
  if (!matches.length) throw new Error(`${inputDir}: no returned 02-质量评分表.csv files found.`)
  return matches
}

function assertReturnCredentialShape(credential, label) {
  const required = new Set([
    'schemaVersion', 'roundId', 'namespace', 'credentialKind', 'packetId', 'packetHash',
    'reviewerPackageId', 'reviewerToken', 'reviewerTokenHash',
  ])
  assertExactKeys(credential, required, label)
  if (
    credential.schemaVersion !== '1.0.0' || credential.roundId !== ROUND_ID ||
    credential.namespace !== 'fsbp' ||
    credential.credentialKind !== 'human_review_return_credential' ||
    typeof credential.reviewerPackageId !== 'string' ||
    !/^rp-[a-f0-9]{24}$/.test(credential.reviewerPackageId) ||
    typeof credential.reviewerToken !== 'string' ||
    !/^[a-f0-9]{64}$/.test(credential.reviewerToken) ||
    typeof credential.reviewerTokenHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(credential.reviewerTokenHash) ||
    sha256(credential.reviewerToken) !== credential.reviewerTokenHash
  ) {
    throw new Error(`${label}: return credential is malformed or has an invalid token hash.`)
  }
}

async function validateReturnBindings({ inputSources, packet, packetPath, allowLegacyUnbound }) {
  const csvFileSha256 = new Map(await Promise.all(inputSources.map(async (source) => (
    [source.path, sha256(await readFile(source.path))]
  ))))
  const hasCredential = await Promise.all(inputSources.map(async (source) => {
    if (!source.credentialPath) return false
    try {
      await readFile(source.credentialPath)
      return true
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return false
      throw error
    }
  }))
  if (!hasCredential.every(Boolean)) {
    if (hasCredential.some(Boolean)) {
      throw new Error('Returned review set mixes bound and unbound packages; refusing partial binding.')
    }
    if (!allowLegacyUnbound) {
      throw new Error(
        'Returned packages have no 03-回传凭证.json. Legacy unbound packages are rejected by ' +
        'default; use --allow-legacy-unbound only with an independently attested A/B/C handoff.',
      )
    }
    return {
      bindingStatus: 'legacy_unbound_process_attested',
      bindingRisks: [
        'No package return token was distributed with these historical score files.',
        'A/B/C reviewer assignment is derived from the handoff directory and is not machine-proven human identity.',
        'Distinct CSV byte hashes are not treated as evidence of distinct reviewers.',
      ],
      machineVerifiedPackageOrigin: false,
      machineVerifiedHumanIdentity: false,
      packageCredentialVerified: false,
      csvContentBindingStatus: 'process_attested_not_cryptographic',
      reviewerPackages: inputSources.map((source) => ({
        reviewerId: source.reviewerId,
        packageCode: source.packageCode,
        credentialStatus: 'not_available_legacy_package',
        returnedCsvSha256: csvFileSha256.get(source.path),
      })),
    }
  }

  const manifestDir = path.join(path.dirname(packetPath), 'reviewer-package-manifests')
  const bound = []
  for (const source of inputSources) {
    if (!source.packageCode || !source.reviewerId) {
      throw new Error(`${source.path}: bound returns must remain in a 04-human-review-A/B/C directory.`)
    }
    const credentialBytes = await readFile(source.credentialPath)
    const credential = JSON.parse(credentialBytes.toString('utf8'))
    const credentialLabel = `${source.credentialPath}`
    assertReturnCredentialShape(credential, credentialLabel)
    const manifestPath = path.join(manifestDir, `reviewer-${source.packageCode}.json`)
    const manifest = await readJson(manifestPath)
    if (
      manifest.packageKind !== 'blinded_translation_quality_review' ||
      manifest.reviewerId !== source.reviewerId ||
      manifest.packetId !== packet.packetId || manifest.packetHash !== packet.packetHash ||
      credential.packetId !== packet.packetId || credential.packetHash !== packet.packetHash ||
      credential.reviewerPackageId !== manifest.reviewerPackageId ||
      credential.reviewerTokenHash !== manifest.reviewerTokenHash ||
      sha256(credentialBytes) !== manifest.files?.find(
        (descriptor) => descriptor.file === '03-回传凭证.json',
      )?.sha256
    ) {
      throw new Error(
        `${credentialLabel}: credential does not match this packet, directory, or researcher manifest.`,
      )
    }
    bound.push({
      reviewerId: source.reviewerId,
      packageCode: source.packageCode,
      reviewerPackageId: credential.reviewerPackageId,
      reviewerTokenHash: credential.reviewerTokenHash,
      credentialFileSha256: sha256(credentialBytes),
      returnedCsvSha256: csvFileSha256.get(source.path),
    })
  }
  if (new Set(bound.map((entry) => entry.reviewerPackageId)).size !== bound.length) {
    throw new Error('Returned reviewerPackageId values must be unique across A/B/C.')
  }
  if (new Set(bound.map((entry) => entry.reviewerTokenHash)).size !== bound.length) {
    throw new Error('Returned reviewer tokens must be unique across A/B/C; copied token detected.')
  }
  return {
    bindingStatus: 'package_credential_verified_process_attested',
    bindingRisks: [
      'The token proves that the returned credential matches a distributed package; it does not cryptographically bind the edited CSV bytes to that package.',
      'CSV-to-package attribution and reviewer independence still rely on the documented distribution and return process.',
      'Distinct CSV byte hashes are not treated as evidence of distinct reviewers.',
    ],
    packageCredentialVerified: true,
    csvContentBindingStatus: 'process_attested_not_cryptographic',
    machineVerifiedPackageOrigin: false,
    machineVerifiedHumanIdentity: false,
    reviewerPackages: bound,
  }
}

function validateIsolation(record, item, recordLabel) {
  assertExactKeys(record, new Set([
    'schemaVersion', 'packetId', 'packetHash', 'kind', 'reviewerType',
    'namespace',
    'reviewerId', 'itemId', 'targetedErrorConfirmed', 'outcomes',
    'confidence', 'rationale',
  ]), recordLabel)
  const labels = item.candidates.map((candidate) => candidate.label)
  if (typeof record.targetedErrorConfirmed !== 'boolean') {
    throw new Error(`${recordLabel}: targetedErrorConfirmed must be boolean.`)
  }
  if (
    !record.outcomes || typeof record.outcomes !== 'object' ||
    Object.keys(record.outcomes).sort().join(',') !== [...labels].sort().join(',')
  ) {
    throw new Error(`${recordLabel}: outcomes must map every anonymous label.`)
  }
  for (const label of labels) {
    if (!ISOLATION_OUTCOMES.includes(record.outcomes[label])) {
      throw new Error(`${recordLabel}: invalid outcome for ${label}.`)
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const allowedArgs = new Set([
    'packet', 'input', 'input-dir', 'output', 'private-root', 'allow-nonformal',
    'allow-legacy-unbound',
  ])
  const unknown = Object.keys(args).filter((key) => !allowedArgs.has(key))
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(', ')}`)
  if (!args.packet || (!args.input && !args['input-dir']) || (args.input && args['input-dir'])) {
    throw new Error(usage())
  }
  const allowNonformal = args['allow-nonformal'] === true
  const allowLegacyUnbound = args['allow-legacy-unbound'] === true
  if (!allowNonformal && args.input) {
    throw new Error(
      'Formal human validation requires --input-dir with all three returned A/B/C score files.',
    )
  }
  const packetPath = path.resolve(args.packet)
  const inputSources = args.input
    ? [{ path: path.resolve(args.input), reviewerId: null }]
    : await collectScoreFiles(path.resolve(args['input-dir']))
  const packet = await readJson(packetPath)
  assertPacketHash(packet)
  if (
    packet.roundId !== ROUND_ID || packet.namespace !== 'fsbp' ||
    !['quality', 'isolation'].includes(packet.kind)
  ) {
    throw new Error(`Packet must be a ${ROUND_ID} quality or isolation packet.`)
  }
  const outputDir = path.resolve(
    args.output ?? path.join(
      process.cwd(),
      'FSBP_Test',
      'private',
      ROUND_ID,
      'human',
      packet.runId,
    ),
  )
  const privateRoot = path.resolve(
    args['private-root'] ?? path.join(process.cwd(), 'FSBP_Test', 'private', ROUND_ID),
  )
  assertPathInside(privateRoot, outputDir, 'human freeze output')
  if (!packet.items.length) {
    throw new Error(`${packet.packetId}: packet has no eligible items to score.`)
  }
  const binding = await validateReturnBindings({
    inputSources,
    packet,
    packetPath,
    allowLegacyUnbound,
  })
  if (!allowNonformal) {
    if (packet.kind !== 'quality') {
      throw new Error(
        'Formal human validation is limited to the 24-item translation-quality review.',
      )
    }
    if (packet.kind === 'quality' && packet.items.length !== FORMAL_QUALITY_ITEM_COUNT) {
      throw new Error(
        `Formal quality validation requires exactly ${FORMAL_QUALITY_ITEM_COUNT} packet items; ` +
        `found ${packet.items.length}.`,
      )
    }
    const sourceReviewers = inputSources.map((source) => source.reviewerId).sort()
    if (
      inputSources.length !== FORMAL_REVIEWER_IDS.length ||
      sourceReviewers.join(',') !== [...FORMAL_REVIEWER_IDS].sort().join(',')
    ) {
      throw new Error(
        'Formal quality validation requires exactly one returned score file from each ' +
        '04-human-review-A, 04-human-review-B, and 04-human-review-C directory.',
      )
    }
  }
  const recordGroups = await Promise.all(inputSources.map(async (source) => {
    if (path.extname(source.path).toLowerCase() === '.csv') {
      return qualityRecordsFromCsv(
        packet,
        await readFile(source.path, 'utf8'),
        path.basename(source.path),
        source.reviewerId,
      )
    }
    return readJsonl(source.path)
  }))
  const records = recordGroups.flat()
  if (!records.length) throw new Error('Human score file is empty.')
  const itemById = new Map(packet.items.map((item) => [item.itemId, item]))
  const reviewerIds = new Set()
  const coverage = new Set()
  for (const [index, record] of records.entries()) {
    const label = `human-scores:${index + 1}`
    if (
      record.schemaVersion !== '1.0.0' ||
      record.namespace !== 'fsbp' ||
      record.packetId !== packet.packetId ||
      record.packetHash !== packet.packetHash ||
      record.kind !== packet.kind
    ) {
      throw new Error(`${label}: packet identity does not match the frozen blind packet.`)
    }
    assertReviewer(record, label)
    const item = itemById.get(record.itemId)
    if (!item) throw new Error(`${label}: unknown itemId ${record.itemId}.`)
    const coverageKey = `${record.reviewerId}\u0000${record.itemId}`
    if (coverage.has(coverageKey)) {
      throw new Error(`${label}: duplicate reviewer/item record.`)
    }
    coverage.add(coverageKey)
    reviewerIds.add(record.reviewerId)
    if (packet.kind === 'quality') validateQuality(record, item, label)
    else validateIsolation(record, item, label)
  }
  for (const reviewerId of reviewerIds) {
    for (const item of packet.items) {
      if (!coverage.has(`${reviewerId}\u0000${item.itemId}`)) {
        throw new Error(`Reviewer ${reviewerId} is missing item ${item.itemId}.`)
      }
    }
  }
  const expectedRecords = reviewerIds.size * packet.items.length
  if (records.length !== expectedRecords) {
    throw new Error(`Expected ${expectedRecords} complete records, found ${records.length}.`)
  }
  const actualReviewers = [...reviewerIds].sort()
  if (actualReviewers.join(',') !== [...FORMAL_REVIEWER_IDS].sort().join(',')) {
    throw new Error(
      `Human return validation requires exactly ${FORMAL_REVIEWER_IDS.join(', ')}.`,
    )
  }
  const completeRecordCount = FORMAL_REVIEWER_IDS.length * packet.items.length
  if (records.length !== completeRecordCount) {
    throw new Error(
      `Human return validation requires exactly ${completeRecordCount} records ` +
      `(${FORMAL_REVIEWER_IDS.length} reviewers × ${packet.items.length} packet items).`,
    )
  }
  if (!allowNonformal && packet.kind === 'quality' && packet.items.length !== FORMAL_QUALITY_ITEM_COUNT) {
    throw new Error(
      `Formal quality validation requires exactly ${FORMAL_QUALITY_ITEM_COUNT} packet items.`,
    )
  }

  records.sort((left, right) => (
    left.reviewerId.localeCompare(right.reviewerId) || left.itemId.localeCompare(right.itemId)
  ))
  const inputBytes = Buffer.from(`${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
  const packetBytes = await readFile(packetPath)
  const frozenName = `${packet.kind}-human.frozen.jsonl`
  const validationName = `${packet.kind}-human-validation.json`
  const frozenPath = path.join(outputDir, frozenName)
  const validationPath = path.join(outputDir, validationName)
  await mkdir(outputDir, { recursive: true })
  await writeFile(frozenPath, inputBytes, { flag: 'wx' })
  const validation = {
    schemaVersion: '1.0.0',
    roundId: ROUND_ID,
    namespace: 'fsbp',
    kind: packet.kind,
    validatedAt: new Date().toISOString(),
    valid: true,
    packetId: packet.packetId,
    packetHash: packet.packetHash,
    packetFileSha256: sha256(packetBytes),
    humanInputSha256: sha256(inputBytes),
    frozenHumanFile: frozenName,
    frozenHumanFileSha256: sha256(inputBytes),
    reviewerIds: [...reviewerIds].sort(),
    reviewerCount: reviewerIds.size,
    itemCount: packet.items.length,
    recordCount: records.length,
    decodePerformed: false,
    ...binding,
  }
  validation.validationManifestHash = hashJson(validation)
  await writeJsonNew(validationPath, validation)
  process.stdout.write(`${JSON.stringify({
    valid: true,
    kind: packet.kind,
    reviewerCount: reviewerIds.size,
    itemCount: packet.items.length,
    frozenHumanFileSha256: validation.frozenHumanFileSha256,
    bindingStatus: validation.bindingStatus,
    validationPath,
  }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
