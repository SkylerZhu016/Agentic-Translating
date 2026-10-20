import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSessionEventStream } from '../../app/api/sessions/[id]/events/stream'
import { parseSSEChunk } from '../../src/lib/contracts/sse'
import type { ReasoningPreview } from '../../src/lib/llm/reasoning-preview'
import {
  publishReasoningPreview,
  readReasoningPreviews,
} from '../../src/lib/orchestration/live-preview'

function preview(text: string, characters = text.length): ReasoningPreview {
  return {
    reasoningPreview: text,
    reasoningCharacters: characters,
    reasoningTruncated: characters > text.length,
  }
}

describe('ephemeral session reasoning previews', () => {
  let db: Database.Database
  let sessionId: string

  beforeEach(() => {
    sessionId = `reasoning-preview-${randomUUID()}`
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE run_events (
        id INTEGER PRIMARY KEY, session_id TEXT, seq INTEGER,
        event_type TEXT, payload_json TEXT
      );
      CREATE TABLE orchestration_runs (session_id TEXT, status TEXT);
    `)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (db.open) db.close()
  })

  function persist(id: number, text: string) {
    db.prepare('INSERT INTO run_events VALUES (?, ?, ?, ?, ?)').run(
      id, sessionId, id, 'agent.delta', JSON.stringify({ text }),
    )
  }

  it('retains only the latest snapshot per invocation instead of a reasoning event history', () => {
    publishReasoningPreview(sessionId, 'translator', preview('initial'))
    const firstVersion = readReasoningPreviews(sessionId, 0)[0].version
    for (let index = 1; index <= 1_000; index += 1) {
      publishReasoningPreview(
        sessionId,
        'translator',
        preview(`current ${index}`, index * 1_000),
      )
    }
    publishReasoningPreview(sessionId, 'editor', preview('editor tail', 40_000), 'refine')

    const entries = readReasoningPreviews(sessionId, firstVersion)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      eventType: 'agent.reasoning',
      payload: {
        invocationId: 'translator',
        reasoningPreview: 'current 1000',
        reasoningCharacters: 1_000_000,
        reasoningTruncated: true,
      },
    })
    expect(entries[1]).toMatchObject({
      eventType: 'stage.reasoning',
      payload: {
        stage: 'refine',
        reasoningPreview: 'editor tail',
        reasoningCharacters: 40_000,
      },
    })
    expect(readReasoningPreviews(sessionId, entries.at(-1)!.version)).toEqual([])
    expect(db.prepare('SELECT count(*) FROM run_events').pluck().get()).toBe(0)
  })

  it('sends previews without SSE ids and keeps the persistent database cursor unchanged', async () => {
    persist(5, 'already received')
    db.prepare('INSERT INTO orchestration_runs VALUES (?, ?)').run(sessionId, 'running')
    publishReasoningPreview(sessionId, 'translator', preview('current thought', 40_000))
    const prepare = vi.spyOn(db, 'prepare')
    const reader = createSessionEventStream(
      db, sessionId, 5, new AbortController().signal,
    ).getReader()
    const eventStatement = prepare.mock.results[0].value as Database.Statement
    const reads = vi.spyOn(eventStatement, 'all')

    try {
      const ephemeral = new TextDecoder().decode((await reader.read()).value)
      const frames = parseSSEChunk(ephemeral)
      expect(frames).toHaveLength(1)
      expect(frames[0]).toMatchObject({ event: 'agent.reasoning' })
      expect(frames[0].id).toBeUndefined()
      expect(ephemeral).not.toMatch(/^id:/m)
      expect(JSON.parse(frames[0].data)).toEqual({
        invocationId: 'translator',
        ...preview('current thought', 40_000),
      })
      expect(reads).toHaveBeenLastCalledWith(sessionId, 5, 64)

      // The next durable event must remain visible after a transient preview.
      persist(6, 'new translation')
      const durable = new TextDecoder().decode((await reader.read()).value)
      expect(durable).toMatch(/^id: 6\nevent: agent.delta\n/)
      expect(durable).toContain('new translation')
      expect(reads).toHaveBeenLastCalledWith(sessionId, 5, 64)

      publishReasoningPreview(sessionId, 'translator', preview('new thought', 40_100))
      const nextPreview = new TextDecoder().decode((await reader.read()).value)
      expect(nextPreview).not.toMatch(/^id:/m)
      expect(nextPreview).toContain('new thought')
      expect(reads).toHaveBeenLastCalledWith(sessionId, 6, 64)
      expect(db.prepare('SELECT count(*) FROM run_events').pluck().get()).toBe(2)
    } finally {
      await reader.cancel()
    }
  })

  it('reconnects with one latest preview and resumes durable events after the supplied cursor', async () => {
    persist(1, 'received translation')
    persist(2, 'next translation')
    publishReasoningPreview(sessionId, 'translator', preview('obsolete thought', 2_000))
    publishReasoningPreview(sessionId, 'translator', preview('latest thought', 40_000))
    const reader = createSessionEventStream(
      db, sessionId, 1, new AbortController().signal,
    ).getReader()

    const first = parseSSEChunk(new TextDecoder().decode((await reader.read()).value))
    expect(first.map((event) => event.id)).toEqual(['2'])
    const second = parseSSEChunk(new TextDecoder().decode((await reader.read()).value))
    expect(second).toHaveLength(1)
    expect(second[0].id).toBeUndefined()
    expect(second[0].data).toContain('latest thought')
    expect(second[0].data).not.toContain('obsolete thought')
    expect((await reader.read()).done).toBe(true)
  })

  it('expires idle reasoning snapshots so completed sessions do not retain them indefinitely', () => {
    vi.useFakeTimers()
    publishReasoningPreview(sessionId, 'translator', preview('short retained tail', 40_000))
    expect(readReasoningPreviews(sessionId, 0)).toHaveLength(1)
    vi.advanceTimersByTime(31 * 60 * 1_000)
    expect(readReasoningPreviews(sessionId, 0)).toEqual([])
  })
})
