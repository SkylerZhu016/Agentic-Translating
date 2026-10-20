import test from 'node:test'
import assert from 'node:assert/strict'
import { confirmedOffpeakWindow, reserveUnits, usageSettlement } from '../../scripts/quality-eval/budget-ledger.mjs'

const usage = { prompt_tokens: 100, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 80, completion_tokens: 30, total_tokens: 130 }
test('whole-context peak reservation is independent of settlement band', () => {
  assert.equal(reserveUnits(32768) / 1e9, 2.359296)
})
test('early morning in UTC+8 settles known usage offpeak and retains peak risk indicator', () => {
  const result = usageSettlement(usage, '2026-10-20T17:00:00Z', '2026-10-20T17:15:00Z')
  assert.equal(result.chargedUnits / 1e9, 0.0002004)
  assert.equal(result.peakUsageUnits / 1e9, 0.0004008)
  assert.match(result.settlementBasis, /offpeak_proven/)
})
test('five minute buffer disqualifies calls approaching the morning peak', () => {
  assert.equal(confirmedOffpeakWindow('2026-10-21T00:40:00Z', '2026-10-21T00:54:59Z'), true)
  assert.equal(confirmedOffpeakWindow('2026-10-21T00:40:00Z', '2026-10-21T00:55:00Z'), false)
  assert.equal(confirmedOffpeakWindow('2026-10-21T04:04:59Z', '2026-10-21T04:20:00Z'), false)
  assert.equal(confirmedOffpeakWindow('2026-10-21T04:06:00Z', '2026-10-21T04:20:00Z'), true)
})
test('offpeak endpoints cannot hide a peak crossed in the middle', () => {
  assert.equal(confirmedOffpeakWindow('2026-10-21T00:00:00Z', '2026-10-21T05:00:00Z'), false)
  assert.equal(confirmedOffpeakWindow('2026-10-21T05:00:00Z', '2026-10-21T11:00:00Z'), false)
  assert.equal(confirmedOffpeakWindow('2026-10-20T17:00:00Z', '2026-10-21T17:00:00Z'), false)
})
test('weekends are offpeak without consulting a holiday calendar', () => {
  assert.equal(confirmedOffpeakWindow('2026-10-24T01:00:00Z', '2026-10-24T10:00:00Z'), true)
  assert.equal(confirmedOffpeakWindow('2026-10-23T11:00:00Z', '2026-10-25T20:00:00Z'), true)
  assert.equal(confirmedOffpeakWindow('2026-10-25T20:00:00Z', '2026-10-26T01:00:00Z'), false)
})
test('invalid, non-canonical, reversed and very long time intervals conservatively use peak', () => {
  for (const [start, finish] of [
    [null, '2026-10-20T17:15:00Z'],
    ['bad', '2026-10-20T17:15:00Z'],
    ['2026-02-30T17:00:00Z', '2026-03-02T17:15:00Z'],
    ['2026-10-20', '2026-10-20T17:15:00Z'],
    ['2026-10-20T17:15:00Z', '2026-10-20T17:00:00Z'],
    ['2026-10-20T17:00:00Z', '2026-11-20T17:00:00Z'],
  ]) {
    const result = usageSettlement(usage, start, finish)
    assert.equal(result.chargedUnits / 1e9, 0.0004008)
    assert.equal(result.settlementBasis, 'peak_conservative')
  }
})
