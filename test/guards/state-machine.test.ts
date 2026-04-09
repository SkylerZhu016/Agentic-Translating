import { describe, it, expect } from 'vitest'
import {
  canTransition,
  assertTransition,
  isTerminal,
  InvalidTransitionError,
} from '../../src/lib/guards/state-machine'

describe('canTransition', () => {
  // Happy paths - every allowed transition
  it('should allow draft -> translating', () => {
    expect(canTransition('draft', 'translating')).toBe(true)
  })

  it('should allow translating -> translated', () => {
    expect(canTransition('translating', 'translated')).toBe(true)
  })

  it('should allow translated -> coordinating', () => {
    expect(canTransition('translated', 'coordinating')).toBe(true)
  })

  it('should allow translated -> translating (re-translate)', () => {
    expect(canTransition('translated', 'translating')).toBe(true)
  })

  it('should allow coordinating -> assembled', () => {
    expect(canTransition('coordinating', 'assembled')).toBe(true)
  })

  it('should allow coordinating -> coordinating (re-run stage)', () => {
    expect(canTransition('coordinating', 'coordinating')).toBe(true)
  })

  it('should allow assembled -> refining', () => {
    expect(canTransition('assembled', 'refining')).toBe(true)
  })

  it('should allow assembled -> done', () => {
    expect(canTransition('assembled', 'done')).toBe(true)
  })

  it('should allow refining -> refining', () => {
    expect(canTransition('refining', 'refining')).toBe(true)
  })

  it('should allow refining -> done', () => {
    expect(canTransition('refining', 'done')).toBe(true)
  })

  it('should allow done -> refining', () => {
    expect(canTransition('done', 'refining')).toBe(true)
  })

  // Forbidden transitions
  it('should forbid done -> translating', () => {
    expect(canTransition('done', 'translating')).toBe(false)
  })

  it('should forbid done -> draft', () => {
    expect(canTransition('done', 'draft')).toBe(false)
  })

  it('should forbid draft -> assembled', () => {
    expect(canTransition('draft', 'assembled')).toBe(false)
  })

  it('should forbid draft -> draft (self-loop not allowed for draft)', () => {
    expect(canTransition('draft', 'draft')).toBe(false)
  })

  it('should forbid draft -> done', () => {
    expect(canTransition('draft', 'done')).toBe(false)
  })

  it('should forbid translating -> done', () => {
    expect(canTransition('translating', 'done')).toBe(false)
  })

  it('should forbid translating -> coordinating', () => {
    expect(canTransition('translating', 'coordinating')).toBe(false)
  })

  it('should forbid translated -> assembled', () => {
    expect(canTransition('translated', 'assembled')).toBe(false)
  })

  it('should forbid translated -> done', () => {
    expect(canTransition('translated', 'done')).toBe(false)
  })

  it('should forbid assembled -> translating', () => {
    expect(canTransition('assembled', 'translating')).toBe(false)
  })

  it('should forbid assembled -> draft', () => {
    expect(canTransition('assembled', 'draft')).toBe(false)
  })
})

describe('assertTransition', () => {
  it('should not throw for legal transition', () => {
    expect(() => assertTransition('draft', 'translating')).not.toThrow()
  })

  it('should not throw for legal self-transition (coordinating)', () => {
    expect(() => assertTransition('coordinating', 'coordinating')).not.toThrow()
  })

  it('should throw InvalidTransitionError for illegal transition done -> translating', () => {
    expect(() => assertTransition('done', 'translating')).toThrow(InvalidTransitionError)
  })

  it('should throw with code invalid_state_transition', () => {
    try {
      assertTransition('done', 'translating')
      expect.unreachable('should have thrown')
    } catch (e) {
      if (e instanceof InvalidTransitionError) {
        expect(e.code).toBe('invalid_state_transition')
        expect(e.from).toBe('done')
        expect(e.to).toBe('translating')
        expect(e.message).toContain('done')
        expect(e.message).toContain('translating')
      } else {
        throw e
      }
    }
  })

  it('should throw for illegal transition assembled -> draft', () => {
    expect(() => assertTransition('assembled', 'draft')).toThrow(InvalidTransitionError)
  })

  it('should throw for illegal transition translating -> coordinating', () => {
    expect(() => assertTransition('translating', 'coordinating')).toThrow(InvalidTransitionError)
  })
})

describe('isTerminal', () => {
  it('should return true for done', () => {
    expect(isTerminal('done')).toBe(true)
  })

  it('should return false for draft', () => {
    expect(isTerminal('draft')).toBe(false)
  })

  it('should return false for translating', () => {
    expect(isTerminal('translating')).toBe(false)
  })

  it('should return false for translated', () => {
    expect(isTerminal('translated')).toBe(false)
  })

  it('should return false for coordinating', () => {
    expect(isTerminal('coordinating')).toBe(false)
  })

  it('should return false for assembled', () => {
    expect(isTerminal('assembled')).toBe(false)
  })

  it('should return false for refining', () => {
    expect(isTerminal('refining')).toBe(false)
  })
})
