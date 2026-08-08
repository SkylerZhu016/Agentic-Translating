// Validate a blind-review verdict from item-level outcomes. Never trust a
// hand-written aggregate or passed flag when it can be derived mechanically.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const verdictArg = process.argv.find((argument) => argument.startsWith('--verdict='))
if (!verdictArg) throw new Error('--verdict is required')
const verdictPath = path.resolve(verdictArg.slice(10))
const verdict = JSON.parse(await readFile(verdictPath, 'utf8'))
const items = verdict.mainComparison
if (!Array.isArray(items) || items.length === 0) {
  throw new Error('verdict.mainComparison must be a non-empty list')
}

function outcomeOf(item) {
  const winner = String(item.winner ?? '').trim().toLowerCase()
  if (winner === 'tie' || winner === '平局') return 'tie'
  if (item.fsbpWins === true) return 'win'
  const a = String(item.A ?? '').toLowerCase()
  const b = String(item.B ?? '').toLowerCase()
  if (winner === 'a') {
    if (a.includes('fsbp')) return 'win'
    if (b.includes('fsbp')) return 'loss'
  }
  if (winner === 'b') {
    if (b.includes('fsbp')) return 'win'
    if (a.includes('fsbp')) return 'loss'
  }
  if (winner.includes('fsbp')) return 'win'
  if (item.fsbpWins === false) return 'loss'
  throw new Error(`cannot derive FSBP outcome for item ${String(item.itemNo ?? '?')}`)
}

const outcomes = items.map(outcomeOf)
const summary = {
  fsbpWins: outcomes.filter((outcome) => outcome === 'win').length,
  ties: outcomes.filter((outcome) => outcome === 'tie').length,
  losses: outcomes.filter((outcome) => outcome === 'loss').length,
  total: outcomes.length,
}

const requiredWinsArg = process.argv.find((argument) => argument.startsWith('--require-wins='))
const minimumRateArg = process.argv.find((argument) => argument.startsWith('--minimum-win-rate='))
const failures = []
let evaluatedRules = 0

for (const [gateName, gate] of Object.entries(verdict.gates ?? {})) {
  for (const key of ['fsbpWins', 'ties', 'losses', 'total']) {
    if (gate[key] != null && Number(gate[key]) !== summary[key]) {
      failures.push(`${gateName}.${key}=${gate[key]} but item-level value is ${summary[key]}`)
    }
  }
  const match = String(gate.requirement ?? '').match(/(\d+)\s*\/\s*(\d+).*胜/u)
  if (match) {
    evaluatedRules += 1
    const requiredWins = Number(match[1])
    const requiredTotal = Number(match[2])
    const computedPassed = summary.total === requiredTotal && summary.fsbpWins >= requiredWins
    if (typeof gate.passed === 'boolean' && gate.passed !== computedPassed) {
      failures.push(
        `${gateName}.passed=${gate.passed} but ${summary.fsbpWins}/${summary.total} ` +
        `does ${computedPassed ? '' : 'not '}satisfy ${gate.requirement}`,
      )
    }
  }
}

if (requiredWinsArg) {
  evaluatedRules += 1
  const requiredWins = Number(requiredWinsArg.slice(15))
  if (!Number.isInteger(requiredWins) || requiredWins < 0) {
    throw new Error('--require-wins must be a non-negative integer')
  }
  if (summary.fsbpWins < requiredWins) {
    failures.push(`wins ${summary.fsbpWins} are below required ${requiredWins}`)
  }
}
if (minimumRateArg) {
  evaluatedRules += 1
  const minimumRate = Number(minimumRateArg.slice(19))
  if (!Number.isFinite(minimumRate) || minimumRate < 0 || minimumRate > 1) {
    throw new Error('--minimum-win-rate must be between 0 and 1')
  }
  const rate = summary.fsbpWins / summary.total
  if (rate < minimumRate) {
    failures.push(`win rate ${rate.toFixed(4)} is below required ${minimumRate}`)
  }
}
if (evaluatedRules === 0) {
  failures.push('no machine-readable gate rule was found; pass an explicit threshold')
}

const output = {
  verdictPath,
  summary,
  valid: failures.length === 0,
  failures,
}
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1
