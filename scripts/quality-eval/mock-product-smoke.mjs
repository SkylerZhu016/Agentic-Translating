import path from 'node:path'
import { Readable } from 'node:stream'
import { digest, readJson, saveJson } from './budget-ledger.mjs'
import { createGateway } from './gateway.mjs'
import { configureProduct, runProductSample, startProduct } from './product-client.mjs'
import { parseCli } from './runner.mjs'

// Always uses a fake transport. This entry point never reads credentials.
const { args } = parseCli(['mock', ...process.argv.slice(2)])
if (!args['campaign-dir']) throw new Error('campaign_dir_required')
const campaignRoot = path.resolve(args['campaign-dir'])
const directory = path.resolve(args['output-dir'] ?? path.join(campaignRoot, 'mock-product-smoke-v3'))
const snapshot = await readJson(path.join(path.resolve(args['snapshot-dir'] ?? path.join(campaignRoot, 'snapshots/S0')), 'snapshot.json'))
let dispatches = 0
let malformedHash = null
let recoveredSameHash = false
let productJsonModeCalls = 0
const gateway = await createGateway({
  directory: path.join(directory, 'mock-budget'), capRmb: 10, apiKey: 'MOCK_ONLY',
  transport: async ({ body }) => {
    dispatches++
    if (body.tools || body.reasoning_effort !== 'high') throw new Error('invalid_request_policy')
    if (body.response_format?.type === 'json_object') productJsonModeCalls++
    if (args['official-route'] === true && body.response_format?.type !== 'json_object') throw new Error('product_json_mode_not_received')
    const requestHash = digest(body)
    const injectMalformed = args['retry-probe'] === true && dispatches === 1
    if (injectMalformed) malformedHash = requestHash
    else if (requestHash === malformedHash) recoveredSameHash = true
    const content = injectMalformed
      ? '{"body":"An unescaped\nnewline","annotation":""}'
      : JSON.stringify({ body: 'The wind in the mountains was gentle. He closed the door and quietly walked away.', annotation: '' })
    const usage = { prompt_tokens: 100, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100, completion_tokens: 40, total_tokens: 140 }
    const chunks = [
      { choices: [{ index: 0, delta: { reasoning_content: 'MOCK_REASONING_REMOVED' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }], usage },
    ].map(value => Buffer.from(`data: ${JSON.stringify(value)}\n\n`))
    chunks.push(Buffer.from('data: [DONE]\n\n'))
    const result = Readable.from(chunks)
    result.statusCode = 200
    return result
  },
})
let product
try {
  product = await startProduct(snapshot, path.join(directory, 'runtime-data'), { officialGatewayUrl: args['official-route'] === true ? gateway.url : null })
  const sample = { sampleId: 'MOCK-PROSE', split: 'dev', sourceText: '山间的风很轻。他关上门，静静地走了。', taskBrief: 'Translate into natural English. Preserve the meaning and tone.', constraints: { poetryMode: 'off' } }
  const setup = await configureProduct(product.baseUrl, gateway, sample, path.join(directory, 'setup.json'), { officialRouting: args['official-route'] === true })
  const checkpointFile = path.join(directory, 'checkpoint.json')
  const result = await runProductSample({ baseUrl: product.baseUrl, sample, setup, checkpointFile, resume: true, timeoutMs: 120_000 })
  const beforeReplay = dispatches
  const replay = await runProductSample({ baseUrl: product.baseUrl, sample, setup, checkpointFile, resume: true, timeoutMs: 120_000 })
  if (dispatches !== beforeReplay || replay.status !== 'completed') throw new Error('resume_dispatched_duplicate')
  if (result.productEvidence.invocations.length !== 5 || result.productEvidence.invocations.some(item => item.status !== 'complete')) throw new Error('context_or_candidate_not_complete')
  if (result.productEvidence.stages.length !== 4 || result.productEvidence.stages.some(item => item.status !== 'complete')) throw new Error('editorial_stage_not_complete')
  if (args['retry-probe'] === true && !recoveredSameHash) throw new Error('native_retry_did_not_receive_fresh_response')
  const report = {
    status: 'passed', realPaidRequests: 0, mockPhysicalRequests: dispatches,
    condition: 'Frozen product fixed team + three candidates + four_stage',
    reviewStrategy: result.execution?.reviewStrategy ?? 'unrecorded',
    sessionId: result.sessionId, finalContentPresent: Boolean(result.content),
    stages: result.productEvidence.stages.map(stage => ({ stage: stage.stage, status: stage.status })),
    invocations: result.productEvidence.invocations.length,
    sourceHash: snapshot.sourceHash, reasoningNotPersistedByGateway: true,
    resumeAdditionalRequests: dispatches - beforeReplay,
    nativeRetryFreshResponse: args['retry-probe'] === true ? recoveredSameHash : null,
    officialRouteEnabled: args['official-route'] === true,
    productSuppliedJsonModeCalls: productJsonModeCalls,
    maxTokens: gateway.maxTokens,
    budgetAttemptCount: gateway.ledger.state.attempts.length,
  }
  await saveJson(path.join(directory, 'report.json'), report)
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', code: error.code ?? error.message, mockPhysicalRequests: dispatches }))
  process.exitCode = 1
} finally {
  await product?.close()
  await gateway.close()
}
