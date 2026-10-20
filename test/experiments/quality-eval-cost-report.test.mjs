import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createCostReport } from '../../scripts/quality-eval/cost-report.mjs'
import { empiricalEstimate } from '../../scripts/quality-eval/runner.mjs'
import { saveJson } from '../../scripts/quality-eval/budget-ledger.mjs'

const Database = createRequire(import.meta.url)('better-sqlite3')

test('cost report joins actual usage to the isolated product stage without exporting translation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-cost-report-'))
  const usage = { prompt_tokens: 100, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 80, completion_tokens: 30, total_tokens: 130 }
  const startedAt = '2026-10-20T18:00:00.000Z'
  const finishedAt = '2026-10-20T18:00:01.000Z'
  await saveJson(path.join(directory, 'global-budget/budget-ledger.json'), { capUnits: 10e9, attempts: [{
    id: 'one', context: { planId: 'plan', condition: 'S1', split: 'dev', sampleId: 'P1' },
    status: 'completed', maxTokens: 32768, usage, usageSettled: true, chargedUnits: 200400, startedAt, finishedAt,
  }] })
  await saveJson(path.join(directory, 'runs/plan/S1/dev/P1.json'), {
    sampleId: 'P1', sessionId: 'session', status: 'completed', finalProduced: true, protocolComplete: true,
    content: 'PRIVATE_TRANSLATION_SENTINEL',
    execution: { reviewStrategy: 'integrated-v1' },
  })
  const data = path.join(directory, 'snapshots/S1/runtime-data')
  await mkdir(data, { recursive: true })
  const db = new Database(path.join(data, 'app.db'))
  db.exec('CREATE TABLE llm_call_records (id TEXT,session_id TEXT,run_id TEXT,invocation_id TEXT,operation TEXT,status TEXT,input_tokens INTEGER,output_tokens INTEGER,retry_count INTEGER,error_code TEXT,created_at TEXT,updated_at TEXT)')
  db.prepare('INSERT INTO llm_call_records VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('call', 'session', 'run', null, 'stage_review', 'complete', 100, 30, 0, null, startedAt, finishedAt)
  db.close()
  const report = await createCostReport(directory)
  assert.equal(report.rows[0].stage, 'review:integrated')
  assert.equal(report.rows[0].attributionEvidence, 'exact_usage_and_response_time')
  assert.equal(report.byCondition[0].estimatedTariffRmb, 0.0002004)
  assert.equal(report.byCondition[0].outputTokensIncludingReasoning, 30)
  assert.equal(report.byCondition[0].peakKnownUsageRmb, 0.0004008)
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_TRANSLATION_SENTINEL/)
  await saveJson(path.join(directory, 'cost-report.json'), report)
  const estimate = await empiricalEstimate(directory, 'S1', 100)
  assert.equal(estimate.status, 'observed_small_sample_range')
  assert.deepEqual(estimate.scaledRangeRmb, [0.02004, 0.02004])
})

test('estimate labels old-system cost as provisional and excludes unfinished samples', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-cost-estimate-'))
  await saveJson(path.join(directory, 'cost-report.json'), {
    samples: [{ sampleId: 'A', condition: 'S0', status: 'completed' }, { sampleId: 'B', condition: 'S0', status: 'running' }],
    bySampleCondition: [{ id: 'A:S0', estimatedTariffRmb: 0.5, unknownReserveRmb: 0 }, { id: 'B:S0', estimatedTariffRmb: 0.1, unknownReserveRmb: 2.359296 }],
  })
  const estimate = await empiricalEstimate(directory, 'S1', 100)
  assert.equal(estimate.status, 'S0_reference_only_final_S1_not_measured')
  assert.equal(estimate.measuredSamples, 1)
  assert.deepEqual(estimate.scaledRangeRmb, [50, 50])
})
