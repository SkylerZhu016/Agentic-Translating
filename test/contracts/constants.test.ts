import { describe, it, expect } from 'vitest'
import {
  AGENT_TIMEOUT_MS,
  AGENT_MAX_DURATION_MS,
  MAX_CONCURRENCY,
  HARD_CONCURRENCY_CAP,
  RETRY_DELAYS_MS,
  STAGE_CONTEXT_TOKEN_BUDGET,
  SOURCE_TOKEN_LIMIT,
  CHAT_LOOP_MAX,
  CHAT_CONTEXT_TURNS,
} from '../../src/lib/constants'

describe('operational constants', () => {
  it('AGENT_TIMEOUT_MS = 20 minutes', () => {
    expect(AGENT_TIMEOUT_MS).toBe(20 * 60_000)
  })

  it('AGENT_MAX_DURATION_MS = 90 minutes', () => {
    expect(AGENT_MAX_DURATION_MS).toBe(90 * 60_000)
  })

  it('MAX_CONCURRENCY = 8', () => {
    expect(MAX_CONCURRENCY).toBe(8)
  })

  it('HARD_CONCURRENCY_CAP = 16', () => {
    expect(HARD_CONCURRENCY_CAP).toBe(16)
  })

  it('HARD_CONCURRENCY_CAP >= MAX_CONCURRENCY', () => {
    expect(HARD_CONCURRENCY_CAP).toBeGreaterThanOrEqual(MAX_CONCURRENCY)
  })

  it('RETRY_DELAYS_MS = [1000, 3000]', () => {
    expect(RETRY_DELAYS_MS).toEqual([1000, 3000])
  })

  it('STAGE_CONTEXT_TOKEN_BUDGET = 6000', () => {
    expect(STAGE_CONTEXT_TOKEN_BUDGET).toBe(6000)
  })

  it('SOURCE_TOKEN_LIMIT = 8000', () => {
    expect(SOURCE_TOKEN_LIMIT).toBe(8000)
  })

  it('CHAT_LOOP_MAX = 5', () => {
    expect(CHAT_LOOP_MAX).toBe(5)
  })

  it('CHAT_CONTEXT_TURNS = 20', () => {
    expect(CHAT_CONTEXT_TURNS).toBe(20)
  })

  it('all constants are numbers (RETRY_DELAYS_MS is array of numbers)', () => {
    expect(typeof AGENT_TIMEOUT_MS).toBe('number')
    expect(typeof AGENT_MAX_DURATION_MS).toBe('number')
    expect(typeof MAX_CONCURRENCY).toBe('number')
    expect(typeof HARD_CONCURRENCY_CAP).toBe('number')
    expect(Array.isArray(RETRY_DELAYS_MS)).toBe(true)
    RETRY_DELAYS_MS.forEach(d => expect(typeof d).toBe('number'))
    expect(typeof STAGE_CONTEXT_TOKEN_BUDGET).toBe('number')
    expect(typeof SOURCE_TOKEN_LIMIT).toBe('number')
    expect(typeof CHAT_LOOP_MAX).toBe('number')
    expect(typeof CHAT_CONTEXT_TURNS).toBe('number')
  })
})
