import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'

export const MODEL = 'deepseek-flash'
export const MAX_BUDGET_RMB = 10
export const INPUT_TOKEN_BOUND = 1_048_576
export const DEFAULT_MAX_TOKENS = 32768
export const PEAK_RATES = { hit: 0.04, miss: 2, output: 8 }
export const OFFPEAK_RATES = { hit: 0.02, miss: 1, output: 4 }
const UNITS = 1_000_000_000

export function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export async function readJson(file) {
  return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''))
}

export async function saveJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  const handle = await open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, file)
}

export function reserveUnits(maxTokens = DEFAULT_MAX_TOKENS) {
  if (![8192, 16384, 32768].includes(maxTokens)) throw new Error('unsupported_max_tokens')
  // Reserve the provider's entire 1M context, not an estimated tokenization.
  return Math.ceil((INPUT_TOKEN_BOUND * PEAK_RATES.miss + maxTokens * PEAK_RATES.output) * UNITS / 1e6)
}

export function validateUsage(usage, maxTokens) {
  const valid = n => Number.isSafeInteger(n) && n >= 0
  if (!usage || !valid(usage.prompt_tokens) || !valid(usage.completion_tokens)) return null
  if (usage.prompt_tokens > INPUT_TOKEN_BOUND || usage.completion_tokens > maxTokens) return null
  if (usage.total_tokens !== undefined && usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens) return null
  const hit = usage.prompt_cache_hit_tokens
  const miss = usage.prompt_cache_miss_tokens
  if (!valid(hit) || !valid(miss) || hit + miss !== usage.prompt_tokens) return null
  return {
    prompt_tokens: usage.prompt_tokens,
    prompt_cache_hit_tokens: hit,
    prompt_cache_miss_tokens: miss,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.prompt_tokens + usage.completion_tokens,
  }
}

export function costUnits(usage, rates = PEAK_RATES) {
  return Math.ceil((
    usage.prompt_cache_hit_tokens * rates.hit
    + usage.prompt_cache_miss_tokens * rates.miss
    + usage.completion_tokens * rates.output
  ) * UNITS / 1e6)
}

export function actualRates(at) {
  const china = new Date(new Date(at).getTime() + 8 * 60 * 60 * 1000)
  const day = china.getUTCDay()
  const hour = china.getUTCHours()
  return day >= 1 && day <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))
    ? PEAK_RATES : OFFPEAK_RATES
}

export function confirmedOffpeakWindow(startedAt, finishedAt, bufferMs = 300_000) {
  const validStamp = value => typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
  if (!validStamp(startedAt) || !validStamp(finishedAt)) return false
  const start = Date.parse(startedAt)
  const finish = Date.parse(finishedAt)
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start
      || finish - start > 7 * 86_400_000 || !Number.isFinite(bufferMs) || bufferMs < 300_000) return false
  const from = start - bufferMs
  const to = finish + bufferMs
  const offset = 8 * 3_600_000
  const firstDay = Math.floor((from + offset) / 86_400_000)
  const lastDay = Math.floor((to + offset) / 86_400_000)
  for (let day = firstDay; day <= lastDay; day++) {
    const weekday = new Date(day * 86_400_000).getUTCDay()
    if (weekday === 0 || weekday === 6) continue
    for (const [beginHour, endHour] of [[9, 12], [14, 18]]) {
      const peakStart = day * 86_400_000 - offset + beginHour * 3_600_000
      const peakEnd = day * 86_400_000 - offset + endHour * 3_600_000
      if (from < peakEnd && to >= peakStart) return false
    }
  }
  return true
}

export function usageSettlement(usage, startedAt, finishedAt) {
  const offpeak = confirmedOffpeakWindow(startedAt, finishedAt)
  return {
    chargedUnits: costUnits(usage, offpeak ? OFFPEAK_RATES : PEAK_RATES),
    peakUsageUnits: costUnits(usage, PEAK_RATES),
    settlementBasis: offpeak ? 'offpeak_proven_whole_interval_with_5m_buffer' : 'peak_conservative',
    settlementVersion: 2,
  }
}

export function budgetSummary(state) {
  const committed = state.attempts.reduce((sum, a) => sum + a.chargedUnits, 0)
  const unsettled = state.attempts.filter(a => a.usage === null).reduce((sum, a) => sum + a.chargedUnits, 0)
  return {
    capRmb: state.capUnits / UNITS,
    committedBudgetRmb: committed / UNITS,
    settledBudgetRmb: (committed - unsettled) / UNITS,
    committedConservativeRmb: committed / UNITS,
    measuredTariffRmb: state.attempts.reduce((sum, a) => sum + (a.measuredUnits ?? 0), 0) / UNITS,
    peakKnownUsageRmb: state.attempts.reduce((sum, a) => sum + (a.usage ? costUnits(a.usage, PEAK_RATES) : 0), 0) / UNITS,
    outstandingReserveRmb: unsettled / UNITS,
    inFlightReserveRmb: state.attempts.filter(a => a.usage === null && a.status === 'reserved').reduce((sum, a) => sum + a.chargedUnits, 0) / UNITS,
    uncertainReserveRmb: state.attempts.filter(a => a.usage === null && a.status !== 'reserved').reduce((sum, a) => sum + a.chargedUnits, 0) / UNITS,
    availableRmb: (state.capUnits - committed) / UNITS,
    attempts: state.attempts.length,
    completed: state.attempts.filter(a => a.status === 'completed').length,
    usageSettledAttempts: state.attempts.filter(a => a.usage !== null).length,
    halted: state.halted ?? false,
  }
}

export async function acquireLock(directory) {
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, 'gateway.lock')
  let handle
  try {
    handle = await open(file, 'wx', 0o600)
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('gateway_locked: inspect gateway.lock; never auto-delete a live lock')
    throw error
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
  await handle.sync()
  return async () => { await handle.close(); await unlink(file) }
}

export class BudgetLedger {
  static async open(directory, capRmb) {
    if (!Number.isFinite(capRmb) || capRmb <= 0 || capRmb > MAX_BUDGET_RMB) throw new Error('budget_must_be_explicit_between_0_and_10')
    const ledger = new BudgetLedger(directory)
    try {
      ledger.state = await readJson(ledger.file)
      if (ledger.state.version !== 1 || ledger.state.capUnits !== Math.floor(capRmb * UNITS)) throw new Error('budget_immutable_on_resume')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      ledger.state = { version: 1, model: MODEL, capUnits: Math.floor(capRmb * UNITS), createdAt: new Date().toISOString(), attempts: [] }
      await ledger.save()
    }
    return ledger
  }
  constructor(directory) {
    this.directory = directory
    this.file = path.join(directory, 'budget-ledger.json')
  }
  async save() { await saveJson(this.file, this.state) }
  summary() { return budgetSummary(this.state) }
  completed(requestHash) {
    return this.state.attempts.find(a => a.requestHash === requestHash && a.status === 'completed')
  }
  seen(requestHash) { return this.state.attempts.some(a => a.requestHash === requestHash) }
  async reserve(requestHash, maxTokens, route = 'direct', retryOf = null, context = null) {
    if (this.state.halted) throw new Error('gateway_halted')
    const chargedUnits = reserveUnits(maxTokens)
    const committed = this.state.attempts.reduce((sum, a) => sum + a.chargedUnits, 0)
    if (committed + chargedUnits > this.state.capUnits) throw new Error('budget_exhausted')
    const attempt = {
      id: randomUUID(), requestHash, startedAt: new Date().toISOString(),
      status: 'reserved', maxTokens, route, retryOf,
      reservedUnits: chargedUnits, chargedUnits, usage: null, usageSettled: false, context,
    }
    this.state.attempts.push(attempt)
    await this.save() // Must be durable BEFORE physical dispatch.
    return attempt
  }
  async finish(attempt, { usage, status, httpStatus = null, content = '', reasoningCharacters = 0, elapsedMs = 0, providerModel = null, providerResponseId = null }) {
    const validated = validateUsage(usage, attempt.maxTokens)
    attempt.status = status
    attempt.httpStatus = httpStatus
    attempt.elapsedMs = elapsedMs
    attempt.reasoningCharacters = reasoningCharacters
    attempt.requestedModel = MODEL
    attempt.providerModel = providerModel
    attempt.providerResponseId = providerResponseId
    attempt.finishedAt = new Date().toISOString()
    // Output validity and billing certainty are independent. A truncated output
    // with complete trustworthy usage is still a failed output, but a settled bill.
    if (validated) {
      attempt.observedUsage = validated
      attempt.usage = validated
      attempt.usageSettled = true
      Object.assign(attempt, usageSettlement(validated, attempt.startedAt, attempt.finishedAt))
      attempt.measuredUnits = attempt.chargedUnits
      this.state.billingVersion = 2
      this.state.billingPolicy = 'peak_reserve_then_interval_proven_settlement'
    }
    if (status === 'completed' && !validated) {
      attempt.status = 'usage_missing_or_invalid'
      this.state.halted = true
    }
    if ([401, 402, 403].includes(httpStatus)) {
      this.state.halted = true
      this.state.haltReason = httpStatus === 402 ? 'provider_402' : 'provider_authentication'
    }
    const resultFile = path.join(this.directory, 'responses', `${attempt.id}.json`)
    await saveJson(resultFile, {
      attemptId: attempt.id, requestHash: attempt.requestHash, model: MODEL,
      requestedModel: MODEL, providerModel, providerResponseId,
      status: attempt.status, content, usage: validated,
      httpStatus, reasoningCharacters, elapsedMs, finishRecordedAt: attempt.finishedAt,
    })
    attempt.resultFile = path.relative(this.directory, resultFile).replaceAll('\\', '/')
    await this.save()
    return attempt
  }
  async reconcilePersistedUsage() {
    let reconciled = 0
    for (const attempt of this.state.attempts) {
      const resultFile = attempt.resultFile ?? `responses/${attempt.id}.json`
      const target = path.resolve(this.directory, resultFile)
      if (!target.startsWith(`${path.resolve(this.directory)}${path.sep}`)) throw new Error('response_path_outside_ledger')
      let record
      try { record = await readJson(target) } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) continue
        throw error
      }
      if (record.attemptId !== attempt.id || record.requestHash !== attempt.requestHash) throw new Error('response_identity_mismatch')
      if ([401, 402, 403].includes(record.httpStatus) || record.status === 'usage_missing_or_invalid'
          || (attempt.status === 'reserved' && record.status === 'http_error' && record.httpStatus == null)) {
        this.state.halted = true
        this.state.haltReason = record.httpStatus === 402 ? 'provider_402'
          : [401, 403].includes(record.httpStatus) ? 'provider_authentication'
          : record.status === 'usage_missing_or_invalid' ? 'usage_missing_or_invalid' : 'http_status_unknown_on_recovery'
      }
      const usage = validateUsage(record.usage, attempt.maxTokens)
      if (!usage) continue
      if (attempt.status === 'reserved') {
        if (!['completed', 'output_truncated', 'http_error', 'transport_error', 'usage_missing_or_invalid'].includes(record.status)) continue
        attempt.status = record.status
        attempt.resultFile = resultFile
        attempt.finishedAt = record.finishRecordedAt
        attempt.httpStatus = record.httpStatus ?? null
        attempt.elapsedMs = record.elapsedMs
        attempt.reasoningCharacters = record.reasoningCharacters
        attempt.requestedModel = MODEL
        attempt.providerModel = record.providerModel ?? null
        attempt.providerResponseId = record.providerResponseId ?? null
        attempt.recoveredAfterResponsePersistence = true
        if (attempt.httpStatus === 402) this.state.halted = true
      }
      if (!attempt.usageSettled) reconciled++
      attempt.usage = usage
      attempt.observedUsage = usage
      attempt.usageSettled = true
      Object.assign(attempt, usageSettlement(usage, attempt.startedAt, attempt.finishedAt))
      attempt.measuredUnits = attempt.chargedUnits
      attempt.usageReconciledAt = new Date().toISOString()
    }
    this.state.billingVersion = 2
    this.state.billingPolicy = 'peak_reserve_then_interval_proven_settlement'
    await this.save()
    return { reconciled, ...this.summary() }
  }
}
