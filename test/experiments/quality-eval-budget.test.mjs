import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { BudgetLedger, acquireLock, costUnits, reserveUnits, saveJson, validateUsage } from '../../scripts/quality-eval/budget-ledger.mjs'
import { createGateway as createGatewayWithDefaults, LOCAL_KEY, normalizeRequest } from '../../scripts/quality-eval/gateway.mjs'
import { main, runDirect, validatePlan } from '../../scripts/quality-eval/runner.mjs'

const usage = { prompt_tokens: 100, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 80, completion_tokens: 30, total_tokens: 130 }
const createGateway = options => createGatewayWithDefaults({ maxTokens: 8192, ...options })
const settledCost = attempt => costUnits(usage) / (attempt.settlementBasis === 'offpeak_proven_whole_interval_with_5m_buffer' ? 2 : 1)
const temp = () => mkdtemp(path.join(os.tmpdir(), 'quality-eval-test-'))
const requestBody = { messages: [{ role: 'user', content: '试验原文' }], stream: true }
const response = (extra = {}) => {
  const data = [
    { model: 'provider-reported-model', id: 'provider-response-1', choices: [{ delta: { reasoning_content: 'PRIVATE_REASONING_NEVER_SAVE' }, finish_reason: null }] },
    { choices: [{ delta: { content: 'Translated source.' }, finish_reason: 'stop' }], usage },
  ]
  const result = Readable.from(data.map(item => `data: ${JSON.stringify(item)}\n\n`).concat('data: [DONE]\n\n').map(s => Buffer.from(s)))
  result.statusCode = 200
  return Object.assign(result, extra)
}
async function call(gateway, body = requestBody) {
  const r = await fetch(`${gateway.url}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${LOCAL_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return r.text()
}

test('reservation uses whole context and peak prices; reasoning is counted once', () => {
  assert.equal(reserveUnits(8192) / 1e9, 2.162688)
  assert.equal(reserveUnits(32768) / 1e9, 2.359296)
  assert.equal(costUnits(usage) / 1e9, 0.0004008)
  assert.equal(validateUsage({ ...usage, completion_tokens_details: { reasoning_tokens: 25 } }, 8192).completion_tokens, 30)
  assert.equal(validateUsage({ ...usage, prompt_cache_hit_tokens: 99 }, 8192), null)
  assert.equal(validateUsage({ ...usage, completion_tokens: 9000, total_tokens: 9100 }, 8192), null)
})

test('normalization enforces high Flash and excludes temperature/tools', () => {
  const result = normalizeRequest({ ...requestBody, temperature: 1, max_tokens: 999999, model: 'other' }, 8192)
  assert.equal(result.model, 'deepseek-flash')
  assert.equal(result.reasoning_effort, 'high')
  assert.deepEqual(result.thinking, { type: 'enabled' })
  assert.equal(result.max_tokens, 8192)
  assert.equal(result.temperature, undefined)
  assert.throws(() => normalizeRequest({ ...requestBody, tools: [{}] }), /tools_disabled/)
})

test('failure reserves remain across restart; cap cannot grow silently', async () => {
  const dir = await temp()
  const ledger = await BudgetLedger.open(dir, 10)
  for (let i = 0; i < 4; i++) {
    const a = await ledger.reserve(`r${i}`, 8192)
    await ledger.finish(a, { status: 'transport_error' })
  }
  const resumed = await BudgetLedger.open(dir, 10)
  assert.equal(resumed.summary().outstandingReserveRmb, 8.650752)
  await assert.rejects(resumed.reserve('r5', 8192), /budget_exhausted/)
  await assert.rejects(BudgetLedger.open(dir, 9), /budget_immutable/)
  await assert.rejects(BudgetLedger.open(dir, 11), /budget_must/)
})

test('truncated completion with complete usage settles its bill and remains failed', async () => {
  const ledger = await BudgetLedger.open(await temp(), 10)
  const attempt = await ledger.reserve('truncated', 8192)
  await ledger.finish(attempt, { status: 'output_truncated', usage })
  assert.equal(attempt.chargedUnits, settledCost(attempt))
  assert.deepEqual(attempt.observedUsage, usage)
  assert.ok(attempt.measuredUnits > 0)
  assert.equal(attempt.usageSettled, true)
  assert.equal(attempt.status, 'output_truncated')
  assert.equal(ledger.summary().outstandingReserveRmb, 0)
})

test('truncated completion without usage retains its full reserve across restart', async () => {
  const dir = await temp()
  const ledger = await BudgetLedger.open(dir, 10)
  const attempt = await ledger.reserve('truncated-unknown', 8192)
  await ledger.finish(attempt, { status: 'output_truncated', content: 'partial' })
  const resumed = await BudgetLedger.open(dir, 10)
  assert.equal(resumed.state.attempts[0].usageSettled, false)
  assert.equal(resumed.summary().outstandingReserveRmb, 2.162688)
  await resumed.reconcilePersistedUsage()
  assert.equal(resumed.summary().outstandingReserveRmb, 2.162688)
})

test('reconciliation settles saved usage without rewriting failed outputs or sending', async () => {
  const dir = await temp()
  const ledger = await BudgetLedger.open(dir, 10)
  const attempt = await ledger.reserve('reconcile-truncated', 8192)
  await ledger.finish(attempt, { status: 'output_truncated', usage, content: 'partial' })
  const resultPath = path.join(dir, attempt.resultFile)
  const before = await readFile(resultPath, 'utf8')
  // Model an older process that retained its reserve despite a trustworthy saved usage.
  attempt.usage = null; attempt.usageSettled = false; attempt.chargedUnits = reserveUnits(8192)
  await ledger.save()
  await ledger.reconcilePersistedUsage()
  assert.equal(attempt.status, 'output_truncated')
  assert.equal(attempt.chargedUnits, settledCost(attempt))
  assert.equal(await readFile(resultPath, 'utf8'), before)
})

test('crash after response persistence but before ledger pointer update is reconciled by attempt identity', async () => {
  const dir = await temp()
  const ledger = await BudgetLedger.open(dir, 10)
  const attempt = await ledger.reserve('response-persisted-ledger-not-yet', 32768)
  await saveJson(path.join(dir, 'responses', `${attempt.id}.json`), {
    attemptId: attempt.id, requestHash: attempt.requestHash, status: 'output_truncated',
    usage, content: 'partial', elapsedMs: 10, reasoningCharacters: 4,
    finishRecordedAt: new Date().toISOString(),
  })
  const recovered = await BudgetLedger.open(dir, 10)
  await recovered.reconcilePersistedUsage()
  const record = recovered.state.attempts[0]
  assert.equal(record.status, 'output_truncated')
  assert.equal(record.recoveredAfterResponsePersistence, true)
  assert.equal(record.usageSettled, true)
  assert.equal(record.chargedUnits, settledCost(record))
  assert.equal(recovered.summary().outstandingReserveRmb, 0)
})

test('recovered 402 without usage preserves halt and full reservation', async () => {
  const dir = await temp()
  const ledger = await BudgetLedger.open(dir, 10)
  const attempt = await ledger.reserve('persisted-402', 32768)
  await saveJson(path.join(dir, 'responses', `${attempt.id}.json`), {
    attemptId: attempt.id, requestHash: attempt.requestHash, status: 'http_error', httpStatus: 402, usage: null,
  })
  await ledger.reconcilePersistedUsage()
  assert.equal(ledger.summary().halted, true)
  assert.equal(ledger.summary().outstandingReserveRmb, 2.359296)
})

test('exclusive lock prevents parallel gateway owners', async () => {
  const dir = await temp()
  const release = await acquireLock(dir)
  await assert.rejects(acquireLock(dir), /gateway_locked/)
  await release()
  await (await acquireLock(dir))()
})

test('durable reservation precedes network; visible response is saved and native retry gets fresh output', async () => {
  const dir = await temp()
  let calls = 0
  const gateway = await createGateway({ directory: dir, capRmb: 10, apiKey: 'FAKE_TEST_SECRET', transport: async ({ body }) => {
    calls++
    const persisted = JSON.parse(await readFile(path.join(dir, 'budget-ledger.json'), 'utf8'))
    assert.equal(persisted.attempts.at(-1).status, 'reserved')
    assert.equal(body.max_tokens, 8192)
    return response()
  } })
  try {
    const first = await call(gateway)
    assert.match(first, /Translated source/)
    assert.doesNotMatch(first, /PRIVATE_REASONING|FAKE_TEST_SECRET/)
    await call(gateway)
    assert.equal(calls, 2)
    const record = gateway.ledger.state.attempts[0]
    const saved = await readFile(path.join(dir, record.resultFile), 'utf8')
    assert.doesNotMatch(saved, /PRIVATE_REASONING|FAKE_TEST_SECRET/)
    assert.equal(JSON.parse(saved).reasoningCharacters, 28)
    assert.equal(JSON.parse(saved).requestedModel, 'deepseek-flash')
    assert.equal(JSON.parse(saved).providerModel, 'provider-reported-model')
    assert.equal(JSON.parse(saved).providerResponseId, 'provider-response-1')
    assert.equal(gateway.ledger.summary().committedBudgetRmb, gateway.ledger.state.attempts.reduce((sum, a) => sum + settledCost(a), 0) / 1e9)
  } finally { await gateway.close() }
  const restarted = await createGateway({ directory: dir, capRmb: 10, apiKey: 'FAKE_TEST_SECRET', transport: async () => { calls++; return response() } })
  try { assert.match(await call(restarted), /Translated source/); assert.equal(calls, 3) } finally { await restarted.close() }
})

test('parallel callers serialize physical attempts and settle without crossing cap', async () => {
  let active = 0
  let peak = 0
  const gateway = await createGateway({ directory: await temp(), capRmb: 3, apiKey: 'fake', transport: async () => {
    active++; peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 10))
    active--
    return response()
  } })
  try {
    const results = await Promise.all([1, 2, 3, 4, 5].map(n => call(gateway, { ...requestBody, messages: [{ role: 'user', content: String(n) }] })))
    assert.equal(peak, 1)
    assert.equal(results.filter(s => s.includes('Translated source')).length, 5)
    assert.ok(gateway.ledger.summary().committedConservativeRmb <= 3)
  } finally { await gateway.close() }
})

test('502 fallback is separately reserved and failed requests have four total physical attempts', async () => {
  const routes = []
  const gateway = await createGateway({ directory: await temp(), capRmb: 10, apiKey: 'fake', fallbackProxy: 'http://127.0.0.1:7892', transport: async ({ proxy }) => {
    routes.push(proxy)
    return proxy ? response() : response({ statusCode: 502 })
  } })
  try {
    assert.match(await call(gateway), /Translated source/)
    assert.deepEqual(routes, [null, 'http://127.0.0.1:7892'])
    assert.equal(gateway.ledger.summary().outstandingReserveRmb, 2.162688)
    assert.equal(gateway.ledger.state.attempts[1].route, 'proxy_fallback')
  } finally { await gateway.close() }
  let sent = 0
  const failed = await createGateway({ directory: await temp(), capRmb: 10, apiKey: 'fake', transport: async () => { sent++; throw Object.assign(new Error('secret should not surface'), { code: 'connection_failure' }) } })
  try {
    for (let i = 0; i < 5; i++) await call(failed)
    assert.equal(sent, 4)
  } finally { await failed.close() }
})

test('missing usage halts all subsequent dispatch and retains full reserve', async () => {
  let sent = 0
  const gateway = await createGateway({ directory: await temp(), capRmb: 10, apiKey: 'fake', transport: async () => {
    sent++
    const result = Readable.from(['data: {"choices":[{"delta":{"content":"text"},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n'].map(s => Buffer.from(s)))
    result.statusCode = 200
    return result
  } })
  try {
    await call(gateway)
    await call(gateway, { ...requestBody, messages: [{ role: 'user', content: 'second' }] })
    assert.equal(sent, 1)
    assert.equal(gateway.ledger.summary().halted, true)
    assert.equal(gateway.ledger.summary().outstandingReserveRmb, 2.162688)
  } finally { await gateway.close() }
})

test('timeout keeps reserve and never triggers proxy fallback', async () => {
  let sent = 0
  const gateway = await createGateway({
    directory: await temp(), capRmb: 10, apiKey: 'fake', timeoutMs: 15,
    fallbackProxy: 'http://127.0.0.1:7892',
    transport: async ({ signal }) => new Promise((resolve, reject) => {
      sent++
      signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { code: 'upstream_timeout' })), { once: true })
    }),
  })
  try {
    await call(gateway)
    assert.equal(sent, 1)
    assert.equal(gateway.ledger.summary().outstandingReserveRmb, 2.162688)
  } finally { await gateway.close() }
})

test('402 halts new dispatch and low budget refuses before physical send', async () => {
  let sent = 0
  const gateway = await createGateway({ directory: await temp(), capRmb: 10, apiKey: 'fake', transport: async () => { sent++; return response({ statusCode: 402 }) } })
  try {
    await call(gateway)
    await call(gateway, { ...requestBody, messages: [{ role: 'user', content: 'another' }] })
    assert.equal(sent, 1)
    assert.equal(gateway.ledger.summary().halted, true)
  } finally { await gateway.close() }
  const tiny = await createGateway({ directory: await temp(), capRmb: 1, apiKey: 'fake', transport: async () => { sent++; return response() } })
  try { await call(tiny); assert.equal(sent, 1) } finally { await tiny.close() }
})

test('plan projection never sends reference translation or grade fields', () => {
  const plan = validatePlan({ planId: 'test', scope: 'pilot', approved: true, samples: [
    { sampleId: 'P1', split: 'dev', sourceText: '山水', taskBrief: 'Translate', astraTranslation: 'MUST_NOT_REACH_MODEL', score: 100 },
  ] })
  assert.doesNotMatch(JSON.stringify(plan), /MUST_NOT_REACH_MODEL|score/)
})

test('direct baseline parses the same body/annotation JSON contract', async () => {
  const gateway = await createGateway({ directory: await temp(), capRmb: 10, apiKey: 'fake', transport: async ({ body }) => {
    assert.match(body.messages[0].content, /JSON object/)
    const content = JSON.stringify({ body: 'The river is still.', annotation: '' })
    const result = Readable.from([Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`)])
    result.statusCode = 200
    return result
  } })
  try {
    assert.equal((await runDirect(gateway, { sourceText: '江水静。', taskBrief: 'Translate' })).content, 'The river is still.')
  } finally { await gateway.close() }
})

test('same-hash bounded retries are counted independently across sample conditions', async () => {
  let sent = 0
  const gateway = await createGateway({ directory: await temp(), capRmb: 10, apiKey: 'fake', transport: async () => { sent++; return response() } })
  try {
    gateway.setContext({ planId: 'p', condition: 'S0', split: 'dev', sampleId: 'P1' })
    for (let i = 0; i < 5; i++) await call(gateway)
    gateway.setContext({ planId: 'p', condition: 'S1', split: 'dev', sampleId: 'P1' })
    await call(gateway)
    assert.equal(sent, 5)
    assert.equal(gateway.ledger.state.attempts[0].context.condition, 'S0')
    assert.equal(gateway.ledger.state.attempts[4].context.condition, 'S1')
  } finally { await gateway.close() }
})

for (const failure of ['malformed_frame', 'connection_reset', 'invalid_usage_then_reset']) {
  test(`known usage remains settled after ${failure}`, async () => {
    const gateway = await createGateway({ directory: await temp(), capRmb: 10, apiKey: 'fake', transport: async () => {
      const result = Readable.from((async function* () {
        yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' }, finish_reason: 'stop' }], usage })}\n\n`)
        if (failure === 'malformed_frame') yield Buffer.from('data: {broken\n\n')
        else {
          if (failure === 'invalid_usage_then_reset') yield Buffer.from(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: -1 } })}\n\n`)
          throw Object.assign(new Error('reset'), { code: 'ECONNRESET' })
        }
      })())
      result.statusCode = 200
      return result
    } })
    try {
      await call(gateway)
      const attempt = gateway.ledger.state.attempts[0]
      assert.equal(attempt.status, 'transport_error')
      assert.equal(attempt.usageSettled, true)
      assert.equal(attempt.chargedUnits, settledCost(attempt))
      assert.equal(gateway.ledger.summary().outstandingReserveRmb, 0)
    } finally { await gateway.close() }
  })
}

test('non-200 bounded JSON usage is settled while the response remains failed', async () => {
  const gateway = await createGateway({ directory: await temp(), capRmb: 10, apiKey: 'fake', transport: async () => {
    const result = Readable.from([Buffer.from(JSON.stringify({ error: { message: 'failed' }, usage }))])
    result.statusCode = 500
    return result
  } })
  try {
    await call(gateway)
    const attempt = gateway.ledger.state.attempts[0]
    assert.equal(attempt.status, 'http_error')
    assert.equal(attempt.httpStatus, 500)
    assert.equal(attempt.usageSettled, true)
    assert.equal(attempt.chargedUnits, settledCost(attempt))
  } finally { await gateway.close() }
})

test('malformed private settings and credential JSON produce fixed errors without source snippets', async () => {
  const directory = await temp()
  const bad = path.join(directory, 'private-invalid.json')
  await writeFile(bad, 'FAKE_PRIVATE_VALUE_NEVER_PRINT', 'utf8')
  await assert.rejects(main(['status', '--settings', bad]), error => error.message === 'settings_file_invalid_or_unreadable')
  const plan = path.join(directory, 'plan.json')
  await saveJson(plan, { planId: 'redaction-probe', scope: 'pilot', approved: true, samples: [{ sampleId: 'P1', split: 'dev', sourceText: '原文', taskBrief: 'Translate' }] })
  await saveJson(path.join(directory, 'execution-authorization.json'), { conditions: ['D'], splits: ['dev'], sampleIds: ['P1'], maxTokens: 32768 })
  await assert.rejects(main(['run', '--campaign-dir', directory, '--credential-file', bad, '--plan', plan, '--condition', 'D', '--split', 'dev', '--budget-rmb', '10']),
    error => error.message === 'credential_file_invalid_or_unreadable')
  await assert.rejects(readFile(path.join(directory, 'global-budget/budget-ledger.json')), { code: 'ENOENT' })
})
