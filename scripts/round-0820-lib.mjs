import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const ROUND_ID = 'round-0820'
export const CONDITIONS = ['direct', 'multi_raw', 'multi_fsbp']
export const MULTI_CONDITIONS = ['multi_raw', 'multi_fsbp']
export const STAGES = ['review', 'filter', 'orchestrate', 'assemble']
export const QUALITY_DIMENSIONS = [
  'fidelity',
  'naturalness',
  'style_voice',
  'structure_form',
  'terminology_logic',
  'overall_quality',
]
export const ISOLATION_OUTCOMES = [
  'corrected',
  'rejected',
  'retained',
  'amplified',
  'unclear',
]

export function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`Unknown argument: ${token}`)
    const equals = token.indexOf('=')
    if (equals >= 0) {
      result[token.slice(2, equals)] = token.slice(equals + 1)
      continue
    }
    const key = token.slice(2)
    if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      result[key] = argv[index + 1]
      index += 1
    } else {
      result[key] = true
    }
  }
  return result
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    )
  }
  return value
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function hashJson(value) {
  return sha256(canonicalJson(value))
}

export async function hashFile(filePath) {
  return sha256(await readFile(filePath))
}

export async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${filePath}: invalid JSON: ${error.message}`)
    }
    throw error
  }
}

export async function readJsonl(filePath, { allowMissing = false } = {}) {
  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return []
    throw error
  }
  if (!text.trim()) return []
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line)
      } catch (error) {
        throw new Error(`${filePath}:${index + 1}: invalid JSON: ${error.message}`)
      }
    })
}

export async function writeJsonNew(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  })
}

export async function writeTextNew(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, value, { encoding: 'utf8', flag: 'wx' })
}

export async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, filePath)
}

export async function writeJsonlAtomic(filePath, records) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  const text = records.length
    ? `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
    : ''
  await writeFile(temporaryPath, text, 'utf8')
  await rename(temporaryPath, filePath)
}

export function assertPlainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`)
  }
  return value
}

export function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`)
  }
  return value
}

export function assertSafeId(value, name = 'ID') {
  assertNonEmptyString(value, name)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new Error(`${name} contains unsafe characters.`)
  }
  return value
}

export function portableRelative(root, target) {
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path must be a file below repository root: ${target}`)
  }
  return relative.replace(/\\/g, '/')
}

export function resolvePortable(root, portablePath) {
  assertNonEmptyString(portablePath, 'artifact path')
  const target = path.resolve(root, portablePath)
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Artifact path escapes repository root: ${portablePath}`)
  }
  return target
}

export function assertPathInside(root, target, label = 'path') {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  const relative = path.relative(resolvedRoot, resolvedTarget)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside ${resolvedRoot}.`)
  }
  return resolvedTarget
}

export function parseSemanticOutput(rawInput) {
  const raw = String(rawInput ?? '').replace(/\r\n/g, '\n')
  const lines = raw.split('\n')
  const boundaryIndex = lines.findIndex((line) => line.trim() === '---')
  if (boundaryIndex < 0) {
    return {
      raw,
      body: raw.trim(),
      annotation: null,
      boundaryFound: false,
      boundaryCount: 0,
    }
  }
  return {
    raw,
    body: lines.slice(0, boundaryIndex).join('\n').trim(),
    annotation: lines.slice(boundaryIndex + 1).join('\n').trim() || null,
    boundaryFound: true,
    boundaryCount: lines.filter((line) => line.trim() === '---').length,
  }
}

export function seededNumber(seed, ...parts) {
  const digest = createHash('sha256')
    .update([seed, ...parts].join('\u0000'), 'utf8')
    .digest()
  return digest.readUInt32BE(0) / 0x1_0000_0000
}

export function deterministicOrder(values, seed, namespace) {
  return [...values].sort((left, right) => {
    const leftRank = sha256(`${seed}\u0000${namespace}\u0000${left}`)
    const rightRank = sha256(`${seed}\u0000${namespace}\u0000${right}`)
    return leftRank.localeCompare(rightRank)
  })
}

export function createPrng(seed) {
  let state = Number.parseInt(sha256(seed).slice(0, 8), 16) >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000
  }
}

export function mean(values) {
  if (!values.length) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

export function quantile(values, probability) {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  const index = (sorted.length - 1) * probability
  const lower = Math.floor(index)
  const fraction = index - lower
  return sorted[lower + 1] === undefined
    ? sorted[lower]
    : sorted[lower] + fraction * (sorted[lower + 1] - sorted[lower])
}

export function sampleStandardDeviation(values) {
  if (values.length < 2) return null
  const center = mean(values)
  const variance = values.reduce(
    (sum, value) => sum + (value - center) ** 2,
    0,
  ) / (values.length - 1)
  return Math.sqrt(variance)
}

export function pairedBootstrap(values, {
  seed,
  iterations = 5000,
  statistic = mean,
} = {}) {
  if (!values.length) return { estimate: null, ci95: [null, null], iterations: 0 }
  const random = createPrng(seed ?? 'round-0820-bootstrap')
  const estimates = []
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const resample = Array.from(
      { length: values.length },
      () => values[Math.floor(random() * values.length)],
    )
    estimates.push(statistic(resample))
  }
  return {
    estimate: statistic(values),
    ci95: [quantile(estimates, 0.025), quantile(estimates, 0.975)],
    iterations,
  }
}

export function wilsonInterval(successes, total, z = 1.959963984540054) {
  if (!total) return [null, null]
  const proportion = successes / total
  const denominator = 1 + (z ** 2) / total
  const center = (proportion + (z ** 2) / (2 * total)) / denominator
  const radius = (
    z * Math.sqrt((proportion * (1 - proportion)) / total + (z ** 2) / (4 * total ** 2))
  ) / denominator
  return [Math.max(0, center - radius), Math.min(1, center + radius)]
}

export function roundMetric(value, digits = 8) {
  if (value === null || value === undefined || !Number.isFinite(value)) return value
  return Number(value.toFixed(digits))
}

export function deepRound(value) {
  if (Array.isArray(value)) return value.map(deepRound)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, deepRound(child)]),
    )
  }
  return typeof value === 'number' ? roundMetric(value) : value
}

// Krippendorff's ordinal alpha using coincidence matrices and the ordinal
// distance induced by pooled category marginals (Content Analysis, 4th ed.).
export function krippendorffAlphaOrdinal(units) {
  const usable = units
    .map((ratings) => ratings.filter((rating) => rating !== null && rating !== undefined))
    .filter((ratings) => ratings.length >= 2)
  const categories = [...new Set(usable.flat())].sort((left, right) => left - right)
  if (!usable.length || categories.length < 2) {
    return usable.length && categories.length === 1 ? 1 : null
  }
  const indexByCategory = new Map(categories.map((category, index) => [category, index]))
  const coincidence = Array.from(
    { length: categories.length },
    () => Array(categories.length).fill(0),
  )
  for (const ratings of usable) {
    const denominator = ratings.length - 1
    for (let left = 0; left < ratings.length; left += 1) {
      for (let right = 0; right < ratings.length; right += 1) {
        if (left === right) continue
        coincidence[indexByCategory.get(ratings[left])][indexByCategory.get(ratings[right])] +=
          1 / denominator
      }
    }
  }
  const marginals = coincidence.map((row) => row.reduce((sum, value) => sum + value, 0))
  const total = marginals.reduce((sum, value) => sum + value, 0)
  if (total <= 1) return null
  const distance = (leftIndex, rightIndex) => {
    if (leftIndex === rightIndex) return 0
    const lower = Math.min(leftIndex, rightIndex)
    const upper = Math.max(leftIndex, rightIndex)
    let intervalMass = 0
    for (let index = lower; index <= upper; index += 1) intervalMass += marginals[index]
    intervalMass -= (marginals[lower] + marginals[upper]) / 2
    return intervalMass ** 2
  }
  let observedNumerator = 0
  let expectedNumerator = 0
  for (let left = 0; left < categories.length; left += 1) {
    for (let right = 0; right < categories.length; right += 1) {
      const delta = distance(left, right)
      observedNumerator += coincidence[left][right] * delta
      const expected = left === right
        ? (marginals[left] * (marginals[left] - 1)) / (total - 1)
        : (marginals[left] * marginals[right]) / (total - 1)
      expectedNumerator += expected * delta
    }
  }
  if (expectedNumerator === 0) return observedNumerator === 0 ? 1 : null
  return 1 - observedNumerator / expectedNumerator
}

export function packetHash(packet) {
  const { packetHash: _ignored, ...unsigned } = packet
  return hashJson(unsigned)
}

export function assertPacketHash(packet, label = 'packet') {
  if (packet.packetHash !== packetHash(packet)) {
    throw new Error(`${label} hash mismatch.`)
  }
}
