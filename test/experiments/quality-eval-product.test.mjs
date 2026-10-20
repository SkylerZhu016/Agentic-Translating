import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { readJson, saveJson } from '../../scripts/quality-eval/budget-ledger.mjs'
import { configureProduct, productCompleteness, runProductSample } from '../../scripts/quality-eval/product-client.mjs'

async function fakeProduct(handler) {
  const server = http.createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    await handler(request, response, raw ? JSON.parse(raw) : null)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) }
}
const send = (response, data, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)) }
const invocation = (agent, roleKind = 'candidate', analysisIndex, status = 'complete') => ({
  id: `${agent}-${analysisIndex ?? 0}`, agent_variant_id: agent, status,
  agent_snapshot: JSON.stringify({ roleKind, analysisIndex }),
})
const fullDetail = () => ({
  finalVersion: { text: 'A complete final translation.' },
  runs: [{ status: 'complete' }],
  invocations: [
    invocation('context', 'context_analysis', 1), invocation('context', 'context_analysis', 2),
    invocation('a'), invocation('b'), invocation('c'),
  ],
  stages: ['review', 'filter', 'orchestrate', 'assemble'].map(stage => ({ stage, status: 'complete' })),
})

test('final output and complete protocol remain distinct for degraded product recovery', () => {
  const detail = fullDetail()
  assert.equal(productCompleteness(detail).protocolComplete, true)
  detail.invocations[0].status = 'failed'
  detail.invocations[2].status = 'failed'
  const result = productCompleteness(detail)
  assert.equal(result.finalProduced, true)
  assert.equal(result.protocolComplete, false)
  assert.equal(result.degraded, true)
  assert.equal(result.protocolEvidence.failedCurrent.length, 2)
})

test('resume reuses preset revision after session creation response was lost', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-product-'))
  const setupFile = path.join(directory, 'setup.json')
  const checkpointFile = path.join(directory, 'checkpoint.json')
  const setup = { endpointId: 7, presetRevisionId: 'frozen-preset', contract: { agentVariantIds: ['a', 'b', 'c'] } }
  await saveJson(setupFile, setup)
  let firstCreate
  let createCount = 0
  let presetCreates = 0
  const server = await fakeProduct(async (req, res, body) => {
    if (req.url === '/api/endpoints' && req.method === 'GET') return send(res, [{ id: 7, name: 'quality-eval-budget-gateway' }])
    if (req.url === '/api/endpoints/7') return send(res, { id: 7, ...body })
    if (req.url.startsWith('/api/model-profiles/')) return send(res, body)
    if (req.url === '/api/workflow-presets') { presetCreates++; return send(res, {}, 500) }
    if (req.url === '/api/sessions' && req.method === 'POST') {
      createCount++
      if (!firstCreate) { firstCreate = body; return res.destroy() }
      assert.deepEqual(body, firstCreate)
      return send(res, { id: 'persisted-session' })
    }
    if (req.url === '/api/sessions/persisted-session') return send(res, fullDetail())
    return send(res, { error: 'unexpected_path' }, 500)
  })
  const sample = { sampleId: 'P1', sourceText: '原文', taskBrief: 'Translate', constraints: {} }
  const gateway = { url: 'http://127.0.0.1:12345', maxTokens: 32768 }
  try {
    const initialSetup = await configureProduct(server.url, gateway, sample, setupFile)
    await assert.rejects(runProductSample({ baseUrl: server.url, sample, setup: initialSetup, checkpointFile }))
    assert.equal((await readJson(checkpointFile)).sessionId, undefined)
    const resumedSetup = await configureProduct(server.url, gateway, sample, setupFile)
    const result = await runProductSample({ baseUrl: server.url, sample, setup: resumedSetup, checkpointFile, resume: true })
    assert.equal(result.status, 'completed')
    assert.equal(result.protocolComplete, true)
    assert.equal(presetCreates, 0)
    assert.equal(createCount, 2)
  } finally { await server.close() }
})

test('preset committed before its create response was lost is recovered by deterministic name', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-preset-'))
  const setupFile = path.join(directory, 'setup.json')
  let stored
  let posts = 0
  const variants = ['semantic-fidelity', 'target-naturalness', 'voice-register', 'cultural-context'].map(archetypeId => ({
    id: `${archetypeId}.zh-to-en`, archetypeId, direction: 'zh_to_en',
  }))
  const server = await fakeProduct(async (req, res, body) => {
    if (req.url === '/api/endpoints') return send(res, [{ id: 7, name: 'quality-eval-budget-gateway' }])
    if (req.url === '/api/endpoints/7') return send(res, { id: 7, ...body })
    if (req.url.startsWith('/api/model-profiles/')) return send(res, body)
    if (req.url === '/api/workflow-presets?direction=zh_to_en') return send(res, stored ? [{ id: 'saved', name: stored.name, currentRevisionNo: 1 }] : [])
    if (req.url === '/api/workflow-presets/saved') return send(res, { preset: { currentRevisionNo: 1 }, revisions: [{ id: 'saved-revision', revisionNo: 1, contract: stored.contract }] })
    if (req.url.startsWith('/api/agent-catalog?')) return send(res, { variants })
    if (req.url.startsWith('/api/agent-catalog/')) return send(res, body)
    if (req.url.startsWith('/api/direction-prompt-bundles')) return send(res, { direction: 'zh_to_en', version: 1 })
    if (req.url === '/api/workflow-presets' && req.method === 'POST') { posts++; stored = body; res.destroy(); return }
    return send(res, { error: 'unexpected' }, 500)
  })
  const sample = { sampleId: 'P1', constraints: {} }
  const gateway = { url: 'http://127.0.0.1:12345', maxTokens: 32768 }
  try {
    await assert.rejects(configureProduct(server.url, gateway, sample, setupFile))
    const recovered = await configureProduct(server.url, gateway, sample, setupFile)
    assert.equal(posts, 1)
    assert.equal(recovered.presetRevisionId, 'saved-revision')
    assert.equal(recovered.recoveredAfterCreateResponseLoss, true)
    assert.equal((await readJson(setupFile)).presetRevisionId, 'saved-revision')
  } finally { await server.close() }
})
