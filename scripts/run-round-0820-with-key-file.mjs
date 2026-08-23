import { spawn } from 'node:child_process'
import { lstat, open, readFile, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from './round-0820-lib.mjs'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptDirectory, '..')
const runner = path.join(scriptDirectory, 'run-round-0820.mjs')
const EXPERIMENT_API_KEY_ENV = 'FSBP_EXPERIMENT_API_KEY'

export function normalizeConnectionBase(value) {
  if (typeof value !== 'string' || !value) {
    throw new Error('Connection JSON must contain a nonempty url.')
  }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Connection JSON url must be an absolute HTTPS URL.')
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Connection JSON url must use HTTPS.')
  }
  if (
    parsed.username || parsed.password || parsed.search || parsed.hash ||
    value.includes('?') || value.includes('#')
  ) {
    throw new Error(
      'Connection JSON url must not contain credentials, a query, or a fragment.',
    )
  }
  return parsed.href.replace(/\/+$/, '')
}

export function parseKeyFileContents(contents, { requireConnectionJson = false } = {}) {
  if (typeof contents !== 'string') {
    throw new Error('Key file contents must be text.')
  }
  const text = contents.replace(/^\uFEFF/, '').trim()
  if (!text) throw new Error('Key file is empty.')
  if (!text.startsWith('{')) {
    if (requireConnectionJson) {
      throw new Error('Key file must contain a NewAPI connection JSON object.')
    }
    return { apiKey: text, connectionBase: null }
  }

  let connection
  try {
    connection = JSON.parse(text)
  } catch {
    throw new Error('Key file connection JSON is invalid.')
  }
  if (
    !connection || Array.isArray(connection) ||
    typeof connection !== 'object' ||
    connection._type !== 'newapi_channel_conn'
  ) {
    throw new Error('Key file connection JSON has an unsupported type.')
  }
  if (typeof connection.key !== 'string' || !connection.key.trim()) {
    throw new Error('Connection JSON must contain a nonempty key.')
  }
  return {
    apiKey: connection.key.trim(),
    connectionBase: normalizeConnectionBase(connection.url),
  }
}

export function assertConnectionMatchesFreezeEndpoint(connectionBase, endpoint) {
  if (connectionBase === null) return
  if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) {
    throw new Error('Freeze manifest does not contain a valid endpoint snapshot.')
  }
  let frozenBase
  try {
    frozenBase = normalizeConnectionBase(endpoint.baseUrl)
  } catch {
    throw new Error('Freeze manifest endpoint must be an absolute HTTPS URL.')
  }
  if (normalizeConnectionBase(connectionBase) !== frozenBase) {
    throw new Error(
      'Connection JSON url does not match the frozen experiment endpoint.',
    )
  }
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (
    relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function lexicalCredentialLocation(
  keyFile,
  selectedRepositoryRoot = repositoryRoot,
  {
    actualRepositoryRoot = repositoryRoot,
    osTemporaryRoot = os.tmpdir(),
  } = {},
) {
  const lexicalFile = path.resolve(keyFile)
  const lexicalSelectedRoot = path.resolve(selectedRepositoryRoot)
  const lexicalActualRoot = path.resolve(actualRepositoryRoot)
  const lexicalTemporaryRoot = path.resolve(osTemporaryRoot)
  // Fail fast for the ordinary same-spelling case. The opened-handle checks below
  // remain authoritative for Windows long/8.3 aliases and reparse paths.
  if (
    isPathInside(lexicalSelectedRoot, lexicalFile) ||
    isPathInside(lexicalActualRoot, lexicalFile)
  ) {
    throw new Error('Experiment credential files must be outside the repository.')
  }
  return {
    lexicalFile,
    lexicalSelectedRoot,
    lexicalActualRoot,
    lexicalTemporaryRoot,
  }
}

async function assertNoReparsePathToTemporaryRoot(lexicalFile, temporaryRootInfo) {
  let cursor = path.dirname(lexicalFile)
  while (true) {
    const lexicalInfo = await lstat(cursor)
    if (lexicalInfo.isSymbolicLink()) {
      throw new Error('Experiment credential path must not contain reparse links.')
    }
    const followedInfo = await stat(cursor, { bigint: true })
    if (
      followedInfo.dev === temporaryRootInfo.dev &&
      followedInfo.ino === temporaryRootInfo.ino
    ) {
      return
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) {
      throw new Error('Experiment credential file must be inside the OS temporary directory.')
    }
    cursor = parent
  }
}

async function validateOpenedCredentialHandle(handle, location) {
  const {
    lexicalFile,
    lexicalSelectedRoot,
    lexicalActualRoot,
    lexicalTemporaryRoot,
  } = location
  let lexicalFileInfo
  try {
    lexicalFileInfo = await lstat(lexicalFile)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('Experiment credential file does not exist.')
    }
    throw new Error('Experiment credential path could not be inspected safely.')
  }
  if (lexicalFileInfo.isSymbolicLink() || !lexicalFileInfo.isFile()) {
    throw new Error('Experiment credential path must be a regular non-link file.')
  }
  let realFile
  let realSelectedRoot
  let realActualRoot
  let realTemporaryRoot
  try {
    ;[realFile, realSelectedRoot, realActualRoot, realTemporaryRoot] = await Promise.all([
      realpath(lexicalFile),
      realpath(lexicalSelectedRoot),
      realpath(lexicalActualRoot),
      realpath(lexicalTemporaryRoot),
    ])
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('Experiment credential file does not exist.')
    }
    throw new Error('Experiment credential path could not be resolved safely.')
  }
  if (
    isPathInside(realSelectedRoot, realFile) ||
    isPathInside(realActualRoot, realFile)
  ) {
    throw new Error('Experiment credential files must be outside the repository.')
  }
  if (!isPathInside(realTemporaryRoot, realFile)) {
    throw new Error('Experiment credential file must be inside the OS temporary directory.')
  }
  const [openedFileInfo, realFileInfo, temporaryRootInfo] = await Promise.all([
    handle.stat({ bigint: true }),
    stat(realFile, { bigint: true }),
    stat(realTemporaryRoot, { bigint: true }),
  ])
  if (
    !openedFileInfo.isFile() || openedFileInfo.nlink !== 1n ||
    !realFileInfo.isFile() || realFileInfo.nlink !== 1n
  ) {
    throw new Error('Experiment credential file must be a single-link regular file.')
  }
  if (
    openedFileInfo.dev !== realFileInfo.dev ||
    openedFileInfo.ino !== realFileInfo.ino
  ) {
    throw new Error('Experiment credential path changed while it was being opened.')
  }
  await assertNoReparsePathToTemporaryRoot(lexicalFile, temporaryRootInfo)
  return realFile
}

export async function withValidatedCredentialHandle(
  keyFile,
  selectedRepositoryRoot = repositoryRoot,
  options = {},
  consume,
) {
  const location = lexicalCredentialLocation(
    keyFile,
    selectedRepositoryRoot,
    options,
  )
  let handle
  let lexicalFileInfo
  try {
    lexicalFileInfo = await lstat(location.lexicalFile)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('Experiment credential file does not exist.')
    }
    throw new Error('Experiment credential path could not be inspected safely.')
  }
  if (lexicalFileInfo.isSymbolicLink() || !lexicalFileInfo.isFile()) {
    throw new Error('Experiment credential path must be a regular non-link file.')
  }
  try {
    handle = await open(location.lexicalFile, 'r')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('Experiment credential file does not exist.')
    }
    throw new Error('Experiment credential file could not be opened safely.')
  }
  try {
    const realFile = await validateOpenedCredentialHandle(handle, location)
    return await consume(handle, realFile)
  } finally {
    await handle.close()
  }
}

export async function assertExternalCredentialPath(
  keyFile,
  selectedRepositoryRoot = repositoryRoot,
  options = {},
) {
  return withValidatedCredentialHandle(
    keyFile,
    selectedRepositoryRoot,
    options,
    async (_handle, realFile) => realFile,
  )
}

export async function readExperimentCredential(
  keyFile,
  endpoint,
  _readText = readFile,
  { selectedRepositoryRoot = repositoryRoot } = {},
) {
  const contents = await withValidatedCredentialHandle(
    keyFile,
    selectedRepositoryRoot,
    {},
    async (handle) => handle.readFile({ encoding: 'utf8' }),
  )
  let credential
  try {
    credential = parseKeyFileContents(contents, { requireConnectionJson: true })
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : 'Experiment credential file could not be parsed.',
    )
  }
  assertConnectionMatchesFreezeEndpoint(credential.connectionBase, endpoint)
  return credential
}

export function redactCredentialText(value, sensitiveValues = []) {
  let redacted = typeof value === 'string' ? value : String(value)
  for (const sensitiveValue of sensitiveValues) {
    if (typeof sensitiveValue !== 'string' || sensitiveValue.length < 4) continue
    redacted = redacted.split(sensitiveValue).join('[REDACTED_CREDENTIAL]')
  }
  redacted = redacted
    .replace(/\bBearer\s+[^\s"'`,;)}\]]+/gi, 'Bearer [REDACTED_CREDENTIAL]')
    .replace(/\bsk-[A-Za-z0-9._~-]{6,}\b/g, '[REDACTED_CREDENTIAL]')
    .replace(
      /((?:["'])?\b(?:authorization|api[_-]?key|access[_-]?token|token)\b(?:["'])?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;)}\]]+)/gi,
      '$1[REDACTED_CREDENTIAL]',
    )
  return redacted
}

export function redactCredentialValue(value, sensitiveValues = []) {
  if (typeof value === 'string') {
    return redactCredentialText(value, sensitiveValues)
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactCredentialValue(entry, sensitiveValues))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      redactCredentialValue(entry, sensitiveValues),
    ]))
  }
  return value
}

export function createExperimentCredentialResolver({
  keyFilePath,
  endpoint,
  readCredential = readExperimentCredential,
  selectedRepositoryRoot = repositoryRoot,
  environment = process.env,
}) {
  const hasEnvironmentCredential =
    typeof environment[EXPERIMENT_API_KEY_ENV] === 'string' &&
    Boolean(environment[EXPERIMENT_API_KEY_ENV].trim())
  const hasKeyFile = typeof keyFilePath === 'string' && Boolean(keyFilePath.trim())
  if (hasEnvironmentCredential && hasKeyFile) {
    throw new Error('conflicting_sources: configure exactly one experiment credential source.')
  }
  if (hasEnvironmentCredential) {
    return async () => {
      const apiKey = environment[EXPERIMENT_API_KEY_ENV]?.trim()
      if (!apiKey) {
        throw new Error(`Environment variable ${EXPERIMENT_API_KEY_ENV} is empty.`)
      }
      return apiKey
    }
  }
  if (hasKeyFile) {
    return async () => (
      await readCredential(keyFilePath, endpoint, readFile, {
        selectedRepositoryRoot,
      })
    ).apiKey
  }
  throw new Error(
    `No experiment credential source is configured. Set ${EXPERIMENT_API_KEY_ENV} ` +
    'in the process environment or point FSBP_EXPERIMENT_KEY_FILE to an OS temporary file outside the repository.',
  )
}

export function buildRunnerEnvironment(environment, keyFile) {
  const childEnvironment = { ...environment }
  delete childEnvironment.FSBP_EXPERIMENT_API_KEY
  childEnvironment.FSBP_EXPERIMENT_KEY_FILE = keyFile
  return childEnvironment
}

export function resolveRunnerFreezePath(
  forwarded,
  runnerWorkingDirectory = repositoryRoot,
) {
  const args = parseArgs(forwarded)
  if (args['repo-root'] === true) {
    throw new Error('--repo-root requires a value.')
  }
  if (args.freeze === true) throw new Error('--freeze requires a value.')
  const selectedRepositoryRoot = resolveRunnerRepositoryRoot(
    forwarded,
    runnerWorkingDirectory,
  )
  return args.freeze === undefined
    ? path.join(
      selectedRepositoryRoot,
      'FSBP_Test',
      'private',
      'round-0820',
      'freeze-manifest.json',
    )
    : path.resolve(runnerWorkingDirectory, args.freeze)
}

export function resolveRunnerRepositoryRoot(
  forwarded,
  runnerWorkingDirectory = repositoryRoot,
) {
  const args = parseArgs(forwarded)
  if (args['repo-root'] === true) {
    throw new Error('--repo-root requires a value.')
  }
  return path.resolve(
    runnerWorkingDirectory,
    args['repo-root'] ?? runnerWorkingDirectory,
  )
}

async function readFrozenEndpoint(forwarded) {
  const freezePath = resolveRunnerFreezePath(forwarded)
  let text
  try {
    text = await readFile(freezePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('The selected freeze manifest does not exist.')
    }
    throw new Error('The selected freeze manifest could not be read.')
  }
  let manifest
  try {
    manifest = JSON.parse(text)
  } catch {
    throw new Error('The selected freeze manifest contains invalid JSON.')
  }
  const endpoint = manifest?.snapshot?.endpoint
  if (
    !endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint) ||
    typeof endpoint.baseUrl !== 'string' ||
    endpoint.apiKeyEnv !== 'FSBP_EXPERIMENT_API_KEY'
  ) {
    throw new Error('Freeze manifest does not select the wrapper API key endpoint.')
  }
  return endpoint
}

function usage() {
  return [
    'Legacy helper: node scripts/run-round-0820-with-key-file.mjs',
    '  --key-file <external-OS-temporary-path> [run-round-0820 arguments...]',
  ].join('\n')
}

function parseArguments(argv) {
  let keyFile = null
  const forwarded = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--key-file') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error(`--key-file requires a value.\n${usage()}`)
      }
      if (keyFile !== null) throw new Error('--key-file may be provided only once.')
      keyFile = value
      index += 1
    } else if (argument.startsWith('--key-file=')) {
      if (keyFile !== null) throw new Error('--key-file may be provided only once.')
      keyFile = argument.slice('--key-file='.length)
      if (!keyFile) throw new Error(`--key-file requires a value.\n${usage()}`)
    } else if (argument === '--help' || argument === '-h') {
      process.stdout.write(`${usage()}\n`)
      process.exit(0)
    } else {
      forwarded.push(argument)
    }
  }
  return {
    keyFile: keyFile ? path.resolve(keyFile.trim()) : null,
    forwarded,
  }
}

async function main() {
  const { keyFile, forwarded } = parseArguments(process.argv.slice(2))
  if (!keyFile) throw new Error(`--key-file is required.\n${usage()}`)
  const selectedRepositoryRoot = resolveRunnerRepositoryRoot(forwarded)
  const safeKeyFile = path.resolve(keyFile)
  const frozenEndpoint = await readFrozenEndpoint(forwarded)
  // Fail before spawning on an invalid current file, but do not retain or pass
  // this key. The child resolves the file again immediately before every fetch.
  await readExperimentCredential(safeKeyFile, frozenEndpoint, readFile, {
    selectedRepositoryRoot,
  })

  const childEnvironment = buildRunnerEnvironment(process.env, safeKeyFile)

  const child = spawn(process.execPath, [runner, ...forwarded], {
    cwd: repositoryRoot,
    env: childEnvironment,
    stdio: 'inherit',
    windowsHide: true,
  })

  const result = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  if (result.signal) {
    try {
      process.kill(process.pid, result.signal)
    } catch {
      process.exitCode = 1
    }
    return
  }
  process.exitCode = result.code ?? 1
}

if (
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(`${redactCredentialText(
      error instanceof Error ? error.message : 'Round runner failed.',
    )}\n`)
    process.exitCode = 1
  })
}
