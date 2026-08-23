import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

async function readJsonl(filePath) {
  try {
    const text = await readFile(filePath, 'utf8')
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

function countsBy(records, key) {
  return Object.fromEntries(
    [...records.reduce((counts, record) => {
      const value = String(record[key] ?? 'unknown')
      counts.set(value, (counts.get(value) ?? 0) + 1)
      return counts
    }, new Map())].sort(([left], [right]) => left.localeCompare(right)),
  )
}

function firstPresent(record, keys) {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return String(record[key])
  }
  return 'unknown'
}

function countsByAny(records, keys) {
  return Object.fromEntries(
    [...records.reduce((counts, record) => {
      const value = firstPresent(record, keys)
      counts.set(value, (counts.get(value) ?? 0) + 1)
      return counts
    }, new Map())].sort(([left], [right]) => left.localeCompare(right)),
  )
}

function crossCounts(records, leftKey, rightKey) {
  return Object.fromEntries(
    [...records.reduce((counts, record) => {
      const value = `${String(record[leftKey] ?? 'unknown')} | ${String(record[rightKey] ?? 'unknown')}`
      counts.set(value, (counts.get(value) ?? 0) + 1)
      return counts
    }, new Map())].sort(([left], [right]) => left.localeCompare(right)),
  )
}

const runDirectory = path.resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('Usage: node scripts/inspect-round-0820-progress.mjs <run-dir>')

const [events, outcomes, final] = await Promise.all([
  readJsonl(path.join(runDirectory, 'events.jsonl')),
  readJsonl(path.join(runDirectory, 'outcomes.jsonl')),
  readJsonl(path.join(runDirectory, 'final.jsonl')),
])

const usage = events.reduce((totals, event) => {
  totals.promptTokens += Number(event.usage?.prompt_tokens ?? 0)
  totals.completionTokens += Number(event.usage?.completion_tokens ?? 0)
  totals.totalTokens += Number(event.usage?.total_tokens ?? 0)
  return totals
}, { promptTokens: 0, completionTokens: 0, totalTokens: 0 })

process.stdout.write(`${JSON.stringify({
  events: events.length,
  eventStatus: countsBy(events, 'status'),
  models: countsBy(events, 'model'),
  modelStatus: crossCounts(events, 'model', 'status'),
  tasks: countsByAny(events, ['taskKey', 'logicalCallKey', 'callKey', 'task']),
  failureKinds: countsByAny(events.filter((event) => event.status !== 'complete'), [
    'errorCode', 'failureCode', 'errorType', 'failureType', 'status',
  ]),
  failedTasks: countsByAny(events.filter((event) => event.status !== 'complete'), [
    'taskKey', 'logicalCallKey', 'callKey', 'task',
  ]),
  attempts: countsBy(events, 'attempt'),
  retryScheduled: countsBy(events, 'retryScheduled'),
  eventFields: [...new Set(events.flatMap((event) => Object.keys(event)))].sort(),
  terminalEvidence: countsBy(events, 'terminalEvidence'),
  visibleBodyCharacters: events.reduce((total, event) => total + String(event.body ?? '').length, 0),
  usage,
  lastCompletedAt: events.map((event) => event.completedAt).filter(Boolean).sort().at(-1) ?? null,
  outcomes: outcomes.length,
  outcomeStatus: countsBy(outcomes, 'status'),
  final: final.length,
  finalStatus: countsBy(final, 'status'),
}, null, 2)}\n`)
