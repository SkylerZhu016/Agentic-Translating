import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { acquireLock, BudgetLedger, budgetSummary, digest, readJson, reserveUnits, saveJson, MODEL } from './budget-ledger.mjs'
import { createGateway, LOCAL_KEY } from './gateway.mjs'
import { configureProduct, freezeProduct, runProductSample, startProduct, validateSnapshot } from './product-client.mjs'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export function parseCli(argv) {
  const [command = 'status', ...rest] = argv
  const args = {}
  for (let i = 0; i < rest.length; i += 1) {
    if (!rest[i].startsWith('--')) throw new Error('expected_named_argument')
    const key = rest[i].slice(2)
    args[key] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true
  }
  return { command, args }
}

export function validatePlan(plan) {
  if (!plan || typeof plan.planId !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(plan.planId)) throw new Error('plan_id_required')
  if (!['pilot', 'full100'].includes(plan.scope) || !Array.isArray(plan.samples) || !plan.samples.length) throw new Error('invalid_plan')
  if (plan.scope === 'pilot' && plan.samples.length > 6) throw new Error('pilot_max_six_samples')
  const samples = plan.samples.map(sample => {
    const allowedSplits = plan.scope === 'full100' ? ['full'] : ['dev', 'holdout']
    if (!/^[a-zA-Z0-9._-]+$/.test(sample.sampleId) || !allowedSplits.includes(sample.split) || typeof sample.sourceText !== 'string' || !sample.sourceText.trim()) throw new Error('invalid_sample')
    if (typeof sample.taskBrief !== 'string') throw new Error('task_brief_required')
    // Explicit allowlist prevents reference translations or grades reaching the provider.
    const brief = (() => { try { return JSON.parse(sample.taskBrief) } catch { return {} } })()
    const productConstraints = Array.isArray(sample.constraints)
      ? { poetryMode: brief.category === 'poetry' ? 'on' : 'off' }
      : sample.constraints ?? {}
    return {
      sampleId: sample.sampleId, split: sample.split, sourceText: sample.sourceText,
      taskBrief: sample.taskBrief, constraints: productConstraints,
      originalHardConstraints: Array.isArray(sample.constraints) ? sample.constraints : [],
      ...(sample.allowedAgentVariantIds ? { allowedAgentVariantIds: sample.allowedAgentVariantIds } : {}),
    }
  })
  if (new Set(samples.map(s => s.sampleId)).size !== samples.length) throw new Error('duplicate_sample_id')
  return { planId: plan.planId, scope: plan.scope, approved: plan.approved === true, samples }
}

export function fullSampleRetryDecision(previous, retryFailed) {
  const terminal = previous && ['failed', 'cancelled', 'canceled'].includes(previous.status)
  const retryRound = previous?.runnerRetryCount ?? 0
  if (previous?.status === 'completed') return { action: 'reuse', retryRound }
  if (!terminal) return { action: 'resume', retryRound }
  if (!retryFailed || retryRound >= 1) return { action: 'skip_failed', retryRound }
  return { action: 'retry_failed', retryRound: retryRound + 1 }
}

export function isSampleOutputFailure(error) {
  return ['direct_semantic_json_invalid', 'direct_call_failed', 'product_run_failed'].includes(error.code ?? error.message)
}

export async function empiricalEstimate(campaignDirectory, condition, sampleCount) {
  let report
  try { report = await readJson(path.join(campaignDirectory, 'cost-report.json')) }
  catch (error) { if (error.code === 'ENOENT') return { status: 'no_measured_cost_report' }; throw error }
  const finished = new Set(report.samples.filter(s => s.status === 'completed').map(s => `${s.sampleId}:${s.condition}`))
  let basisCondition = condition
  let rows = report.bySampleCondition.filter(r => r.id.endsWith(`:${condition}`) && finished.has(r.id) && r.unknownReserveRmb === 0)
  if (!rows.length && condition === 'S1') {
    basisCondition = 'S0'
    rows = report.bySampleCondition.filter(r => r.id.endsWith(':S0') && finished.has(r.id) && r.unknownReserveRmb === 0)
  }
  if (!rows.length) return { status: 'no_completed_measured_samples_for_condition' }
  const minimum = Math.min(...rows.map(r => r.estimatedTariffRmb))
  const maximum = Math.max(...rows.map(r => r.estimatedTariffRmb))
  return {
    status: basisCondition === condition ? 'observed_small_sample_range' : 'S0_reference_only_final_S1_not_measured',
    basisCondition, measuredSamples: rows.length,
    observedPerSampleRmb: [minimum, maximum],
    scaledRangeRmb: [minimum * sampleCount, maximum * sampleCount],
    caveat: 'Small-sample extrapolation, not a guaranteed price. Length, cache, rate window and retries can change costs. The original RMB 10 ledger and full peak reservation still stop dispatch safely.',
  }
}

export async function runDirect(gateway, sample) {
  const response = await fetch(`${gateway.url}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LOCAL_KEY}` },
    body: JSON.stringify({
      model: MODEL, stream: true,
      messages: [
        { role: 'system', content: 'Translate the supplied Chinese literary source into English. Preserve meaning, voice, imagery and the stated formal requirements. Return one complete JSON object with exactly two string fields: "body" containing the complete translation and "annotation" containing optional concise public notes (or an empty string). Do not wrap the JSON in code fences. Do not include private reasoning.' },
        { role: 'user', content: `Task requirements:\n${sample.taskBrief}\n\nSource:\n${sample.sourceText}` },
      ],
    }),
    signal: AbortSignal.timeout(15 * 60 * 1000),
  })
  const text = await response.text()
  let content = ''
  let usage = null
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
    const data = JSON.parse(line.slice(6))
    content += data.choices?.[0]?.delta?.content ?? ''
    usage = data.usage ?? usage
  }
  if (!response.ok || !content.trim() || !usage) throw new Error('direct_call_failed')
  let semantic
  try { semantic = JSON.parse(content) } catch { throw new Error('direct_semantic_json_invalid') }
  if (!semantic || typeof semantic.body !== 'string' || !semantic.body.trim() || typeof semantic.annotation !== 'string') throw new Error('direct_semantic_json_invalid')
  return { content: semantic.body, annotation: semantic.annotation, usage }
}

export async function main(argv = process.argv.slice(2)) {
  const { command, args } = parseCli(argv)
  if (args.settings) {
    let settings
    try { settings = await readJson(path.resolve(args.settings)) }
    catch { throw new Error('settings_file_invalid_or_unreadable') }
    const fields = { campaignDir: 'campaign-dir', credentialFile: 'credential-file', plan: 'plan', budgetRmb: 'budget-rmb', maxTokens: 'max-tokens', repoRoot: 'repo-root' }
    for (const [key, argument] of Object.entries(fields)) if (args[argument] === undefined && settings[key] !== undefined) args[argument] = String(settings[key])
  }
  if (!args['campaign-dir']) throw new Error('campaign_dir_required_use_cli_or_private_settings')
  const campaignRoot = path.resolve(args['campaign-dir'])
  const repoRoot = path.resolve(args['repo-root'] ?? REPO_ROOT)
  const ledgerDir = path.join(campaignRoot, 'global-budget')
  if (command === 'status') {
    let summary
    try { summary = budgetSummary(await readJson(path.join(ledgerDir, 'budget-ledger.json'))) }
    catch (error) { if (error.code !== 'ENOENT') throw error; summary = { status: 'not_started', attempts: 0, committedConservativeRmb: 0 } }
    console.log(JSON.stringify({ campaignDirectory: campaignRoot, ...summary }, null, 2))
    return
  }
  if (command === 'reconcile') {
    const release = await acquireLock(ledgerDir)
    try {
      const existing = await readJson(path.join(ledgerDir, 'budget-ledger.json'))
      const ledger = await BudgetLedger.open(ledgerDir, existing.capUnits / 1e9)
      console.log(JSON.stringify(await ledger.reconcilePersistedUsage(), null, 2))
    } finally { await release() }
    return
  }
  if (command === 'continue') {
    if (!args.plan || args['allow-full100'] !== true) throw new Error('full100_requires_source_only_plan_and_explicit_flag')
    const rawPlan = await readJson(path.resolve(args.plan))
    const plan = validatePlan(rawPlan)
    if (plan.scope !== 'full100' || plan.samples.length !== 100) throw new Error('full100_manifest_requires_exactly_100_samples')
    const forward = (action, condition) => [action, ...Object.entries({ ...args, condition, split: 'full' }).flatMap(([key, value]) => value === true ? [`--${key}`] : [`--${key}`, String(value)])]
    // One explicit entry point. Conditions are fixed to the direct baseline and
    // the final S1, and each command still passes the phase/budget/manifest gates.
    await main(['status', '--campaign-dir', campaignRoot])
    for (const condition of ['D', 'S1']) await main(forward('estimate', condition))
    if (args['authorize-full'] === true) {
      // Reaching this branch requires the user's explicit manual launch command.
      // Creating the launcher/settings never executes this branch.
      const finalSnapshot = await readJson(path.join(campaignRoot, 'snapshots/S1/snapshot.json'))
      await validateSnapshot(finalSnapshot)
      const existingLedger = await readJson(path.join(ledgerDir, 'budget-ledger.json'))
      if (Number(args['budget-rmb']) !== existingLedger.capUnits / 1e9) throw new Error('budget_immutable_on_resume')
      const authorizationFile = path.join(campaignRoot, 'execution-authorization.json')
      const authorization = await readJson(authorizationFile)
      rawPlan.approved = true
      authorization.full100Authorization = {
        manuallyAuthorizedAt: new Date().toISOString(), planId: plan.planId,
        planHash: digest(validatePlan(rawPlan)), sourceHash: finalSnapshot.sourceHash,
        conditions: ['D', 'S1'], splits: ['full'], sampleIds: plan.samples.map(s => s.sampleId),
        full100Authorized: true, maxTokens: Number(args['max-tokens'] ?? 32768),
      }
      await saveJson(path.resolve(args.plan), rawPlan)
      await saveJson(authorizationFile, authorization)
      console.log(JSON.stringify({ full100ManuallyAuthorized: true, planId: plan.planId, budgetReset: false }))
    }
    for (const condition of ['D', 'S1']) await main(forward('resume', condition))
    return
  }
  const condition = args.condition
  if (!['D', 'S0', 'S1'].includes(condition)) throw new Error('condition_D_S0_or_S1_required')
  const snapshotDir = path.join(campaignRoot, 'snapshots', condition)
  if (command === 'freeze') {
    if (condition === 'D') throw new Error('D_uses_direct_prompt')
    const snapshot = await freezeProduct(repoRoot, snapshotDir)
    console.log(JSON.stringify({ condition, sourceHash: snapshot.sourceHash, files: snapshot.files.length }, null, 2))
    return
  }
  if (!args.plan || !['dev', 'holdout', 'full'].includes(args.split)) throw new Error('plan_and_split_required')
  const plan = validatePlan(await readJson(path.resolve(args.plan)))
  const samples = plan.samples.filter(s => s.split === args.split && (!args.sample || s.sampleId === args.sample))
  if (!samples.length) throw new Error('selected_split_empty')
  const maxTokens = Number(args['max-tokens'] ?? 32768)
  const reserveRmb = reserveUnits(maxTokens) / 1e9
  if (command === 'estimate') {
    console.log(JSON.stringify({
      condition, split: args.split, sampleCount: samples.length, samples: samples.length <= 6 ? samples.map(s => s.sampleId) : undefined,
      perPhysicalAttemptReserveRmb: reserveRmb,
      assumedPhysicalCallsPerSample: condition === 'D' ? 1 : condition === 'S0' ? 11 : '9 with frozen integrated review; otherwise 11',
      absoluteCampaignCapRmb: 10, maxTokens,
      empiricalEstimate: await empiricalEstimate(campaignRoot, condition, samples.length),
      note: 'The reservation is a whole-context peak-price upper bound, not an expected charge. Actual usage settles the ledger. No request sent.',
    }, null, 2))
    return
  }
  if (!['run', 'resume'].includes(command)) throw new Error('unknown_command')
  if (!plan.approved) throw new Error('plan_not_approved')
  // Root updates this separate phase gate only after the development tuning is frozen.
  const authorization = await readJson(path.join(campaignRoot, 'execution-authorization.json'))
  const phaseGate = plan.scope === 'full100' ? authorization.full100Authorization ?? {} : authorization
  if (!phaseGate.conditions?.includes(condition) || !phaseGate.splits?.includes(args.split)
      || samples.some(s => !phaseGate.sampleIds?.includes(s.sampleId))) throw new Error('outside_current_execution_authorization')
  if (phaseGate.notBefore && Date.now() < Date.parse(phaseGate.notBefore)) throw new Error('execution_not_before_authorized_time')
  if (phaseGate.maxTokens !== undefined && maxTokens !== phaseGate.maxTokens) throw new Error('authorized_token_cap_mismatch')
  if (plan.scope === 'full100' && phaseGate.full100Authorized !== true) throw new Error('full100_not_authorized')
  if (plan.scope === 'full100' && (phaseGate.planId !== plan.planId || phaseGate.planHash !== digest(plan))) throw new Error('full100_plan_changed_requires_manual_authorization')
  if (plan.scope === 'full100' && !['D', 'S1'].includes(condition)) throw new Error('full100_only_D_and_final_S1')
  if (plan.scope === 'full100' && args['allow-full100'] !== true) throw new Error('full100_requires_explicit_flag')
  const capRmb = Number(args['budget-rmb'])
  if (!Number.isFinite(capRmb) || capRmb <= 0 || capRmb > 10) throw new Error('explicit_budget_0_to_10_required')
  const runDir = path.join(campaignRoot, 'runs', plan.planId, condition, args.split)
  await mkdir(runDir, { recursive: true })
  const runMeta = {
    planId: plan.planId, condition, split: args.split, planHash: digest(plan), maxTokens,
    model: MODEL, reasoningEffort: 'high', toolsEnabled: false, budgetLedger: ledgerDir,
    adapter: { upstreamStreaming: true, outwardContentBuffered: true, reasoningRemovedBeforeProduct: true, physicalConcurrency: 1,
      forcedOutputCap: maxTokens, frozenSessionCapMayRemainLowerOnResume: true,
      version: condition === 'S1' ? 'bounded-retry-v2-official-route' : 'bounded-retry-v2-loopback',
      physicalAttemptsPerHashLimit: 4, completedReplayPolicy: 'product_checkpoint_only',
      responseFormatPolicy: 'product_supplied_only',
      timingCaveat: 'Gateway queueing and buffering are included. These durations are not native-product speed measurements.' },
  }
  const metaFile = path.join(runDir, 'run-meta.json')
  try {
    const prior = await readJson(metaFile)
    if (prior.planHash !== runMeta.planHash) throw new Error('run_manifest_changed')
    runMeta.adapterHistory = prior.adapterHistory ?? []
    if (prior.adapter?.version !== runMeta.adapter.version) runMeta.adapterHistory.push({
      previousAdapter: prior.adapter ?? null, nextAdapter: runMeta.adapter, changedAt: new Date().toISOString(),
    })
    if (prior.maxTokens !== maxTokens) {
      if (command !== 'resume' || maxTokens <= prior.maxTokens
          || typeof args['retry-reason'] !== 'string' || !args['retry-reason'].trim()) throw new Error('token_cap_change_requires_documented_resume')
      runMeta.generationHistory = [...(prior.generationHistory ?? []), {
        previousMaxTokens: prior.maxTokens, nextMaxTokens: maxTokens,
        reason: args['retry-reason'], changedAt: new Date().toISOString(),
      }]
      await saveJson(metaFile, runMeta)
    } else if (prior.generationHistory) runMeta.generationHistory = prior.generationHistory
  } catch (error) { if (error.code !== 'ENOENT') throw error; await saveJson(metaFile, runMeta) }
  let snapshot
  if (condition !== 'D') {
    snapshot = await readJson(path.join(snapshotDir, 'snapshot.json'))
    if (plan.scope === 'full100' && snapshot.sourceHash !== phaseGate.sourceHash) throw new Error('full100_frozen_source_changed_requires_manual_authorization')
    runMeta.sourceHash = snapshot.sourceHash
    await saveJson(metaFile, runMeta)
  }
  // The only credential source. Its contents are never copied, returned or logged.
  if (!args['credential-file']) throw new Error('credential_file_must_be_explicit')
  let privateConfig
  try { privateConfig = await readJson(path.resolve(args['credential-file'])) }
  catch { throw new Error('credential_file_invalid_or_unreadable') }
  const gateway = await createGateway({
    directory: ledgerDir, capRmb, apiKey: privateConfig.apiKey,
    fallbackProxy: privateConfig.fallbackProxy ?? null, maxTokens,
  })
  let product
  try {
    if (condition !== 'D') product = await startProduct(snapshot, path.join(snapshotDir, 'runtime-data'), { officialGatewayUrl: condition === 'S1' ? gateway.url : null })
    for (const sample of samples) {
      const checkpointFile = path.join(runDir, `${sample.sampleId}.json`)
      let previous
      try { previous = await readJson(checkpointFile) } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (previous?.status === 'completed') { console.log(JSON.stringify({ sampleId: sample.sampleId, status: 'reused_completed' })); continue }
      if (previous && command !== 'resume') throw new Error('existing_checkpoint_use_resume')
      const retryDecision = fullSampleRetryDecision(previous, args['retry-failed'] === true)
      let retryRound = previous?.runnerRetryCount ?? 0
      if (plan.scope === 'full100') {
        if (retryDecision.action === 'skip_failed') {
          console.log(JSON.stringify({ sampleId: sample.sampleId, condition, status: 'skipped_failed', reason: retryRound >= 1 ? 'sample_retry_limit' : 'explicit_retry_required' }))
          continue
        }
        if (retryDecision.action === 'retry_failed') {
          await saveJson(path.join(runDir, `${sample.sampleId}.before-retry-${retryDecision.retryRound}.json`), previous)
          retryRound = retryDecision.retryRound
          previous.runnerRetryCount = retryRound
          await saveJson(checkpointFile, previous)
        }
      }
      gateway.setContext({ planId: plan.planId, condition, split: sample.split, sampleId: sample.sampleId, retryRound })
      const started = Date.now()
      try {
        if (condition === 'D') {
          await saveJson(checkpointFile, { sampleId: sample.sampleId, status: 'prepared', runnerRetryCount: retryRound })
          const result = await runDirect(gateway, sample)
          await saveJson(checkpointFile, { sampleId: sample.sampleId, condition, split: sample.split, status: 'completed', finalProduced: true, protocolComplete: true, degraded: false, runnerRetryCount: retryRound, ...result, execution: { adapter: runMeta.adapter, maxTokens, requestedModel: MODEL, highSource: 'gateway_provider_override' }, elapsedWithGatewayMs: Date.now() - started })
        } else {
          const setup = await configureProduct(product.baseUrl, gateway, sample, path.join(runDir, `${sample.sampleId}.setup.json`), { officialRouting: condition === 'S1' })
          const result = await runProductSample({ baseUrl: product.baseUrl, sample, setup, checkpointFile, resume: command === 'resume' })
          result.execution = { ...result.execution, adapter: runMeta.adapter, maxTokens, requestedModel: MODEL, highSource: 'gateway_provider_override', sourceHash: snapshot.sourceHash, productBindingMaxTokens: setup.contract.defaultWorkerBinding?.maxOutputTokens ?? null }
          await saveJson(checkpointFile, result)
        }
      } catch (error) {
        if (plan.scope !== 'full100' || !isSampleOutputFailure(error)) throw error
        let failed
        try { failed = await readJson(checkpointFile) } catch { failed = { sampleId: sample.sampleId } }
        Object.assign(failed, { status: 'failed', finalProduced: failed.finalProduced === true, protocolComplete: failed.protocolComplete === true, degraded: failed.finalProduced === true && failed.protocolComplete !== true, runnerRetryCount: retryRound, failureCode: error.code ?? error.message, failedAt: new Date().toISOString() })
        await saveJson(checkpointFile, failed)
        await gateway.drain()
        const remaining = gateway.ledger.summary()
        console.log(JSON.stringify({ sampleId: sample.sampleId, condition, status: 'failed_recorded', failureCode: failed.failureCode, budget: remaining }))
        if (remaining.halted || remaining.availableRmb < reserveRmb) throw new Error('global_budget_or_provider_stop')
        continue
      }
      console.log(JSON.stringify({ sampleId: sample.sampleId, condition, status: 'completed', budget: gateway.ledger.summary() }))
    }
  } finally {
    await product?.close()
    await gateway.close()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ status: 'stopped', code: error.code ?? error.message })); process.exitCode = 1 })
}
