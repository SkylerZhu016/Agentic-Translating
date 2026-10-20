import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { normalizeRequest } from '../../scripts/quality-eval/gateway.mjs'
const require = createRequire(import.meta.url)
const { createRestrictedFetch } = require('../../scripts/quality-eval/official-route-preload.cjs')
const key = 'quality-eval-loopback-only'
const init = { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify({ response_format: { type: 'json_object' }, messages: [{ role: 'user', content: 'source' }] }) }

test('only the exact official target with fake key is rerouted without changing body', async () => {
  const calls = []
  const routed = createRestrictedFetch(async (url, options) => { calls.push({ url, options }); return 'ok' }, 'http://127.0.0.1:9999')
  assert.equal(await routed('https://api.deepseek.com/chat/completions', init), 'ok')
  assert.equal(calls[0].url, 'http://127.0.0.1:9999/v1/chat/completions')
  assert.equal(calls[0].options.body, init.body)
  assert.equal(calls[0].options.headers.get('authorization'), `Bearer ${key}`)
  assert.equal(calls[0].options.redirect, 'error')
  await routed('https://api.deepseek.com/v1/chat/completions', init)
  assert.equal(calls.length, 2)
})

test('fake key never reaches aliases, extra paths, query strings, non-POST or malformed official calls', async () => {
  let forwarded = 0
  const routed = createRestrictedFetch(async () => { forwarded++ }, 'http://127.0.0.1:9999')
  for (const url of [
    'https://api.deepseek.com.evil.test/chat/completions',
    'http://api.deepseek.com/chat/completions',
    'https://api.deepseek.com/models',
    'https://api.deepseek.com/chat/completions?x=1',
    'https://user:pass@api.deepseek.com/chat/completions',
    'https://api.deepseek.com:444/chat/completions',
    'https://other.test/chat/completions',
  ]) await assert.rejects(routed(url, init), /route_blocked/)
  await assert.rejects(routed('https://api.deepseek.com/chat/completions', { ...init, method: 'GET' }), /route_blocked/)
  await assert.rejects(routed('https://api.deepseek.com/chat/completions', { ...init, headers: {} }), /route_blocked/)
  assert.equal(forwarded, 0)
})

test('unrelated local product fetches pass through and gateway cannot target external host', async () => {
  const routed = createRestrictedFetch(async url => url, 'http://127.0.0.1:9999')
  assert.equal(await routed('http://127.0.0.1:3000/api/health', {}), 'http://127.0.0.1:3000/api/health')
  assert.throws(() => createRestrictedFetch(async () => {}, 'https://other.test'), /invalid_loopback/)
})

test('gateway preserves product JSON mode but never injects it for old S0 requests', () => {
  const plain = { messages: [{ role: 'user', content: 'source' }] }
  assert.equal(normalizeRequest(plain).response_format, undefined)
  assert.deepEqual(normalizeRequest({ ...plain, response_format: { type: 'json_object' } }).response_format, { type: 'json_object' })
  assert.throws(() => normalizeRequest({ ...plain, response_format: { type: 'json_schema', schema: {} } }), /unsupported_product/)
})
