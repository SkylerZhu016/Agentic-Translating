import { createRequire } from 'node:module'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { budgetSummary, costUnits, readJson, saveJson, usageSettlement } from './budget-ledger.mjs'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

async function checkpoints(directory, components = []) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) result.push(...await checkpoints(path.join(directory, entry.name), [...components, entry.name]))
    else if (/^[A-Za-z0-9_-]+\.json$/.test(entry.name) && components.length === 3) {
      const value = await readJson(path.join(directory, entry.name))
      if (value.sampleId && entry.name === `${value.sampleId}.json`) {
        result.push({ ...value, planId: components[0], condition: components[1], split: components[2] })
      }
    }
  }
  return result
}

function classifyCall(record, checkpoint, records) {
  const invocation = checkpoint.productEvidence?.invocations?.find(i => i.id === record.invocation_id)
  if (record.operation === 'worker') return `candidate:${invocation?.agent_variant_id ?? 'unknown'}`
  if (record.operation === 'context_analysis') {
    let snapshot = {}
    try { snapshot = JSON.parse(invocation?.agent_snapshot ?? '{}') } catch {}
    return `context_analysis:${snapshot.analysisIndex ?? 'unknown'}`
  }
  if (record.operation === 'stage_review') {
    if (checkpoint.execution?.reviewStrategy === 'integrated-v1') return 'review:integrated'
    const initial = records.filter(r => r.operation === 'stage_review' && r.run_id === record.run_id && r.retry_count === 0)
    const index = initial.findIndex(r => r.id === record.id)
    return index >= 0 && index < 3 ? `review:${['fidelity', 'naturalness', 'task_specific'][index]}` : 'review:retry_or_unresolved_lens'
  }
  return record.operation
}

export async function createCostReport(campaignDirectory, attributionFile = null) {
  const ledger = await readJson(path.join(campaignDirectory, 'global-budget/budget-ledger.json'))
  const saved = await checkpoints(path.join(campaignDirectory, 'runs'))
  const overrides = attributionFile ? (await readJson(attributionFile)).rows ?? [] : []
  const byAttempt = new Map(overrides.map(r => [r.attemptId, r]))
  const callGroups = new Map()
  for (const condition of ['S0', 'S1']) {
    const databasePath = path.join(campaignDirectory, 'snapshots', condition, 'runtime-data/app.db')
    let db
    try { db = new Database(databasePath, { readonly: true, fileMustExist: true }) } catch { continue }
    try {
      for (const checkpoint of saved.filter(s => s.condition === condition && s.sessionId)) {
        const records = db.prepare('SELECT id,run_id,invocation_id,operation,status,input_tokens,output_tokens,retry_count,error_code,created_at,updated_at FROM llm_call_records WHERE session_id=? ORDER BY created_at,id').all(checkpoint.sessionId)
        callGroups.set(`${checkpoint.planId}:${condition}:${checkpoint.split}:${checkpoint.sampleId}`, { checkpoint, records })
      }
    } finally { db.close() }
  }
  const usedRecords = new Set()
  const rows = ledger.attempts.map(attempt => {
    const override = byAttempt.get(attempt.id)
    const context = attempt.context ?? override ?? {}
    const condition = context.condition ?? 'unattributed'
    const group = callGroups.get(`${context.planId}:${condition}:${context.split}:${context.sampleId}`)
    let record = null
    let evidence = override ? 'manually_verified_historical_attribution' : condition === 'D' ? 'gateway_request_context' : 'unresolved'
    if (group) {
      const elapsedDistance = row => Math.abs(Date.parse(row.updated_at) - Date.parse(attempt.finishedAt))
      const candidates = group.records.filter(r => !usedRecords.has(r.id))
      const exactUsage = candidates.filter(r => attempt.usage && r.input_tokens === attempt.usage.prompt_tokens && r.output_tokens === attempt.usage.completion_tokens && elapsedDistance(r) < 60_000)
      if (exactUsage.length === 1) { record = exactUsage[0]; evidence = 'exact_usage_and_response_time' }
      else {
        const near = candidates.filter(r => elapsedDistance(r) < 5000).sort((a, b) => elapsedDistance(a) - elapsedDistance(b))
        if (near.length === 1) { record = near[0]; evidence = 'unique_response_time_within_5s' }
      }
      if (record) usedRecords.add(record.id)
    }
    const settlement = attempt.usage ? usageSettlement(attempt.usage, attempt.startedAt, attempt.finishedAt) : null
    return {
      attemptId: attempt.id, planId: context.planId ?? null, sampleId: context.sampleId ?? null, condition,
      split: context.split ?? null, stage: override?.stage ?? (condition === 'D' ? 'direct' : record ? classifyCall(record, group.checkpoint, group.records) : 'unattributed'),
      attributionEvidence: evidence, productCallId: record?.id ?? null,
      providerStatus: attempt.status, semanticFailure: override?.semanticFailure ?? record?.status === 'failed',
      productRetryCount: record?.retry_count ?? null, retryOf: attempt.retryOf,
      recoveryOfFailedCandidate: override?.recoveryOfFailedCandidate ?? false,
      requestedModel: attempt.requestedModel ?? 'deepseek-flash',
      providerModel: attempt.providerModel ?? null, providerResponseId: attempt.providerResponseId ?? null,
      maxTokens: attempt.maxTokens, usage: attempt.usage, usageSettled: attempt.usageSettled === true,
      estimatedTariffRmb: settlement ? settlement.chargedUnits / 1e9 : null,
      peakKnownUsageRmb: attempt.usage ? costUnits(attempt.usage) / 1e9 : 0,
      ledgerBudgetOccupancyRmb: attempt.chargedUnits / 1e9,
      unknownReserveRmb: attempt.usage ? 0 : attempt.chargedUnits / 1e9,
      inFlightReserveRmb: !attempt.usage && attempt.status === 'reserved' ? attempt.chargedUnits / 1e9 : 0,
      uncertainReserveRmb: !attempt.usage && attempt.status !== 'reserved' ? attempt.chargedUnits / 1e9 : 0,
      settlementBasis: settlement?.settlementBasis ?? 'unknown_usage_full_peak_reserve',
      providerElapsedMs: attempt.elapsedMs, startedAt: attempt.startedAt, finishedAt: attempt.finishedAt,
    }
  })
  const aggregate = key => {
    const groups = new Map()
    for (const row of rows) {
      const id = key(row)
      const group = groups.get(id) ?? { id, attempts: 0, inputTokens: 0, outputTokensIncludingReasoning: 0, cacheHitTokens: 0, cacheMissTokens: 0, estimatedTariffRmb: 0, peakKnownUsageRmb: 0, ledgerBudgetOccupancyRmb: 0, unknownReserveRmb: 0, failedAttempts: 0, retryAttempts: 0, failedAttemptEstimatedRmb: 0, retryAttemptEstimatedRmb: 0 }
      group.attempts++
      group.inputTokens += row.usage?.prompt_tokens ?? 0
      group.outputTokensIncludingReasoning += row.usage?.completion_tokens ?? 0
      group.cacheHitTokens += row.usage?.prompt_cache_hit_tokens ?? 0
      group.cacheMissTokens += row.usage?.prompt_cache_miss_tokens ?? 0
      for (const field of ['estimatedTariffRmb', 'peakKnownUsageRmb', 'ledgerBudgetOccupancyRmb', 'unknownReserveRmb']) group[field] += row[field] ?? 0
      if ((row.providerStatus !== 'completed' && row.providerStatus !== 'reserved') || row.semanticFailure) {
        group.failedAttempts++
        group.failedAttemptEstimatedRmb += row.estimatedTariffRmb ?? 0
      }
      if (row.retryOf || row.productRetryCount > 0 || row.recoveryOfFailedCandidate) {
        group.retryAttempts++
        group.retryAttemptEstimatedRmb += row.estimatedTariffRmb ?? 0
      }
      groups.set(id, group)
    }
    return [...groups.values()].map(group => Object.fromEntries(Object.entries(group).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 1e9) / 1e9 : v])))
  }
  return {
    createdAt: new Date().toISOString(),
    basis: 'Estimated from provider usage and official prices, not an observed account debit. Completion tokens already include reasoning. No balance request.',
    timingCaveat: 'Gateway serialization and buffering prevent native-product latency comparisons.',
    summary: budgetSummary(ledger),
    samples: saved.map(s => ({ sampleId: s.sampleId, planId: s.planId, condition: s.condition, split: s.split, status: s.status, finalProduced: s.finalProduced, protocolComplete: s.protocolComplete, degraded: s.degraded })),
    byCondition: aggregate(r => r.condition),
    bySampleCondition: aggregate(r => `${r.sampleId}:${r.condition}`),
    byStage: aggregate(r => `${r.condition}:${r.stage}`),
    bySampleStage: aggregate(r => `${r.sampleId}:${r.condition}:${r.stage}`),
    rows,
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, list) => index % 2 ? pairs : [...pairs, [value.replace(/^--/, ''), list[index + 1]]], []))
  if (!args['campaign-dir'] || !args.output) throw new Error('campaign_and_output_required')
  const report = await createCostReport(path.resolve(args['campaign-dir']), args['attribution-file'] ? path.resolve(args['attribution-file']) : null)
  await saveJson(path.resolve(args.output), report)
  console.log(JSON.stringify({ output: path.resolve(args.output), summary: report.summary, bySampleCondition: report.bySampleCondition }))
}
