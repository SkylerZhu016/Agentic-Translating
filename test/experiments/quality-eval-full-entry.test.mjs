import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fullSampleRetryDecision, isSampleOutputFailure, main, validatePlan } from '../../scripts/quality-eval/runner.mjs'
import { digest, readJson, saveJson } from '../../scripts/quality-eval/budget-ledger.mjs'

test('full entry reuses final checkpoints and requires an explicit single bounded failed retry', () => {
  assert.deepEqual(fullSampleRetryDecision({ status: 'completed' }, true), { action: 'reuse', retryRound: 0 })
  assert.deepEqual(fullSampleRetryDecision({ status: 'running' }, false), { action: 'resume', retryRound: 0 })
  assert.deepEqual(fullSampleRetryDecision({ status: 'failed' }, false), { action: 'skip_failed', retryRound: 0 })
  assert.deepEqual(fullSampleRetryDecision({ status: 'failed' }, true), { action: 'retry_failed', retryRound: 1 })
  assert.deepEqual(fullSampleRetryDecision({ status: 'failed', runnerRetryCount: 1 }, true), { action: 'skip_failed', retryRound: 1 })
})

test('only terminal output failures may advance to the next full sample', () => {
  for (const code of ['direct_semantic_json_invalid', 'direct_call_failed', 'product_run_failed']) assert.equal(isSampleOutputFailure(new Error(code)), true)
  for (const code of ['product_monitor_timeout', 'product_run_interrupted', 'product_api_failed', 'frozen_product_changed', 'gateway_halted', 'budget_exhausted']) assert.equal(isSampleOutputFailure(new Error(code)), false)
})

test('source-only full manifest remains unpaid and unauthorized after estimate', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quality-full-entry-'))
  const file = path.join(dir, 'plan.json')
  const raw = { planId: 'synthetic-full', scope: 'full100', approved: false, samples: Array.from({ length: 100 }, (_, i) => ({ sampleId: `T${i}`, split: 'full', sourceText: '原文', taskBrief: 'Translate the source', referenceTranslation: 'PRIVATE_REFERENCE' })) }
  await saveJson(file, raw)
  assert.doesNotMatch(JSON.stringify(validatePlan(raw)), /PRIVATE_REFERENCE/)
  await main(['estimate', '--campaign-dir', dir, '--plan', file, '--condition', 'S1', '--split', 'full'])
  assert.equal((await readJson(file)).approved, false)
  await assert.rejects(readJson(path.join(dir, 'execution-authorization.json')), { code: 'ENOENT' })
  await assert.rejects(readJson(path.join(dir, 'global-budget/budget-ledger.json')), { code: 'ENOENT' })
  await assert.rejects(main(['resume', '--campaign-dir', dir, '--plan', file, '--condition', 'S1', '--split', 'full', '--allow-full100', '--budget-rmb', '10']), /plan_not_approved/)
})

test('manual full authorization binds the approved plan and final source while preserving the original cap', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quality-manual-gate-'))
  const planFile = path.join(dir, 'plan.json')
  const credentialFile = path.join(dir, 'invalid-credential.json')
  await writeFile(credentialFile, 'SYNTHETIC_INVALID_CONFIG')
  const raw = { planId: 'synthetic-authorized-full', scope: 'full100', approved: false, samples: Array.from({ length: 100 }, (_, i) => ({ sampleId: `T${i}`, split: 'full', sourceText: '原文', taskBrief: 'Translate' })) }
  await saveJson(planFile, raw)
  await saveJson(path.join(dir, 'snapshots/S1/snapshot.json'), { sourceHash: 'frozen-final-source', files: [], workspace: dir })
  await saveJson(path.join(dir, 'global-budget/budget-ledger.json'), { version: 1, capUnits: 10e9, attempts: [] })
  await saveJson(path.join(dir, 'execution-authorization.json'), { conditions: ['D', 'S0'], splits: ['dev'], sampleIds: ['P1'] })
  const entry = ['continue', '--campaign-dir', dir, '--plan', planFile, '--credential-file', credentialFile, '--allow-full100', '--authorize-full']
  await assert.rejects(main([...entry, '--budget-rmb', '9']), /budget_immutable_on_resume/)
  assert.equal((await readJson(planFile)).approved, false)
  assert.equal((await readJson(path.join(dir, 'execution-authorization.json'))).full100Authorization, undefined)
  // Invalid synthetic credentials stop before gateway creation or any request.
  await assert.rejects(main([...entry, '--budget-rmb', '10']), /credential_file_invalid_or_unreadable/)
  const approved = await readJson(planFile)
  const gate = (await readJson(path.join(dir, 'execution-authorization.json'))).full100Authorization
  assert.equal(approved.approved, true)
  assert.deepEqual(gate.conditions, ['D', 'S1'])
  assert.deepEqual(gate.splits, ['full'])
  assert.equal(gate.planHash, digest(validatePlan(approved)))
  assert.equal(gate.sourceHash, 'frozen-final-source')
  assert.equal((await readJson(path.join(dir, 'global-budget/budget-ledger.json'))).attempts.length, 0)
})
