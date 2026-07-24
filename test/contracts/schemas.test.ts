import { describe, it, expect } from 'vitest'
import {
  // Config CRUD
  endpointCreateSchema, endpointUpdateSchema,
  agentCreateSchema, agentUpdateSchema,
  coordinatorUpdateSchema,
  promptCreateSchema, promptUpdateSchema,
  // Tools
  replaceTextParamsSchema,
  // State transitions
  ALLOWED_TRANSITIONS,
} from '../../src/lib/contracts/schemas'
import type { SessionState, Stage } from '../../src/lib/contracts/types'

// ---------------------------------------------------------------------------
// Config CRUD schemas
// ---------------------------------------------------------------------------
describe('Config CRUD schemas', () => {
  const validEndpointCreate = {
    name: 'My OpenAI',
    base_url: 'https://api.openai.com/v1',
    api_key: 'sk-xxx',
  }

  it('endpointCreateSchema accepts valid input', () => {
    const result = endpointCreateSchema.safeParse(validEndpointCreate)
    expect(result.success).toBe(true)
  })

  it('endpointCreateSchema rejects missing name', () => {
    const result = endpointCreateSchema.safeParse({ base_url: 'https://x.com', api_key: '' })
    expect(result.success).toBe(false)
  })

  it('endpointUpdateSchema accepts partial fields', () => {
    const result = endpointUpdateSchema.safeParse({ name: 'Renamed' })
    expect(result.success).toBe(true)
  })

  const validAgentCreate = {
    name: 'Agent A',
    endpoint_id: 1,
    model: 'gpt-4o',
    sort_order: 0,
  }

  it('agentCreateSchema accepts valid input', () => {
    const result = agentCreateSchema.safeParse(validAgentCreate)
    expect(result.success).toBe(true)
  })

  it('agentCreateSchema rejects negative sort_order', () => {
    const result = agentCreateSchema.safeParse({ ...validAgentCreate, sort_order: -1 })
    expect(result.success).toBe(false)
  })

  it('agentUpdateSchema accepts partial', () => {
    const result = agentUpdateSchema.safeParse({ name: 'Renamed' })
    expect(result.success).toBe(true)
  })

  const validCoordinator = {
    endpoint_id: 1,
    model: 'gpt-4o',
    chat_endpoint_id: 1,
    chat_model: 'gpt-4o-mini',
  }

  it('coordinatorUpdateSchema accepts valid input', () => {
    const result = coordinatorUpdateSchema.safeParse(validCoordinator)
    expect(result.success).toBe(true)
  })

  it('coordinatorUpdateSchema rejects empty model', () => {
    const result = coordinatorUpdateSchema.safeParse({ ...validCoordinator, model: '' })
    expect(result.success).toBe(false)
  })

  const validPromptCreate = {
    kind: 'translator' as const,
    name: 'Default Translator',
    content: 'Translate {{source_text}}',
  }

  it('promptCreateSchema accepts valid input', () => {
    const result = promptCreateSchema.safeParse(validPromptCreate)
    expect(result.success).toBe(true)
  })

  it('promptCreateSchema rejects invalid kind', () => {
    const result = promptCreateSchema.safeParse({ ...validPromptCreate, kind: 'invalid' })
    expect(result.success).toBe(false)
  })

  it('promptUpdateSchema accepts partial', () => {
    const result = promptUpdateSchema.safeParse({ content: 'Updated content' })
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// replace_text tool params
// ---------------------------------------------------------------------------
describe('replaceTextParamsSchema', () => {
  it('accepts valid params', () => {
    const result = replaceTextParamsSchema.safeParse({
      old_string: 'Hello',
      new_string: 'Hi',
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty old_string', () => {
    const result = replaceTextParamsSchema.safeParse({
      old_string: '',
      new_string: 'Hi',
    })
    expect(result.success).toBe(false)
  })

  it('allows empty new_string (deletion)', () => {
    const result = replaceTextParamsSchema.safeParse({
      old_string: 'Hello',
      new_string: '',
    })
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------
describe('ALLOWED_TRANSITIONS', () => {
  const states: SessionState[] = [
    'draft', 'translating', 'translated',
    'coordinating', 'assembled', 'refining', 'done',
  ]

  const allowed: [SessionState, SessionState][] = [
    ['draft', 'translating'],
    ['translating', 'translated'],
    ['translated', 'coordinating'],
    ['translated', 'translating'],
    ['coordinating', 'assembled'],
    ['coordinating', 'coordinating'],
    ['assembled', 'refining'],
    ['assembled', 'done'],
    ['refining', 'refining'],
    ['refining', 'done'],
    ['done', 'refining'],
  ]

  const disallowed: [SessionState, SessionState][] = [
    ['draft', 'done'],
    ['draft', 'refining'],
    ['draft', 'coordinating'],
    ['draft', 'assembled'],
    ['translating', 'done'],
    ['translating', 'refining'],
    ['translating', 'coordinating'],
    ['translated', 'done'],
    ['translated', 'refining'],
    ['translated', 'assembled'],
    ['coordinating', 'done'],
    ['coordinating', 'refining'],
    ['coordinating', 'translating'],
    ['assembled', 'translating'],
    ['assembled', 'coordinating'],
    ['refining', 'translating'],
    ['refining', 'coordinating'],
    ['done', 'translating'],
    ['done', 'coordinating'],
    ['done', 'assembled'],
    ['done', 'draft'],
  ]

  it('allows all valid transitions', () => {
    for (const [from, to] of allowed) {
      expect(ALLOWED_TRANSITIONS[from]).toContain(to)
    }
  })

  it('disallows all invalid transitions', () => {
    for (const [from, to] of disallowed) {
      const toStates = ALLOWED_TRANSITIONS[from]
      expect(toStates).not.toContain(to)
    }
  })

  it('covers all 7 states as keys', () => {
    for (const s of states) {
      expect(ALLOWED_TRANSITIONS).toHaveProperty(s)
      expect(Array.isArray(ALLOWED_TRANSITIONS[s])).toBe(true)
    }
  })

  it('done→refining is allowed (reopen)', () => {
    expect(ALLOWED_TRANSITIONS['done']).toContain('refining')
  })

  it('refining→refining is allowed (continue editing)', () => {
    expect(ALLOWED_TRANSITIONS['refining']).toContain('refining')
  })
})
