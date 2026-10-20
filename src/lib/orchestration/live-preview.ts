import { REASONING_PREVIEW_LIMIT, type ReasoningPreview } from '../llm/reasoning-preview'

interface LivePreview {
  version: number
  updatedAt: number
  eventType: string
  payload: ReasoningPreview & { invocationId?: string; stage?: string }
}

// Next can load the runner and route in separate module graphs in one process.
// Keep only the newest small preview per invocation, with bounded size and TTL.
const key = Symbol.for('agentic-translating.live-reasoning-previews')
const state = globalThis as typeof globalThis & {
  [key]?: { version: number; sessions: Map<string, Map<string, LivePreview>> }
}
const store = state[key] ??= { version: 0, sessions: new Map() }
const TTL_MS = 30 * 60 * 1_000
const MAX_SESSIONS = 20
const MAX_INVOCATIONS = 32

function prune(now: number) {
  for (const [sessionId, entries] of store.sessions) {
    for (const [id, item] of entries) {
      if (now - item.updatedAt > TTL_MS) entries.delete(id)
    }
    if (!entries.size) store.sessions.delete(sessionId)
  }
}

export function publishReasoningPreview(
  sessionId: string,
  invocationId: string,
  preview: ReasoningPreview,
  stage?: string,
) {
  const now = Date.now()
  prune(now)
  let entries = store.sessions.get(sessionId)
  if (!entries) {
    if (store.sessions.size >= MAX_SESSIONS) {
      store.sessions.delete(store.sessions.keys().next().value!)
    }
    entries = new Map()
    store.sessions.set(sessionId, entries)
  }
  if (!entries.has(invocationId) && entries.size >= MAX_INVOCATIONS) {
    entries.delete(entries.keys().next().value!)
  }
  entries.set(invocationId, {
    version: ++store.version,
    updatedAt: now,
    eventType: stage ? 'stage.reasoning' : 'agent.reasoning',
    payload: {
      ...preview,
      reasoningPreview: preview.reasoningPreview.slice(-REASONING_PREVIEW_LIMIT),
      reasoningTruncated: preview.reasoningTruncated || preview.reasoningPreview.length > REASONING_PREVIEW_LIMIT,
      ...(stage ? { stage } : { invocationId }),
    },
  })
}

export function readReasoningPreviews(sessionId: string, afterVersion: number) {
  prune(Date.now())
  return [...(store.sessions.get(sessionId)?.values() ?? [])]
    .filter((item) => item.version > afterVersion)
    .sort((left, right) => left.version - right.version)
}
