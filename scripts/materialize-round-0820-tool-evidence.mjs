import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const SCRIPT_VERSION = '1.1.1'
const REPORT_SCHEMA_VERSION = 'round-0820.tool-evidence-case-study.v1'
const PAIR_MANIFEST_SCHEMA_VERSION = 'round-0820.tool-evidence-pair.v1'
const HASH_NAMESPACE = 'round-0820-tool-evidence:v1'
const EXPECTED_MODEL = 'GPT 5.6 Sol: CPA'
const EXPECTED_TOOL_SEQUENCE = [
  ['inspect_evidence', 'complete'],
  ['inspect_evidence', 'complete'],
  ['request_review', 'complete'],
  ['write_draft', 'failed'],
  ['request_review', 'complete'],
  ['write_draft', 'failed'],
  ['write_draft', 'complete'],
  ['replace_text', 'complete'],
  ['replace_text', 'complete'],
]
const COVERAGE_ONLY_TOOLS = {
  search_project_memory: {
    contractLocations: [
      'src/lib/contracts/translation-tools.ts',
      'src/lib/orchestration/translation-tools.ts',
      'src/lib/orchestration/translation-tool-runtime.ts',
    ],
    testLocations: ['test/db/translation-tool-repository.test.ts'],
  },
  record_issue: {
    contractLocations: [
      'src/lib/contracts/translation-tools.ts',
      'src/lib/orchestration/translation-tool-runtime.ts',
    ],
    testLocations: [
      'test/orchestration/translation-tools.test.ts',
      'test/orchestration/translation-tool-runtime.test.ts',
      'test/db/translation-tool-repository.test.ts',
    ],
  },
  propose_patch: {
    contractLocations: [
      'src/lib/contracts/translation-tools.ts',
      'src/lib/orchestration/translation-tool-runtime.ts',
    ],
    testLocations: [
      'test/orchestration/translation-tools.test.ts',
      'test/orchestration/translation-tool-runtime.test.ts',
      'test/db/translation-tool-repository.test.ts',
    ],
  },
}
const REQUIRED_COLUMNS = {
  sessions: [
    'id', 'source_text', 'task_brief', 'state', 'direction', 'review_mode',
    'config_snapshot', 'final_version_id',
  ],
  orchestration_runs: [
    'id', 'session_id', 'kind', 'status', 'phase',
  ],
  agent_invocations: [
    'id', 'session_id', 'parent_run_id', 'agent_variant_id', 'agent_snapshot',
    'model', 'status', 'usage_json', 'latency_ms',
  ],
  agent_tool_calls: [
    'id', 'session_id', 'run_id', 'invocation_id', 'parent_tool_call_id',
    'provider_tool_call_id', 'logical_call_key', 'stage', 'actor', 'depth',
    'schema_version', 'handler_version', 'tool_name', 'input_json',
    'output_json', 'status', 'error_code', 'evidence_ids_json', 'started_at',
    'completed_at',
  ],
  llm_call_records: [
    'id', 'session_id', 'run_id', 'invocation_id', 'operation',
    'requested_model', 'response_model', 'status', 'input_tokens',
    'output_tokens', 'reasoning_tokens', 'usage_source', 'first_byte_ms',
    'latency_ms', 'retry_count', 'error_code',
  ],
  final_versions: [
    'id', 'session_id', 'version_no', 'text', 'source', 'parent_version_id',
    'content_hash', 'created_by_patch_id',
  ],
  text_patches: [
    'id', 'session_id', 'base_version_id', 'result_version_id', 'old_text',
    'new_text', 'evidence_refs_json', 'diff_spans_json',
  ],
}
const FORBIDDEN_NORMALIZED_REPORT_KEYS = new Set([
  'apikey',
  'annotationoutput',
  'baseurl',
  'bodyoutput',
  'content',
  'details',
  'endpointurl',
  'errormessage',
  'fulltoolarguments',
  'fulltoolresults',
  'inputjson',
  'newtext',
  'oldtext',
  'outputjson',
  'projectmemory',
  'projectmemorybody',
  'prompt',
  'promptused',
  'rawoutput',
  'reason',
  'sourcetext',
  'taskbrief',
  'text',
  'toolarguments',
  'toolresults',
  'translation',
])
const SUSPECT_CREDENTIAL_PATTERNS = [
  /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{10,}\b/i,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]{10,}/i,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /newapi_channel_conn/i,
  /\bapi[\s_-]*key\b[\s"']*[:=]/i,
  /h\s*t\s*t\s*p\s*s?\s*:\s*\/\s*\//i,
]

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function hashFile(filePath) {
  return sha256(readFileSync(filePath))
}

function hashId(kind, value) {
  if (value === null || value === undefined) return null
  return sha256(`${HASH_NAMESPACE}\u0000${kind}\u0000${String(value)}`)
}

function assertRegularFile(filePath, label) {
  if (!existsSync(filePath)
    || lstatSync(filePath).isSymbolicLink()
    || !statSync(filePath).isFile()) {
    throw new Error(`${label} must be an existing regular file.`)
  }
}

function normalizeComparablePath(filePath) {
  return path.resolve(filePath).replace(/\\/g, '/').toLowerCase()
}

function assertPathInside(root, target, label, { allowRoot = false } = {}) {
  const relative = path.relative(root, target)
  if ((!relative && !allowRoot) || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a distinct file below ${root}.`)
  }
}

function nearestExistingAncestor(target) {
  let candidate = path.resolve(target)
  while (!existsSync(candidate)) {
    const parent = path.dirname(candidate)
    if (parent === candidate) throw new Error(`No existing ancestor for ${target}.`)
    candidate = parent
  }
  return candidate
}

function assertOutputTarget(root, target, expected, label) {
  const resolved = path.resolve(target)
  if (normalizeComparablePath(resolved) !== normalizeComparablePath(expected)) {
    throw new Error(`${label} is fixed and cannot be overridden.`)
  }
  assertPathInside(root, resolved, label)
  const ancestor = nearestExistingAncestor(resolved)
  const canonicalAncestor = realpathSync.native(ancestor)
  assertPathInside(
    realpathSync.native(root),
    canonicalAncestor,
    `${label} physical ancestor`,
    { allowRoot: true },
  )
  if (existsSync(resolved)) {
    if (lstatSync(resolved).isSymbolicLink() || !statSync(resolved).isFile()) {
      throw new Error(`${label} must be a regular file when it already exists.`)
    }
    const canonicalTarget = realpathSync.native(resolved)
    assertPathInside(realpathSync.native(root), canonicalTarget, `${label} physical target`)
  }
  return resolved
}

function assertFixedMaterializationPaths({
  repoRoot,
  databasePath,
  gatePath,
  schemaPath,
  jsonOutput,
  markdownOutput,
  pairManifestOutput,
}) {
  const canonicalRepoRoot = realpathSync.native(repoRoot)
  const expectedDatabase = path.join(canonicalRepoRoot, 'data', 'app.db')
  const expectedGate = path.join(
    canonicalRepoRoot,
    'FSBP_Test',
    'private',
    'round-0820',
    'tool-use-gate.jsonl',
  )
  const expectedSchema = path.join(
    canonicalRepoRoot,
    'FSBP_Test',
    'schemas',
    'round-0820-tool-evidence-case-study.schema.json',
  )
  for (const [actual, expected, label] of [
    [databasePath, expectedDatabase, 'source database'],
    [gatePath, expectedGate, 'tool-use gate'],
    [schemaPath, expectedSchema, 'report schema'],
  ]) {
    assertRegularFile(actual, label)
    const canonicalActual = realpathSync.native(actual)
    if (normalizeComparablePath(canonicalActual)
      !== normalizeComparablePath(realpathSync.native(expected))) {
      throw new Error(`${label} is fixed and cannot be overridden.`)
    }
    assertPathInside(canonicalRepoRoot, canonicalActual, `${label} physical path`)
  }
  const reportsRoot = path.join(
    canonicalRepoRoot,
    'FSBP_Test',
    'private',
    'round-0820',
    'reports',
  )
  if (!existsSync(reportsRoot)) mkdirSync(reportsRoot, { recursive: true })
  if (lstatSync(reportsRoot).isSymbolicLink() || !statSync(reportsRoot).isDirectory()) {
    throw new Error('round-0820 reports root must be a physical directory.')
  }
  const canonicalReportsRoot = realpathSync.native(reportsRoot)
  assertPathInside(canonicalRepoRoot, canonicalReportsRoot, 'reports root physical path')
  const outputs = {
    jsonOutput: assertOutputTarget(
      canonicalReportsRoot,
      jsonOutput,
      path.join(canonicalReportsRoot, 'tool-evidence-case-study.json'),
      'JSON output',
    ),
    markdownOutput: assertOutputTarget(
      canonicalReportsRoot,
      markdownOutput,
      path.join(canonicalReportsRoot, 'tool-evidence-case-study.md'),
      'Markdown output',
    ),
    pairManifestOutput: assertOutputTarget(
      canonicalReportsRoot,
      pairManifestOutput,
      path.join(canonicalReportsRoot, 'tool-evidence-case-study.pair.json'),
      'pair manifest output',
    ),
  }
  const allPaths = [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
    gatePath,
    schemaPath,
    outputs.jsonOutput,
    outputs.markdownOutput,
    outputs.pairManifestOutput,
  ].map(normalizeComparablePath)
  if (new Set(allPaths).size !== allPaths.length) {
    throw new Error('Inputs, SQLite sidecars, and report outputs must all be distinct.')
  }
  const physicalIdentities = new Map()
  for (const filePath of [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
    gatePath,
    schemaPath,
    outputs.jsonOutput,
    outputs.markdownOutput,
    outputs.pairManifestOutput,
  ]) {
    if (!existsSync(filePath)) continue
    const stats = statSync(filePath, { bigint: true })
    const identity = `${stats.dev}:${stats.ino}`
    if (physicalIdentities.has(identity)) {
      throw new Error(
        `Inputs, SQLite sidecars, and report outputs must not be hard-linked: ${filePath}.`,
      )
    }
    physicalIdentities.set(identity, filePath)
  }
  return {
    repoRoot: canonicalRepoRoot,
    reportsRoot: canonicalReportsRoot,
    databasePath: realpathSync.native(databasePath),
    gatePath: realpathSync.native(gatePath),
    schemaPath: realpathSync.native(schemaPath),
    ...outputs,
  }
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`)
  }
}

function parseJsonArray(raw, label) {
  const value = parseJson(raw, label)
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`)
  return value
}

function sqliteUtcMillis(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is missing.`)
  const normalized = value.endsWith('Z') ? value : `${value.replace(' ', 'T')}Z`
  const parsed = Date.parse(normalized)
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not a valid timestamp.`)
  return parsed
}

function elapsedMs(startedAt, completedAt, label) {
  const elapsed = sqliteUtcMillis(completedAt, `${label}.completed_at`)
    - sqliteUtcMillis(startedAt, `${label}.started_at`)
  if (!Number.isSafeInteger(elapsed) || elapsed < 0) {
    throw new Error(`${label} has an invalid elapsed time.`)
  }
  return elapsed
}

function assertIntegerOrNull(value, label) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${label} must be a non-negative integer or null.`)
  }
}

function countBy(records, key) {
  const counts = {}
  for (const record of records) {
    const value = String(record[key])
    counts[value] = (counts[value] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)))
}

function sumKnown(records, key) {
  const values = records.map((record) => record[key]).filter((value) => value !== null)
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null
}

function averageKnown(records, key) {
  const values = records.map((record) => record[key]).filter((value) => value !== null)
  return values.length
    ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3))
    : null
}

function fingerprintSourceFiles(databasePath) {
  const walPath = `${databasePath}-wal`
  return {
    databaseFileSha256: hashFile(databasePath),
    databaseBytes: statSync(databasePath).size,
    walPresent: existsSync(walPath),
    walFileSha256: existsSync(walPath) ? hashFile(walPath) : null,
    walBytes: existsSync(walPath) ? statSync(walPath).size : 0,
  }
}

function assertSameFingerprint(before, after) {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error('Source database files changed during extraction; no report was written.')
  }
}

function assertDatabaseStructure(db) {
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
  )
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    if (!tables.has(table)) throw new Error(`Required table is missing: ${table}.`)
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name))
    const missing = required.filter((column) => !columns.has(column))
    if (missing.length) {
      throw new Error(`Required columns are missing from ${table}: ${missing.join(', ')}.`)
    }
  }
}

function selectTargetSession(db) {
  const candidates = db.prepare(`
    SELECT s.id
    FROM sessions s
    JOIN agent_tool_calls t ON t.session_id = s.id
    WHERE json_extract(
      s.config_snapshot,
      '$.orchestrationPolicy.mainEditorRunMode'
    ) = 'tool_enabled'
    GROUP BY s.id
    HAVING COUNT(*) = 9
      AND SUM(t.tool_name = 'inspect_evidence' AND t.status = 'complete') = 2
      AND SUM(t.tool_name = 'request_review' AND t.status = 'complete') = 2
      AND SUM(t.tool_name = 'write_draft' AND t.status = 'failed') = 2
      AND SUM(t.tool_name = 'write_draft' AND t.status = 'complete') = 1
      AND SUM(t.tool_name = 'replace_text' AND t.status = 'complete') = 2
  `).all()
  if (candidates.length !== 1) {
    throw new Error(
      `Expected exactly one complete GPT tool-mode case, found ${candidates.length}.`,
    )
  }
  return candidates[0].id
}

function loadCoverageOnly(repoRoot, db) {
  return Object.entries(COVERAGE_ONLY_TOOLS).map(([toolName, locations]) => {
    const observedCount = db.prepare(
      'SELECT COUNT(*) AS count FROM agent_tool_calls WHERE tool_name = ?',
    ).get(toolName).count
    if (observedCount !== 0) {
      throw new Error(`${toolName} has real traces; coverage-only wording must be revised.`)
    }
    const inspect = (relativePath, kind) => {
      const filePath = path.join(repoRoot, relativePath)
      assertRegularFile(filePath, `${toolName} ${kind} file`)
      const source = readFileSync(filePath, 'utf8')
      const markerCount = source.split(toolName).length - 1
      if (markerCount < 1) throw new Error(`${relativePath} does not cover ${toolName}.`)
      return { path: relativePath.replace(/\\/g, '/'), sha256: sha256(source), markerCount }
    }
    return {
      toolName,
      realObserved: false,
      evidenceScope: 'contracts_and_tests_only',
      contracts: locations.contractLocations.map((file) => inspect(file, 'contract')),
      tests: locations.testLocations.map((file) => inspect(file, 'test')),
    }
  })
}

function loadGateState(gatePath) {
  assertRegularFile(gatePath, 'tool-use gate')
  const records = readFileSync(gatePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => parseJson(line, `tool-use gate line ${index + 1}`))
  if (records.length !== 20) {
    throw new Error(`Expected 20 tool-use gate templates, found ${records.length}.`)
  }
  const materialized = records.filter((record) => (
    typeof record.sourceText === 'string'
    && record.sourceText.length > 0
    && typeof record.initialVersion?.text === 'string'
    && record.initialVersion.text.length > 0
    && typeof record.initialVersion?.contentSha256 === 'string'
    && /^[a-f0-9]{64}$/.test(record.initialVersion.contentSha256)
    && record.formalEligible === true
  ))
  if (materialized.length !== 0) {
    throw new Error('tool-use gate now contains materialized records; this report must be redesigned.')
  }
  return {
    datasetPath: 'FSBP_Test/private/round-0820/tool-use-gate.jsonl',
    datasetSha256: hashFile(gatePath),
    recordCount: records.length,
    splitCounts: countBy(records, 'split'),
    freezeStatusCounts: countBy(records, 'freezeStatus'),
    formalEligibleCount: records.filter((record) => record.formalEligible === true).length,
    sourceMaterializedCount: records.filter(
      (record) => typeof record.sourceText === 'string' && record.sourceText.length > 0,
    ).length,
    initialVersionMaterializedCount: records.filter(
      (record) => typeof record.initialVersion?.text === 'string'
        && record.initialVersion.text.length > 0,
    ).length,
    toolUseActuallyLocked: materialized.length,
    status: 'unmaterialized_templates',
    supportsToolSuperiorityConclusion: false,
  }
}

function extractCase(db, sessionId) {
  const session = db.prepare(`
    SELECT id, source_text, task_brief, state, direction, review_mode,
      config_snapshot, final_version_id
    FROM sessions
    WHERE id = ?
  `).get(sessionId)
  if (!session) throw new Error('Target session disappeared during extraction.')
  const config = parseJson(session.config_snapshot, 'target session config_snapshot')
  if (config?.orchestrationPolicy?.mainEditorRunMode !== 'tool_enabled') {
    throw new Error('Target session is not frozen in tool_enabled mode.')
  }

  const runs = db.prepare(`
    SELECT id, kind, status, phase
    FROM orchestration_runs
    WHERE session_id = ?
    ORDER BY created_at, id
  `).all(sessionId)
  if (runs.length !== 2
    || runs[0].kind !== 'translation'
    || runs[0].status !== 'complete'
    || runs[1].kind !== 'chat_edit'
    || runs[1].status !== 'complete') {
    throw new Error('Target session does not contain the expected complete translation and chat-edit runs.')
  }
  const runById = new Map(runs.map((row) => [row.id, row]))

  const invocations = db.prepare(`
    SELECT id, parent_run_id, agent_variant_id, agent_snapshot, model, status,
      latency_ms
    FROM agent_invocations
    WHERE session_id = ?
    ORDER BY created_at, id
  `).all(sessionId)
  if (!invocations.length || invocations.some((row) => row.model !== EXPECTED_MODEL)) {
    throw new Error(`All target invocations must use ${EXPECTED_MODEL}.`)
  }
  const invocationById = new Map(invocations.map((row) => [row.id, row]))

  const rawTools = db.prepare(`
    SELECT id, run_id, invocation_id, parent_tool_call_id,
      provider_tool_call_id, logical_call_key, stage, actor, depth,
      schema_version, handler_version, tool_name, input_json, output_json,
      status, error_code, evidence_ids_json, started_at, completed_at
    FROM agent_tool_calls
    WHERE session_id = ?
    ORDER BY created_at, id
  `).all(sessionId)
  if (rawTools.length !== EXPECTED_TOOL_SEQUENCE.length) {
    throw new Error(`Expected 9 tool traces, found ${rawTools.length}.`)
  }
  rawTools.forEach((row, index) => {
    const [toolName, status] = EXPECTED_TOOL_SEQUENCE[index]
    if (row.tool_name !== toolName || row.status !== status) {
      throw new Error(`Unexpected tool trace at sequence ${index + 1}.`)
    }
    if (!row.invocation_id || !invocationById.has(row.invocation_id)) {
      throw new Error(`Tool trace ${index + 1} has no valid invocation parent.`)
    }
    const invocation = invocationById.get(row.invocation_id)
    if (!runById.has(row.run_id) || invocation.parent_run_id !== row.run_id) {
      throw new Error(`Tool trace ${index + 1} does not close across run and invocation.`)
    }
    if (row.status === 'failed' && !row.error_code) {
      throw new Error(`Failed tool trace ${index + 1} has no error classification.`)
    }
    if (row.status === 'complete' && row.error_code !== null) {
      throw new Error(`Complete tool trace ${index + 1} carries an error classification.`)
    }
  })

  const rawVersions = db.prepare(`
    SELECT id, version_no, text, source, parent_version_id, content_hash,
      created_by_patch_id
    FROM final_versions
    WHERE session_id = ?
    ORDER BY version_no, id
  `).all(sessionId)
  if (rawVersions.length !== 3
    || rawVersions.map((row) => row.source).join(',') !== 'main_draft,edit,edit') {
    throw new Error('Target version chain must contain main_draft followed by two edits.')
  }
  const versionById = new Map(rawVersions.map((row) => [row.id, row]))
  rawVersions.forEach((row, index) => {
    if (row.version_no !== index + 1) throw new Error('Version numbers are not contiguous.')
    if (!/^[a-f0-9]{64}$/.test(row.content_hash ?? '') || sha256(row.text) !== row.content_hash) {
      throw new Error(`Version ${row.version_no} content hash is missing or invalid.`)
    }
    if (index === 0 && row.parent_version_id !== null) {
      throw new Error('Initial main draft unexpectedly has a parent version.')
    }
    if (index > 0 && row.parent_version_id !== rawVersions[index - 1].id) {
      throw new Error(`Version ${row.version_no} breaks the parent hash chain.`)
    }
  })
  if (session.final_version_id !== rawVersions.at(-1).id) {
    throw new Error('Session final_version_id does not select the chain tip.')
  }

  const rawPatches = db.prepare(`
    SELECT p.id, p.base_version_id, p.result_version_id, p.old_text,
      p.new_text, p.evidence_refs_json, p.diff_spans_json
    FROM text_patches p
    JOIN final_versions v ON v.id = p.result_version_id
    WHERE p.session_id = ?
    ORDER BY v.version_no, p.id
  `).all(sessionId)
  if (rawPatches.length !== 2) throw new Error('Expected exactly two persisted text patches.')
  rawPatches.forEach((patch, index) => {
    const base = rawVersions[index]
    const result = rawVersions[index + 1]
    if (patch.base_version_id !== base.id
      || patch.result_version_id !== result.id
      || result.created_by_patch_id !== patch.id) {
      throw new Error(`Patch ${index + 1} is not linked to the expected version edge.`)
    }
    if (base.text.split(patch.old_text).length - 1 !== 1
      || base.text.replace(patch.old_text, patch.new_text) !== result.text) {
      throw new Error(`Patch ${index + 1} does not reproduce its result version exactly.`)
    }
    parseJsonArray(patch.evidence_refs_json, `patch ${index + 1} evidence_refs_json`)
    parseJsonArray(patch.diff_spans_json, `patch ${index + 1} diff_spans_json`)
  })

  const replaceTools = rawTools.filter((row) => row.tool_name === 'replace_text')
  replaceTools.forEach((tool, index) => {
    const input = parseJson(tool.input_json, `replace_text ${index + 1} input_json`)
    const output = parseJson(tool.output_json, `replace_text ${index + 1} output_json`)
    const patch = rawPatches[index]
    const result = versionById.get(patch.result_version_id)
    if (input?.old_string !== patch.old_text
      || input?.new_string !== patch.new_text
      || output?.newText !== result.text) {
      throw new Error(`replace_text trace ${index + 1} does not match its persisted patch.`)
    }
  })

  const writeTools = rawTools.filter((row) => row.tool_name === 'write_draft')
  const successfulWrite = writeTools.find((row) => row.status === 'complete')
  const successfulWriteInput = parseJson(successfulWrite.input_json, 'successful write_draft input_json')
  const successfulWriteOutput = parseJson(successfulWrite.output_json, 'successful write_draft output_json')
  if (successfulWriteOutput?.versionId !== rawVersions[0].id
    || successfulWriteOutput?.versionNo !== 1
    || successfulWriteInput?.text !== rawVersions[0].text) {
    throw new Error('Successful write_draft trace does not match main_draft version 1.')
  }
  for (const [index, failed] of writeTools.filter((row) => row.status === 'failed').entries()) {
    if (failed.output_json !== null || failed.error_code !== 'tool_execution_failed') {
      throw new Error(`Failed write_draft trace ${index + 1} has an invalid terminal record.`)
    }
  }

  const reviewChildren = []
  for (const [index, tool] of rawTools.filter((row) => row.tool_name === 'request_review').entries()) {
    const output = parseJson(tool.output_json, `request_review ${index + 1} output_json`)
    const child = invocationById.get(output?.reviewInvocationId)
    if (!child) throw new Error(`request_review ${index + 1} has no child invocation.`)
    const snapshot = parseJson(child.agent_snapshot, `review child ${index + 1} agent_snapshot`)
    if (child.agent_variant_id !== 'tool-review-subagent'
      || child.status !== 'complete'
      || snapshot?.readOnly !== true
      || snapshot?.parentToolCallId !== tool.id
      || child.parent_run_id !== tool.run_id) {
      throw new Error(`request_review ${index + 1} child is not a complete read-only child.`)
    }
    reviewChildren.push({ tool, child })
  }

  for (const [index, tool] of rawTools.filter((row) => row.tool_name === 'inspect_evidence').entries()) {
    const input = parseJson(tool.input_json, `inspect_evidence ${index + 1} input_json`)
    const output = parseJson(tool.output_json, `inspect_evidence ${index + 1} output_json`)
    if (input?.inheritanceMode !== 'body_only' || output?.inheritanceMode !== 'body_only') {
      throw new Error(`inspect_evidence ${index + 1} is not body_only.`)
    }
  }

  const rawLedger = db.prepare(`
    SELECT id, run_id, invocation_id, operation, requested_model,
      response_model, status, input_tokens, output_tokens, reasoning_tokens,
      usage_source, first_byte_ms, latency_ms, retry_count, error_code
    FROM llm_call_records
    WHERE session_id = ?
    ORDER BY created_at, id
  `).all(sessionId)
  if (!rawLedger.length
    || rawLedger.some((row) => row.requested_model !== EXPECTED_MODEL)
    || rawLedger.some((row) => row.status !== 'complete')) {
    throw new Error(`Target LLM ledger must be complete and entirely use ${EXPECTED_MODEL}.`)
  }
  for (const [index, row] of rawLedger.entries()) {
    for (const key of [
      'input_tokens', 'output_tokens', 'reasoning_tokens', 'first_byte_ms',
      'latency_ms', 'retry_count',
    ]) assertIntegerOrNull(row[key], `llm ledger ${index + 1}.${key}`)
    if (row.invocation_id !== null) {
      const invocation = invocationById.get(row.invocation_id)
      if (!invocation
        || !runById.has(row.run_id)
        || invocation.parent_run_id !== row.run_id) {
        throw new Error(`LLM ledger ${index + 1} does not close across invocation and run.`)
      }
    } else if (row.run_id !== null) {
      if (!runById.has(row.run_id)) {
        throw new Error(`LLM ledger ${index + 1} points outside the selected run set.`)
      }
    } else if (![
      'chat_revision_suggestion_target_reader',
      'chat_revision_suggestion_bilingual',
      'chat_revision_suggestion_arbiter',
    ].includes(row.operation)) {
      throw new Error(`LLM ledger ${index + 1} is an unrecognized session-scoped call.`)
    }
  }
  for (const [index, invocation] of invocations.entries()) {
    if (!runById.has(invocation.parent_run_id)) {
      throw new Error(`Invocation ${index + 1} points outside the selected run set.`)
    }
    if (!rawLedger.some((row) => (
      row.invocation_id === invocation.id && row.run_id === invocation.parent_run_id
    ))) {
      throw new Error(`Invocation ${index + 1} has no closed LLM ledger record.`)
    }
  }
  for (const [index, tool] of rawTools.entries()) {
    if (!rawLedger.some((row) => (
      row.invocation_id === tool.invocation_id && row.run_id === tool.run_id
    ))) {
      throw new Error(`Tool trace ${index + 1} has no closed LLM ledger ancestry.`)
    }
  }
  for (const [index, { child }] of reviewChildren.entries()) {
    const records = rawLedger.filter(
      (row) => row.invocation_id === child.id && row.operation === 'stage_review',
    )
    if (records.length !== 1) {
      throw new Error(`Review child ${index + 1} must have exactly one stage_review ledger record.`)
    }
  }

  const toolTraces = rawTools.map((row, index) => {
    const reviewChild = reviewChildren.find(({ tool }) => tool.id === row.id)?.child ?? null
    const evidenceRefCount = parseJsonArray(
      row.evidence_ids_json,
      `tool trace ${index + 1} evidence_ids_json`,
    ).length
    return {
      sequence: index + 1,
      toolCallIdHash: hashId('tool-call', row.id),
      runIdHash: hashId('run', row.run_id),
      invocationIdHash: hashId('invocation', row.invocation_id),
      parentToolCallIdHash: hashId('tool-call', row.parent_tool_call_id),
      providerToolCallIdHash: hashId('provider-tool-call', row.provider_tool_call_id),
      logicalCallKeyHash: hashId('logical-call-key', row.logical_call_key),
      childInvocationIdHash: hashId('invocation', reviewChild?.id),
      stage: row.stage,
      actor: row.actor,
      depth: row.depth,
      schemaVersion: row.schema_version,
      handlerVersion: row.handler_version,
      toolName: row.tool_name,
      status: row.status,
      errorCategory: row.error_code,
      readOnly: row.tool_name === 'inspect_evidence' || row.tool_name === 'request_review',
      bodyOnly: row.tool_name === 'inspect_evidence',
      evidenceRefCount,
      latencyMs: elapsedMs(row.started_at, row.completed_at, `tool trace ${index + 1}`),
    }
  })

  const ledgerRecords = rawLedger.map((row, index) => ({
    sequence: index + 1,
    llmCallIdHash: hashId('llm-call', row.id),
    runIdHash: hashId('run', row.run_id),
    invocationIdHash: hashId('invocation', row.invocation_id),
    operation: row.operation,
    requestedModel: row.requested_model,
    responseModelObserved: row.response_model !== null,
    status: row.status,
    errorCategory: row.error_code,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    usageSource: row.usage_source,
    firstByteMs: row.first_byte_ms,
    latencyMs: row.latency_ms,
    retryCount: row.retry_count,
  }))
  const byOperation = Object.keys(countBy(ledgerRecords, 'operation')).map((operation) => {
    const records = ledgerRecords.filter((row) => row.operation === operation)
    return {
      operation,
      callCount: records.length,
      statusCounts: countBy(records, 'status'),
      inputTokens: sumKnown(records, 'inputTokens'),
      outputTokens: sumKnown(records, 'outputTokens'),
      reasoningTokens: sumKnown(records, 'reasoningTokens'),
      averageFirstByteMs: averageKnown(records, 'firstByteMs'),
      averageLatencyMs: averageKnown(records, 'latencyMs'),
    }
  })

  const versions = rawVersions.map((row) => ({
    versionIdHash: hashId('version', row.id),
    versionNo: row.version_no,
    versionType: row.source,
    parentVersionIdHash: hashId('version', row.parent_version_id),
    contentSha256: row.content_hash,
    characterCount: row.text.length,
    createdByPatchIdHash: hashId('patch', row.created_by_patch_id),
  }))
  const patches = rawPatches.map((row, index) => ({
    sequence: index + 1,
    patchIdHash: hashId('patch', row.id),
    toolCallIdHash: hashId('tool-call', replaceTools[index].id),
    baseVersionIdHash: hashId('version', row.base_version_id),
    resultVersionIdHash: hashId('version', row.result_version_id),
    replacedSpanSha256: sha256(row.old_text),
    replacedSpanCharacterCount: row.old_text.length,
    replacementSpanSha256: sha256(row.new_text),
    replacementSpanCharacterCount: row.new_text.length,
    evidenceRefCount: parseJsonArray(
      row.evidence_refs_json,
      `patch ${index + 1} evidence_refs_json`,
    ).length,
    diffSpanCount: parseJsonArray(
      row.diff_spans_json,
      `patch ${index + 1} diff_spans_json`,
    ).length,
  }))
  const childInvocations = reviewChildren.map(({ tool, child }, index) => ({
    sequence: index + 1,
    invocationIdHash: hashId('invocation', child.id),
    parentToolCallIdHash: hashId('tool-call', tool.id),
    parentRunIdHash: hashId('run', child.parent_run_id),
    role: 'tool-review-subagent',
    model: child.model,
    status: child.status,
    readOnly: true,
    latencyMs: child.latency_ms,
    ledgerCallCount: rawLedger.filter((row) => row.invocation_id === child.id).length,
  }))

  return {
    identity: {
      sessionIdHash: hashId('session', session.id),
      direction: session.direction,
      state: session.state,
      reviewMode: session.review_mode,
      mainEditorRunMode: config.orchestrationPolicy.mainEditorRunMode,
      configuredModelSet: [...new Set(invocations.map((row) => row.model))].sort(),
      requestedModelSet: [...new Set(rawLedger.map((row) => row.requested_model))].sort(),
      sourceCharacterCount: session.source_text.length,
      taskBriefCharacterCount: session.task_brief.length,
      finalVersionIdHash: hashId('version', session.final_version_id),
    },
    runs: runs.map((row) => ({
      runIdHash: hashId('run', row.id),
      kind: row.kind,
      status: row.status,
      phase: row.phase,
      toolTraceCount: rawTools.filter((tool) => tool.run_id === row.id).length,
      llmLedgerCount: rawLedger.filter((call) => call.run_id === row.id).length,
    })),
    summary: {
      invocationCount: invocations.length,
      toolTraceCount: toolTraces.length,
      toolStatusCounts: countBy(toolTraces, 'status'),
      toolNameCounts: countBy(toolTraces, 'toolName'),
      failedWriteDraftBeforeSuccess: 2,
      readOnlyReviewChildCount: childInvocations.length,
      bodyOnlyInspectEvidenceCount: toolTraces.filter(
        (row) => row.toolName === 'inspect_evidence' && row.bodyOnly,
      ).length,
      replaceTextVersionEdgeCount: patches.length,
      llmCallCount: ledgerRecords.length,
      llmStatusCounts: countBy(ledgerRecords, 'status'),
      inputTokens: sumKnown(ledgerRecords, 'inputTokens'),
      outputTokens: sumKnown(ledgerRecords, 'outputTokens'),
      reasoningTokens: sumKnown(ledgerRecords, 'reasoningTokens'),
      firstByteObservedCount: ledgerRecords.filter((row) => row.firstByteMs !== null).length,
      latencyObservedCount: ledgerRecords.filter((row) => row.latencyMs !== null).length,
      responseModelObservedCount: ledgerRecords.filter(
        (row) => row.responseModelObserved,
      ).length,
      linkageClosure: {
        selectedRunCount: runs.length,
        toolToRunAndInvocationCount: rawTools.length,
        reviewParentChildCount: reviewChildren.length,
        invocationToLedgerCount: invocations.length,
        runScopedLedgerCount: rawLedger.filter((row) => row.run_id !== null).length,
        sessionScopedLedgerCount: rawLedger.filter(
          (row) => row.run_id === null && row.invocation_id === null,
        ).length,
        orphanToolCount: 0,
        orphanInvocationCount: 0,
        orphanLedgerCount: 0,
      },
    },
    toolTraces,
    reviewSubagentInvocations: childInvocations,
    llmLedger: { records: ledgerRecords, byOperation },
    versionChain: versions,
    patches,
  }
}

function collectSensitiveValues(db, sessionId) {
  const values = new Set()
  const add = (value) => {
    if (typeof value === 'string' && value.trim().length >= 8) values.add(value.trim())
  }
  const sensitiveLeafKeys = new Set([
    'annotation', 'body', 'content', 'details', 'errormessage', 'message',
    'newstring', 'newtext', 'oldstring', 'oldtext', 'prompt', 'question',
    'query', 'raw', 'reason', 'segment', 'sourcetext', 'taskbrief', 'text',
    'translation',
  ])
  const addSensitiveLeaves = (value, parentKey = '') => {
    if (Array.isArray(value)) {
      value.forEach((item) => addSensitiveLeaves(item, parentKey))
      return
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) addSensitiveLeaves(child, key)
      return
    }
    if (sensitiveLeafKeys.has(normalizeReportKey(parentKey))) add(value)
  }
  const addRows = (sql, parameters = []) => {
    for (const row of db.prepare(sql).all(...parameters)) {
      for (const value of Object.values(row)) {
        add(value)
        if (typeof value === 'string' && /^[\s]*[\[{]/.test(value)) {
          try {
            addSensitiveLeaves(JSON.parse(value))
          } catch {
            // The enclosing raw value remains protected even when legacy text is not JSON.
          }
        }
      }
    }
  }
  addRows('SELECT source_text, task_brief, config_snapshot FROM sessions WHERE id = ?', [sessionId])
  addRows(`
    SELECT raw_output, body_output, annotation_output, additional_instruction,
      selection_reason, error
    FROM agent_invocations WHERE session_id = ?
  `, [sessionId])
  addRows(`
    SELECT input_json, output_json, input_summary, output_summary, error_message
    FROM agent_tool_calls WHERE session_id = ?
  `, [sessionId])
  addRows('SELECT text FROM final_versions WHERE session_id = ?', [sessionId])
  addRows('SELECT old_text, new_text, reason FROM text_patches WHERE session_id = ?', [sessionId])
  addRows('SELECT prompt_used, raw_output, error FROM stage_outputs WHERE session_id = ?', [sessionId])
  addRows('SELECT content, tool_calls, tool_results FROM chat_messages WHERE session_id = ?', [sessionId])
  addRows('SELECT base_url, api_key FROM endpoints')
  addRows('SELECT content_json FROM project_resource_revisions')
  addRows('SELECT content_json FROM project_memory_suggestions')
  return [...values]
}

function normalizeReportKey(key) {
  return String(key).normalize('NFKC').replace(/[\s_-]+/g, '').toLowerCase()
}

function assertNoForbiddenKeys(value, location = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, `${location}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_NORMALIZED_REPORT_KEYS.has(normalizeReportKey(key))) {
      throw new Error(`Sanitization rejected forbidden report key at ${location}.${key}.`)
    }
    assertNoForbiddenKeys(child, `${location}.${key}`)
  }
}

export function assertSanitizedArtifact(report, markdown, sensitiveValues = []) {
  assertNoForbiddenKeys(report)
  const serialized = `${JSON.stringify(report)}\n${markdown}`
  for (const pattern of SUSPECT_CREDENTIAL_PATTERNS) {
    if (pattern.test(serialized)) {
      throw new Error(`Sanitization rejected suspect credential or endpoint pattern: ${pattern}.`)
    }
  }
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.test(serialized)) {
    throw new Error('Sanitization rejected an unhashed UUID.')
  }
  for (const sensitive of sensitiveValues) {
    const normalizedSensitive = sensitive.replace(/\s+/g, ' ').trim()
    const normalizedSerialized = serialized.replace(/\s+/g, ' ')
    if (serialized.includes(sensitive)
      || (normalizedSensitive.length >= 12 && normalizedSerialized.includes(normalizedSensitive))) {
      throw new Error('Sanitization rejected protected database text in the report.')
    }
  }
}

function localRef(rootSchema, reference) {
  if (!reference.startsWith('#/')) throw new Error(`Unsupported schema reference: ${reference}.`)
  return reference.slice(2).split('/').reduce((value, token) => {
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!value || typeof value !== 'object' || !(key in value)) {
      throw new Error(`Unresolved schema reference: ${reference}.`)
    }
    return value[key]
  }, rootSchema)
}

function describeSchemaLocation(location, message) {
  throw new Error(`Report schema validation failed at ${location}: ${message}`)
}

export function validateJsonSchemaValue(value, schema, rootSchema = schema, location = '$') {
  if (schema.$ref) {
    validateJsonSchemaValue(value, localRef(rootSchema, schema.$ref), rootSchema, location)
    return
  }
  if (schema.anyOf) {
    const accepted = schema.anyOf.some((candidate) => {
      try {
        validateJsonSchemaValue(value, candidate, rootSchema, location)
        return true
      } catch {
        return false
      }
    })
    if (!accepted) describeSchemaLocation(location, 'no anyOf branch accepted the value.')
    return
  }
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    describeSchemaLocation(location, 'value differs from const.')
  }
  if (schema.enum && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    describeSchemaLocation(location, 'value is outside enum.')
  }
  if (schema.type === 'null') {
    if (value !== null) describeSchemaLocation(location, 'expected null.')
    return
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      describeSchemaLocation(location, 'expected object.')
    }
    for (const key of schema.required ?? []) {
      if (!(key in value)) describeSchemaLocation(location, `missing required key ${key}.`)
    }
    const properties = schema.properties ?? {}
    if (schema.additionalProperties === false) {
      const extras = Object.keys(value).filter((key) => !(key in properties))
      if (extras.length) describeSchemaLocation(location, `unexpected keys: ${extras.join(', ')}.`)
    }
    for (const [key, child] of Object.entries(value)) {
      if (properties[key]) {
        validateJsonSchemaValue(child, properties[key], rootSchema, `${location}.${key}`)
      }
    }
    return
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) describeSchemaLocation(location, 'expected array.')
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      describeSchemaLocation(location, `expected at least ${schema.minItems} items.`)
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      describeSchemaLocation(location, `expected at most ${schema.maxItems} items.`)
    }
    if (schema.uniqueItems
      && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      describeSchemaLocation(location, 'expected unique items.')
    }
    if (schema.items) {
      value.forEach((item, index) => {
        validateJsonSchemaValue(item, schema.items, rootSchema, `${location}[${index}]`)
      })
    }
    return
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') describeSchemaLocation(location, 'expected string.')
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      describeSchemaLocation(location, `expected minLength ${schema.minLength}.`)
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      describeSchemaLocation(location, `value does not match ${schema.pattern}.`)
    }
    if (schema.format === 'date-time' && !Number.isFinite(Date.parse(value))) {
      describeSchemaLocation(location, 'expected date-time.')
    }
    return
  }
  if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value)) describeSchemaLocation(location, 'expected safe integer.')
  } else if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      describeSchemaLocation(location, 'expected finite number.')
    }
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') {
    describeSchemaLocation(location, 'expected boolean.')
  }
  if (schema.minimum !== undefined && value < schema.minimum) {
    describeSchemaLocation(location, `expected minimum ${schema.minimum}.`)
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    describeSchemaLocation(location, `expected maximum ${schema.maximum}.`)
  }
}

function assertSchemaObjectsClosed(schema, location = '$') {
  if (!schema || typeof schema !== 'object') return
  if (schema.type === 'object' && schema.additionalProperties !== false) {
    throw new Error(`Report schema object is not fail-closed at ${location}.`)
  }
  for (const [key, child] of Object.entries(schema)) {
    if (key === 'const' || key === 'enum') continue
    if (Array.isArray(child)) {
      child.forEach((item, index) => assertSchemaObjectsClosed(item, `${location}.${key}[${index}]`))
    } else if (child && typeof child === 'object') {
      assertSchemaObjectsClosed(child, `${location}.${key}`)
    }
  }
}

export function assertReportSchema(report, schemaPath) {
  const schema = parseJson(readFileSync(schemaPath, 'utf8'), 'tool evidence report schema')
  assertSchemaObjectsClosed(schema)
  validateJsonSchemaValue(report, schema)
}

export function validateCompleteReport(report) {
  if (report.schemaVersion !== REPORT_SCHEMA_VERSION || report.reportStatus !== 'complete') {
    throw new Error('Report schema or terminal status is invalid.')
  }
  const { summary } = report.caseStudy
  if (summary.toolTraceCount !== 9
    || summary.toolStatusCounts.complete !== 7
    || summary.toolStatusCounts.failed !== 2
    || summary.failedWriteDraftBeforeSuccess !== 2
    || summary.readOnlyReviewChildCount !== 2
    || summary.bodyOnlyInspectEvidenceCount !== 2
    || summary.replaceTextVersionEdgeCount !== 2) {
    throw new Error('Case-study summary is incomplete.')
  }
  if (JSON.stringify(report.caseStudy.identity.configuredModelSet) !== JSON.stringify([EXPECTED_MODEL])
    || JSON.stringify(report.caseStudy.identity.requestedModelSet) !== JSON.stringify([EXPECTED_MODEL])) {
    throw new Error('Configured/requested model evidence is incomplete.')
  }
  const closure = summary.linkageClosure
  if (!closure
    || closure.selectedRunCount !== 2
    || closure.toolToRunAndInvocationCount !== 9
    || closure.reviewParentChildCount !== 2
    || closure.invocationToLedgerCount !== summary.invocationCount
    || closure.runScopedLedgerCount + closure.sessionScopedLedgerCount !== summary.llmCallCount
    || closure.orphanToolCount !== 0
    || closure.orphanInvocationCount !== 0
    || closure.orphanLedgerCount !== 0) {
    throw new Error('Cross-table linkage closure is incomplete.')
  }
  if (report.gateMaterialization.recordCount !== 20
    || report.gateMaterialization.toolUseActuallyLocked !== 0
    || report.gateMaterialization.supportsToolSuperiorityConclusion !== false) {
    throw new Error('Tool-use gate boundary is not represented truthfully.')
  }
  if (report.coverageOnly.some((record) => record.realObserved !== false)) {
    throw new Error('Coverage-only tools cannot be marked as real observations.')
  }
}

function formatNullable(value) {
  return value === null ? '—' : String(value)
}

function markdownFromReport(report) {
  const { caseStudy, gateMaterialization, coverageOnly } = report
  const lines = [
    '# Round-0820 工具调用真实案例证据',
    '',
    '## 结论与证据边界',
    '',
    `本报告从本地 \`data/app.db\` 的只读快照中物化出一条 GPT 工具模式真实案例。主会话的配置模型集合与物理请求模型集合均为 \`${caseStudy.identity.requestedModelSet.join(', ')}\`，共保留 ${caseStudy.summary.toolTraceCount} 条工具 trace，其中 ${caseStudy.summary.toolStatusCounts.complete} 条成功、${caseStudy.summary.toolStatusCounts.failed} 条失败。顺序证据完整覆盖两次 \`write_draft\` 失败后的成功提交、两次只读 \`request_review\` 子调用、两次 \`body_only\` 的 \`inspect_evidence\`，以及两次 \`replace_text\` 形成的连续版本边。`,
    '',
    `这份材料可以证明工具基础设施在一条真实端到端路径中完成了调用、失败留痕、只读子代理、证据继承、LLM 台账与版本链闭合。它不能支持工具优越性结论。当前 \`tool-use-gate.jsonl\` 的 ${gateMaterialization.recordCount} 条记录仍是未物化模板，\`toolUseActuallyLocked=${gateMaterialization.toolUseActuallyLocked}\`，没有可用于组间质量或成功率比较的正式工具实验样本。`,
    '',
    '## 真实调用链',
    '',
    '| 序号 | 工具 | 状态 | 错误分类 | 只读 | body_only | 时延 ms | 证据引用数 | 子调用 |',
    '| ---: | --- | --- | --- | :---: | :---: | ---: | ---: | --- |',
  ]
  for (const trace of caseStudy.toolTraces) {
    lines.push(
      `| ${trace.sequence} | \`${trace.toolName}\` | ${trace.status} | ${formatNullable(trace.errorCategory)} | ${trace.readOnly ? '是' : '否'} | ${trace.bodyOnly ? '是' : '否'} | ${trace.latencyMs} | ${trace.evidenceRefCount} | ${trace.childInvocationIdHash ? `\`${trace.childInvocationIdHash.slice(0, 12)}…\`` : '—'} |`,
    )
  }
  lines.push(
    '',
    `两次复核子调用都保存了父工具关联和 \`readOnly=true\`，子调用时延分别为 ${caseStudy.reviewSubagentInvocations.map((row) => `${row.latencyMs} ms`).join('、')}。工具失败只保留 \`tool_execution_failed\` 分类，报告未带出错误正文、工具参数或工具结果。`,
    '',
    '## LLM 台账与版本链',
    '',
    `同一 session 的物理 LLM 台账共有 ${caseStudy.summary.llmCallCount} 条，状态分布为 ${Object.entries(caseStudy.summary.llmStatusCounts).map(([key, count]) => `${key}=${count}`).join('、')}。可用量用字段合计输入 ${formatNullable(caseStudy.summary.inputTokens)} tokens、输出 ${formatNullable(caseStudy.summary.outputTokens)} tokens、推理 ${formatNullable(caseStudy.summary.reasoningTokens)} tokens；首包和总时延分别有 ${caseStudy.summary.firstByteObservedCount} 条与 ${caseStudy.summary.latencyObservedCount} 条可用记录。18 条记录的 \`response_model\` 均未返回，因此这份数据库证据只能确认配置模型与请求模型，无法独立确认上游实际执行模型。下表按 operation 聚合，单条脱敏台账保存在同名 JSON 中。`,
    '',
    '| operation | 调用数 | 输入 tokens | 输出 tokens | 平均首包 ms | 平均总时延 ms |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  )
  for (const operation of caseStudy.llmLedger.byOperation) {
    lines.push(
      `| \`${operation.operation}\` | ${operation.callCount} | ${formatNullable(operation.inputTokens)} | ${formatNullable(operation.outputTokens)} | ${formatNullable(operation.averageFirstByteMs)} | ${formatNullable(operation.averageLatencyMs)} |`,
    )
  }
  lines.push(
    '',
    '| 版本 | 类型 | 父版本 hash | 内容 SHA-256 | 字符数 | 生成补丁 hash |',
    '| ---: | --- | --- | --- | ---: | --- |',
  )
  for (const version of caseStudy.versionChain) {
    lines.push(
      `| ${version.versionNo} | \`${version.versionType}\` | ${version.parentVersionIdHash ? `\`${version.parentVersionIdHash.slice(0, 12)}…\`` : '—'} | \`${version.contentSha256}\` | ${version.characterCount} | ${version.createdByPatchIdHash ? `\`${version.createdByPatchIdHash.slice(0, 12)}…\`` : '—'} |`,
    )
  }
  lines.push(
    '',
    '两个 `replace_text` trace 已逐项核对其输入跨度、持久化 patch、父版本、结果版本和输出版本；脚本只导出跨度 hash、长度、diff 计数与版本 hash。任何一条边无法精确重放时，生成过程都会失败。',
    '',
    `跨表闭合结果为：tool→run/invocation ${caseStudy.summary.linkageClosure.toolToRunAndInvocationCount}/${caseStudy.summary.toolTraceCount}，review parent→child ${caseStudy.summary.linkageClosure.reviewParentChildCount}/2，invocation→ledger ${caseStudy.summary.linkageClosure.invocationToLedgerCount}/${caseStudy.summary.invocationCount}；tool、invocation、ledger 的孤儿记录数均为 0。另有 ${caseStudy.summary.linkageClosure.sessionScopedLedgerCount} 条双空外键的会话级修订建议调用，operation 已限定在三种允许值内。`,
    '',
    '## 尚未真实观察的工具与 20 条模板',
    '',
    '下列三种工具在当前数据库中没有真实 trace。报告只登记合同和测试覆盖，`realObserved=false`；后续需要独立物化正式样本，才能形成工具使用率、成功率或质量差异数据。',
    '',
    '| 工具 | realObserved | 合同文件数 | 测试文件数 |',
    '| --- | :---: | ---: | ---: |',
  )
  for (const item of coverageOnly) {
    lines.push(`| \`${item.toolName}\` | false | ${item.contracts.length} | ${item.tests.length} |`)
  }
  lines.push(
    '',
    `20 条 tool-use-gate 模板的 split 分布为 ${Object.entries(gateMaterialization.splitCounts).map(([key, count]) => `${key}=${count}`).join('、')}，source 已物化 ${gateMaterialization.sourceMaterializedCount} 条，初始版本已物化 ${gateMaterialization.initialVersionMaterializedCount} 条，formalEligible ${gateMaterialization.formalEligibleCount} 条。状态保持 \`${gateMaterialization.status}\`。`,
    '',
    '## 可复现口径与隐私校验',
    '',
    `提取时间为 \`${report.provenance.extractedAt}\`，成对发布 generation 为 \`${report.provenance.generationId}\`，脚本版本为 \`${report.provenance.scriptVersion}\`，脚本 SHA-256 为 \`${report.provenance.scriptSha256}\`。源数据库文件 SHA-256 为 \`${report.provenance.sourceDatabase.databaseFileSha256}\`；WAL ${report.provenance.sourceDatabase.walPresent ? `存在，SHA-256 为 \`${report.provenance.sourceDatabase.walFileSha256}\`` : '不存在'}。查询在 SQLite 只读事务中完成，并在事务前后复核数据库与 WAL 指纹一致；同目录 pair manifest 最后提交，记录 JSON/Markdown 的 generation、字节数与 SHA-256。`,
    '',
    '生成器要求目标表与字段齐全、目标会话唯一、九条 trace 顺序精确、两名复核子代理只读、两条 inspect 为 body_only、三段版本内容 hash 有效、两个 patch 可精确重放、全部 LLM 台账属于同一 GPT 模型。输出还会扫描原文、译文、prompt、工具参数与结果、endpoint URL、凭据、项目记忆正文、裸 UUID 和疑似 Key 模式；任一校验失败都会阻止成功报告写入。',
    '',
  )
  return lines.join('\n')
}

function writeDurable(filePath, value) {
  writeFileSync(filePath, value, { encoding: 'utf8', flag: 'wx' })
  const descriptor = openSync(filePath, 'r+')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

/**
 * @typedef {object} PublishReportPairOptions
 * @property {string} jsonOutput
 * @property {string} markdownOutput
 * @property {string} pairManifestOutput
 * @property {string} jsonText
 * @property {string} markdownText
 * @property {string} pairManifestText
 * @property {string} generationId
 * @property {string|string[]|null} [failureInjectionStep]
 */

/**
 * @param {PublishReportPairOptions} options
 */
export function publishReportPairAtomically({
  jsonOutput,
  markdownOutput,
  pairManifestOutput,
  jsonText,
  markdownText,
  pairManifestText,
  generationId,
  failureInjectionStep = null,
}) {
  if (!/^[a-f0-9]{32}$/.test(generationId)) {
    throw new Error('generationId must be 32 lowercase hexadecimal characters.')
  }
  const targets = [jsonOutput, markdownOutput, pairManifestOutput]
  if (new Set(targets.map(normalizeComparablePath)).size !== targets.length) {
    throw new Error('Atomic pair targets must be distinct.')
  }
  const payloads = [jsonText, markdownText, pairManifestText]
  const staging = targets.map((target) => `${target}.${generationId}.staged`)
  const backups = targets.map((target) => `${target}.${generationId}.backup`)
  const backedUp = targets.map(() => false)
  const published = targets.map(() => false)
  const shouldInject = (step) => Array.isArray(failureInjectionStep)
    ? failureInjectionStep.includes(step)
    : failureInjectionStep === step
  const inject = (step) => {
    if (shouldInject(step)) throw new Error(`Injected publish failure at ${step}.`)
  }
  for (const filePath of [...staging, ...backups]) rmSync(filePath, { force: true })
  let committed = false
  try {
    payloads.forEach((payload, index) => writeDurable(staging[index], payload))
    inject('after-staging')
    targets.forEach((target, index) => {
      if (existsSync(target)) {
        renameSync(target, backups[index])
        backedUp[index] = true
      }
    })
    inject('after-backup')
    for (let index = 0; index < targets.length; index += 1) {
      renameSync(staging[index], targets[index])
      published[index] = true
      inject([
        'after-json-publish',
        'after-markdown-publish',
        'after-manifest-publish',
      ][index])
    }
    committed = true
  } catch (error) {
    const rollbackErrors = []
    const manualRecoveryPaths = []
    for (let index = targets.length - 1; index >= 0; index -= 1) {
      try {
        if (published[index] && existsSync(targets[index])) {
          rmSync(targets[index], { force: true })
        }
        if (backedUp[index] && existsSync(backups[index])) {
          if (shouldInject('rollback-restore-failure') && index === 0) {
            throw new Error('Injected rollback restore failure.')
          }
          renameSync(backups[index], targets[index])
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError))
        if (backedUp[index] && existsSync(backups[index])) {
          manualRecoveryPaths.push(path.resolve(backups[index]))
        }
      }
    }
    const stagingCleanupErrors = []
    for (const filePath of staging) {
      try {
        rmSync(filePath, { force: true })
      } catch (cleanupError) {
        stagingCleanupErrors.push(
          `${path.resolve(filePath)}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        )
      }
    }
    if (rollbackErrors.length) {
      throw new Error(
        [
          `Atomic report-pair publication failed: ${error instanceof Error ? error.message : String(error)}.`,
          `Rollback was incomplete: ${rollbackErrors.join('; ')}.`,
          manualRecoveryPaths.length
            ? `Preserved backup(s) for manual recovery: ${manualRecoveryPaths.join(', ')}.`
            : '',
          stagingCleanupErrors.length
            ? `Staging cleanup also failed: ${stagingCleanupErrors.join('; ')}.`
            : '',
        ].filter(Boolean).join(' '),
        { cause: error },
      )
    }
    if (stagingCleanupErrors.length) {
      throw new Error(
        `Atomic report-pair publication failed: ${error instanceof Error ? error.message : String(error)}. `
          + `Staging cleanup also failed: ${stagingCleanupErrors.join('; ')}.`,
        { cause: error },
      )
    }
    throw error
  }
  if (!committed) throw new Error('Atomic report pair did not reach its commit point.')

  const cleanupWarnings = []
  for (let index = 0; index < backups.length; index += 1) {
    const backup = backups[index]
    if (!existsSync(backup)) continue
    try {
      if (shouldInject('backup-cleanup-failure') && index === 0) {
        throw new Error('Injected backup cleanup failure.')
      }
      rmSync(backup, { force: true })
    } catch (cleanupError) {
      cleanupWarnings.push(
        `Committed report pair retained backup ${path.resolve(backup)}: `
          + `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      )
    }
  }
  for (const filePath of staging) {
    try {
      rmSync(filePath, { force: true })
    } catch (cleanupError) {
      cleanupWarnings.push(
        `Committed report pair retained staging file ${path.resolve(filePath)}: `
          + `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      )
    }
  }
  return { committed: true, cleanupWarnings }
}

export function materializeToolEvidence({
  repoRoot,
  databasePath,
  gatePath,
  schemaPath,
  jsonOutput,
  markdownOutput,
  pairManifestOutput,
  failureInjectionStep = null,
}) {
  const secured = assertFixedMaterializationPaths({
    repoRoot,
    databasePath,
    gatePath,
    schemaPath,
    jsonOutput,
    markdownOutput,
    pairManifestOutput,
  })
  repoRoot = secured.repoRoot
  databasePath = secured.databasePath
  gatePath = secured.gatePath
  schemaPath = secured.schemaPath
  jsonOutput = secured.jsonOutput
  markdownOutput = secured.markdownOutput
  pairManifestOutput = secured.pairManifestOutput
  const scriptPath = fileURLToPath(import.meta.url)
  const sourceBefore = fingerprintSourceFiles(databasePath)
  const extractedAt = new Date().toISOString()
  const generationId = randomBytes(16).toString('hex')
  const db = new Database(databasePath, { readonly: true, fileMustExist: true })
  let report
  let sensitiveValues
  try {
    db.pragma('query_only = ON')
    const extract = db.transaction(() => {
      assertDatabaseStructure(db)
      const sessionId = selectTargetSession(db)
      const caseStudy = extractCase(db, sessionId)
      const coverageOnly = loadCoverageOnly(repoRoot, db)
      const gateMaterialization = loadGateState(gatePath)
      return {
        sessionId,
        caseStudy,
        coverageOnly,
        gateMaterialization,
        sensitiveValues: collectSensitiveValues(db, sessionId),
      }
    })
    const extracted = extract()
    sensitiveValues = extracted.sensitiveValues
    report = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      reportStatus: 'complete',
      roundId: 'round-0820',
      evidenceType: 'single_real_end_to_end_tool_case',
      provenance: {
        extractedAt,
        generationId,
        scriptVersion: SCRIPT_VERSION,
        scriptSha256: hashFile(scriptPath),
        schemaPath: path.relative(repoRoot, schemaPath).replace(/\\/g, '/'),
        schemaSha256: hashFile(schemaPath),
        hashNamespace: HASH_NAMESPACE,
        queryScope: 'one unique complete GPT tool-enabled session; all session tool traces, LLM ledger records, review children, runs, versions, and patches',
        sourceDatabase: {
          path: path.relative(repoRoot, databasePath).replace(/\\/g, '/'),
          ...sourceBefore,
          fileSetSha256: sha256(JSON.stringify(sourceBefore)),
        },
      },
      caseStudy: extracted.caseStudy,
      coverageOnly: extracted.coverageOnly,
      gateMaterialization: extracted.gateMaterialization,
      conclusionBoundary: {
        provesInfrastructure: true,
        provesOneRealEndToEndCase: true,
        supportsToolSuperiorityConclusion: false,
        basis: 'The formal 20-item tool-use gate has zero materialized and locked items.',
      },
      privacy: {
        rawSourceIncluded: false,
        translationIncluded: false,
        promptIncluded: false,
        fullToolArgumentsIncluded: false,
        fullToolResultsIncluded: false,
        endpointUrlIncluded: false,
        credentialIncluded: false,
        projectMemoryBodyIncluded: false,
        rawStableIdsIncluded: false,
      },
    }
  } finally {
    db.close()
  }
  const sourceAfter = fingerprintSourceFiles(databasePath)
  assertSameFingerprint(sourceBefore, sourceAfter)
  validateCompleteReport(report)
  const markdown = markdownFromReport(report)
  assertSanitizedArtifact(report, markdown, sensitiveValues)
  assertReportSchema(report, schemaPath)
  const jsonText = `${JSON.stringify(report, null, 2)}\n`
  const markdownText = `${markdown}\n`
  const pairManifest = {
    schemaVersion: PAIR_MANIFEST_SCHEMA_VERSION,
    status: 'complete',
    generationId,
    generatedAt: extractedAt,
    sourceDatabaseFileSetSha256: report.provenance.sourceDatabase.fileSetSha256,
    scriptSha256: report.provenance.scriptSha256,
    schemaSha256: report.provenance.schemaSha256,
    artifacts: {
      json: {
        path: path.relative(repoRoot, jsonOutput).replace(/\\/g, '/'),
        sha256: sha256(jsonText),
        bytes: Buffer.byteLength(jsonText),
      },
      markdown: {
        path: path.relative(repoRoot, markdownOutput).replace(/\\/g, '/'),
        sha256: sha256(markdownText),
        bytes: Buffer.byteLength(markdownText),
      },
    },
  }
  const pairManifestText = `${JSON.stringify(pairManifest, null, 2)}\n`
  assertSanitizedArtifact(pairManifest, pairManifestText)
  const publication = publishReportPairAtomically({
    jsonOutput,
    markdownOutput,
    pairManifestOutput,
    jsonText,
    markdownText,
    pairManifestText,
    generationId,
    failureInjectionStep,
  })
  if (publication.cleanupWarnings.length) {
    process.stderr.write(`${publication.cleanupWarnings.join('\n')}\n`)
  }
  return report
}

async function main() {
  const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
  if (process.argv.length !== 2) {
    throw new Error('This evidence materializer has fixed inputs and outputs; arguments are rejected.')
  }
  const databasePath = path.join(repoRoot, 'data', 'app.db')
  const gatePath = path.join(
    repoRoot,
    'FSBP_Test/private/round-0820/tool-use-gate.jsonl',
  )
  const schemaPath = path.join(
    repoRoot,
    'FSBP_Test/schemas/round-0820-tool-evidence-case-study.schema.json',
  )
  const jsonOutput = path.join(
    repoRoot,
    'FSBP_Test/private/round-0820/reports/tool-evidence-case-study.json',
  )
  const markdownOutput = path.join(
    repoRoot,
    'FSBP_Test/private/round-0820/reports/tool-evidence-case-study.md',
  )
  const pairManifestOutput = path.join(
    repoRoot,
    'FSBP_Test/private/round-0820/reports/tool-evidence-case-study.pair.json',
  )
  const report = materializeToolEvidence({
    repoRoot,
    databasePath,
    gatePath,
    schemaPath,
    jsonOutput,
    markdownOutput,
    pairManifestOutput,
  })
  process.stdout.write(`${JSON.stringify({
    status: report.reportStatus,
    jsonOutput: path.relative(repoRoot, jsonOutput).replace(/\\/g, '/'),
    markdownOutput: path.relative(repoRoot, markdownOutput).replace(/\\/g, '/'),
    pairManifestOutput: path.relative(repoRoot, pairManifestOutput).replace(/\\/g, '/'),
    databaseFileSha256: report.provenance.sourceDatabase.databaseFileSha256,
    toolTraceCount: report.caseStudy.summary.toolTraceCount,
    toolStatusCounts: report.caseStudy.summary.toolStatusCounts,
    llmCallCount: report.caseStudy.summary.llmCallCount,
    versionCount: report.caseStudy.versionChain.length,
    toolUseActuallyLocked: report.gateMaterialization.toolUseActuallyLocked,
  }, null, 2)}\n`)
}

const isEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isEntrypoint) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
