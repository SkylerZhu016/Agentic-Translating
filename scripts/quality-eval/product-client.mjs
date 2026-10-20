import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, symlink, stat } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { digest, readJson, saveJson, MODEL } from './budget-ledger.mjs'
import { LOCAL_KEY } from './gateway.mjs'

const ROOT_FILES = ['package.json', 'tsconfig.json', 'next.config.ts', 'next-env.d.ts', 'instrumentation.ts', 'postcss.config.mjs']
const DEFAULT_TEAM = ['semantic-fidelity.zh-to-en', 'target-naturalness.zh-to-en', 'voice-register.zh-to-en']
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function freezeProduct(repoRoot, snapshotDirectory) {
  try { return await readJson(path.join(snapshotDirectory, 'snapshot.json')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const tree = path.join(snapshotDirectory, 'workspace')
  await mkdir(tree, { recursive: true })
  const files = []
  const copy = async relative => {
    const from = path.join(repoRoot, relative)
    const to = path.join(tree, relative)
    const info = await stat(from)
    if (info.isDirectory()) {
      await mkdir(to, { recursive: true })
      for (const entry of await readdir(from)) await copy(path.join(relative, entry))
    } else {
      await copyFile(from, to)
      files.push({ path: relative.replaceAll('\\', '/'), sha256: createHash('sha256').update(await readFile(to)).digest('hex') })
    }
  }
  for (const relative of [...ROOT_FILES, 'app', 'src']) await copy(relative)
  await symlink(path.join(repoRoot, 'node_modules'), path.join(tree, 'node_modules'), 'junction')
  const snapshot = { version: 1, createdAt: new Date().toISOString(), workspace: tree, files, sourceHash: digest(files) }
  await saveJson(path.join(snapshotDirectory, 'snapshot.json'), snapshot)
  return snapshot
}

export async function validateSnapshot(snapshot) {
  for (const file of snapshot.files.filter(f => !['tsconfig.json', 'next-env.d.ts'].includes(f.path))) {
    const bytes = await readFile(path.join(snapshot.workspace, file.path))
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('frozen_product_changed')
  }
}

async function availablePort() {
  const socket = net.createServer()
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve) })
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  return port
}

export async function startProduct(snapshot, dataDirectory, { officialGatewayUrl = null } = {}) {
  await validateSnapshot(snapshot)
  await mkdir(dataDirectory, { recursive: true })
  const port = await availablePort()
  const log = createWriteStream(path.join(dataDirectory, 'product-runtime.log'), { flags: 'a' })
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'COMSPEC', 'PATHEXT'].includes(key.toUpperCase())))
  Object.assign(env, { AGENTIC_DATA_DIR: dataDirectory, AGENTIC_NEXT_DEV_SERVER: '1', AGENTIC_NEXT_DIST_DIR: '.next-web-dev', NEXT_TELEMETRY_DISABLED: '1' })
  if (officialGatewayUrl) {
    const preload = fileURLToPath(new URL('./official-route-preload.cjs', import.meta.url))
    env.NODE_OPTIONS = `--require "${preload.replaceAll('\\', '/')}"`
    env.QUALITY_EVAL_GATEWAY_URL = officialGatewayUrl
  }
  const child = spawn(process.execPath, [path.join(snapshot.workspace, 'node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: snapshot.workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  const baseUrl = `http://127.0.0.1:${port}`
  let ready = false
  try {
    for (let index = 0; index < 120; index += 1) {
      if (child.exitCode !== null) throw new Error('isolated_product_exited')
      try {
        const response = await fetch(`${baseUrl}/api/health/ready`, { signal: AbortSignal.timeout(5000) })
        if (response.ok) { ready = true; break }
      } catch {}
      await sleep(1000)
    }
    if (!ready) throw new Error('isolated_product_not_ready')
  } catch (error) { child.kill(); log.end(); throw error }
  return {
    baseUrl,
    close: async () => {
      // Only the process tree created here is stopped. A PID is never loaded from disk.
      if (process.platform === 'win32' && child.pid && child.exitCode === null) {
        await new Promise(resolve => {
          const stop = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          stop.once('exit', resolve); stop.once('error', resolve)
        })
      } else child.kill()
      log.end()
    },
  }
}

export async function productApi(baseUrl, pathname, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(120_000),
  })
  const result = await response.json()
  if (!response.ok) {
    const error = new Error(`product_api_${response.status}:${pathname}`)
    error.status = response.status
    // Isolated product has only a fake key, but keep diagnostics limited anyway.
    error.code = typeof result.error === 'string' ? result.error : 'product_api_failed'
    throw error
  }
  return result
}

export async function configureProduct(baseUrl, gateway, sample, setupFile, { officialRouting = false } = {}) {
  const endpoints = await productApi(baseUrl, '/api/endpoints')
  let endpoint = endpoints.find(e => e.name === 'quality-eval-budget-gateway')
  const input = { name: 'quality-eval-budget-gateway', base_url: officialRouting ? 'https://api.deepseek.com' : gateway.url, chat_completions_path: '/v1/chat/completions', api_key: LOCAL_KEY, context_window: 1_048_576 }
  if (endpoint) endpoint = await productApi(baseUrl, `/api/endpoints/${endpoint.id}`, input, 'PUT')
  else endpoint = await productApi(baseUrl, '/api/endpoints', input)
  const binding = { endpointId: endpoint.id, model: MODEL, contextWindow: 1_048_576, maxOutputTokens: gateway.maxTokens }
  const profile = Object.fromEntries(['defaultWorker', 'mainAgent', 'reviewAgent', 'filterAgent', 'orchestrateAgent', 'assembleAgent', 'editingAgent'].map(key => [key, binding]))
  await productApi(baseUrl, '/api/model-profiles/zh_to_en', profile, 'PUT')
  // Reuse the exact preset revision. A session may already exist even if its
  // create response was lost before the sessionId checkpoint was persisted.
  try {
    const existing = await readJson(setupFile)
    if (existing.endpointId !== endpoint.id || !existing.presetRevisionId) throw new Error('saved_setup_endpoint_mismatch')
    return existing
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const presetName = `quality-eval-${sample.sampleId}-${digest(setupFile).slice(0, 10)}`
  const existingPresets = await productApi(baseUrl, '/api/workflow-presets?direction=zh_to_en')
  const recoveredPreset = existingPresets.find(item => item.name === presetName)
  if (recoveredPreset) {
    const detail = await productApi(baseUrl, `/api/workflow-presets/${recoveredPreset.id}`)
    const revision = detail.revisions.find(item => item.revisionNo === detail.preset.currentRevisionNo)
    if (!revision?.id || revision.contract?.defaultWorkerBinding?.endpointId !== endpoint.id) throw new Error('recovered_preset_binding_mismatch')
    const setup = { endpointId: endpoint.id, presetRevisionId: revision.id, contract: revision.contract, recoveredAfterCreateResponseLoss: true }
    await saveJson(setupFile, setup)
    return setup
  }
  const catalog = await productApi(baseUrl, '/api/agent-catalog?direction=zh_to_en&includeDisabled=1')
  const ids = sample.allowedAgentVariantIds ?? DEFAULT_TEAM
  if (ids.length < 2 || ids.length > 3 || new Set(ids).size !== ids.length) throw new Error('pilot_team_requires_two_or_three_distinct_candidates')
  const variants = ids.map(id => catalog.variants.find(v => v.id === id))
  if (variants.some(v => !v || v.archetypeId === 'cultural-context')) throw new Error('unknown_candidate')
  const cultural = catalog.variants.find(v => v.archetypeId === 'cultural-context')
  if (!cultural) throw new Error('context_analysis_agent_missing')
  // These are public product settings in the isolated database.
  for (const variant of catalog.variants) {
    await productApi(baseUrl, `/api/agent-catalog/${encodeURIComponent(variant.id)}`, {
      enabled: ids.includes(variant.id) || variant.archetypeId === 'cultural-context',
      endpointOverrideId: endpoint.id, modelOverride: MODEL,
    }, 'PATCH')
  }
  const bundles = await productApi(baseUrl, '/api/direction-prompt-bundles?direction=zh_to_en')
  const bundleList = Array.isArray(bundles) ? bundles : bundles.bundles ?? [bundles]
  const bundle = bundleList.filter(b => b.direction === 'zh_to_en').sort((a, b) => b.version - a.version)[0]
  if (!bundle) throw new Error('direction_bundle_missing')
  const contract = {
    sourceLang: '中文', targetLang: '英文', taskBriefTemplate: '',
    teamPolicy: 'fixed', reviewMode: 'four_stage', mainEditorRunMode: 'fixed_pipeline',
    candidateAnnotationMode: 'body_only', agentVariantIds: [...ids, cultural.id],
    agentVariantSnapshots: [...variants, cultural].map(v => ({ ...v, enabled: true, endpointOverrideId: endpoint.id, modelOverride: MODEL })),
    defaultWorkerBinding: binding, agentBindingOverrides: {}, mainAgentBinding: binding,
    reviewAgentBinding: binding, filterAgentBinding: binding, orchestrateAgentBinding: binding,
    assembleAgentBinding: binding, editingAgentBinding: binding,
    contextAnalysisBindings: [binding, binding],
    promptBundleVersion: bundle.version, maxAgentCalls: ids.length, batchConcurrency: 1,
    constraints: sample.constraints ?? {},
  }
  const result = await productApi(baseUrl, '/api/workflow-presets', {
    name: presetName, description: 'Frozen fixed-team quality evaluation', direction: 'zh_to_en', contract,
  })
  const setup = { endpointId: endpoint.id, presetRevisionId: result.revision.id, contract, bundle }
  await saveJson(setupFile, setup)
  return setup
}

export function productCompleteness(detail, reviewStrategy = 'unrecorded') {
  const latest = new Map()
  for (const invocation of detail.invocations ?? []) {
    let snapshot = {}
    try { snapshot = JSON.parse(invocation.agent_snapshot ?? '{}') } catch {}
    const kind = snapshot.roleKind ?? 'candidate'
    if (!['candidate', 'context_analysis'].includes(kind)) continue
    const key = kind === 'context_analysis' ? `${kind}:${snapshot.analysisIndex}` : `${kind}:${invocation.agent_variant_id}`
    latest.set(key, { kind, status: invocation.status, id: invocation.id, error: invocation.error ?? null })
  }
  const current = [...latest.values()]
  const contextComplete = current.filter(i => i.kind === 'context_analysis' && i.status === 'complete').length
  const candidateComplete = current.filter(i => i.kind === 'candidate' && i.status === 'complete').length
  const stagesComplete = (detail.stages ?? []).filter(s => s.status === 'complete').length
  const finalProduced = Boolean(detail.finalVersion?.text?.trim())
  const protocolComplete = finalProduced && contextComplete === 2 && candidateComplete === 3 && stagesComplete === 4
  return {
    finalProduced, protocolComplete, degraded: finalProduced && !protocolComplete,
    protocolEvidence: {
      expected: { contextAnalyses: 2, candidates: 3, editorialStages: 4 },
      reviewStrategy,
      expectedReviewPhysicalCallsWithoutRetries: reviewStrategy === 'integrated-v1' ? 1 : reviewStrategy === 'three_lens' ? 3 : null,
      complete: { contextAnalyses: contextComplete, candidates: candidateComplete, editorialStages: stagesComplete },
      failedCurrent: current.filter(i => i.status !== 'complete'),
      failedHistoricalInvocations: (detail.invocations ?? []).filter(i => i.status === 'failed').map(i => ({ id: i.id, agent: i.agent_variant_id, error: i.error ?? null })),
    },
  }
}

export async function runProductSample({ baseUrl, sample, setup, checkpointFile, resume = false, timeoutMs = 60 * 60 * 1000 }) {
  let checkpoint
  try { checkpoint = await readJson(checkpointFile) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (checkpoint?.status === 'completed') return checkpoint
  if (!checkpoint) {
    checkpoint = { version: 1, sampleId: sample.sampleId, clientRequestId: randomUUID(), status: 'prepared' }
    await saveJson(checkpointFile, checkpoint)
  } else if (!resume) throw new Error('checkpoint_exists_use_resume')
  const reviewStrategy = typeof setup.bundle?.reviewPrompt === 'string'
    ? setup.bundle.reviewPrompt.includes('[review:integrated-v1]') ? 'integrated-v1' : 'three_lens'
    : checkpoint.execution?.reviewStrategy ?? 'unrecorded'
  checkpoint.execution = { ...checkpoint.execution, reviewStrategy }
  if (!checkpoint.sessionId) {
    const session = await productApi(baseUrl, '/api/sessions', {
      clientRequestId: checkpoint.clientRequestId, sourceText: sample.sourceText,
      taskBrief: sample.taskBrief ?? '', direction: 'zh_to_en', reviewMode: 'four_stage',
      mainEditorRunMode: 'fixed_pipeline', presetRevisionId: setup.presetRevisionId,
      allowedAgentVariantIds: setup.contract.agentVariantIds, constraints: sample.constraints ?? {},
    })
    checkpoint.sessionId = session.id
    await saveJson(checkpointFile, checkpoint)
  }
  const previous = await productApi(baseUrl, `/api/sessions/${checkpoint.sessionId}`)
  if (!previous.finalVersion) {
    const started = await productApi(baseUrl, `/api/sessions/${checkpoint.sessionId}/run`, { configMode: 'frozen' })
    checkpoint.runId = started.runId ?? started.id
    checkpoint.status = 'running'
    await saveJson(checkpointFile, checkpoint)
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const detail = await productApi(baseUrl, `/api/sessions/${checkpoint.sessionId}`)
    const lastRun = detail.runs?.at(-1)
    if (detail.finalVersion?.text && ['complete', 'completed', 'done'].includes(lastRun?.status ?? detail.session?.status)) {
      checkpoint.status = 'completed'
      checkpoint.content = detail.finalVersion.text
      Object.assign(checkpoint, productCompleteness(detail, reviewStrategy))
      checkpoint.finishedAt = new Date().toISOString()
      checkpoint.productEvidence = detail
      await saveJson(checkpointFile, checkpoint)
      return checkpoint
    }
    if (['failed', 'cancelled', 'canceled', 'paused', 'interrupted'].includes(lastRun?.status)) {
      checkpoint.status = lastRun.status
      Object.assign(checkpoint, productCompleteness(detail, reviewStrategy))
      checkpoint.productEvidence = detail
      await saveJson(checkpointFile, checkpoint)
      throw new Error(`product_run_${lastRun.status}`)
    }
    await sleep(2500)
  }
  checkpoint.status = 'monitor_timeout'
  await saveJson(checkpointFile, checkpoint)
  throw new Error('product_monitor_timeout')
}
