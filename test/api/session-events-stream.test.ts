import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createSessionEventStream } from '../../app/api/sessions/[id]/events/stream'

describe('bounded session event replay', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE run_events (
        id INTEGER PRIMARY KEY, session_id TEXT, seq INTEGER,
        event_type TEXT, payload_json TEXT
      );
      CREATE TABLE orchestration_runs (session_id TEXT, status TEXT);
    `)
    const insert = db.prepare(
      "INSERT INTO run_events VALUES (?, 'session', ?, 'delta', ?)",
    )
    for (let index = 1; index <= 150; index++) {
      insert.run(index, index, JSON.stringify({ text: `token ${index}` }))
    }
    db.prepare("UPDATE run_events SET event_type='run_complete' WHERE id=150").run()
  })

  afterEach(() => {
    vi.useRealTimers()
    if (db.open) db.close()
  })

  it('reads only a bounded page when asked and resumes exactly after the cursor', async () => {
    const query = vi.spyOn(db, 'prepare')
    const stream = createSessionEventStream(db, 'session', 10, new AbortController().signal)
    const eventStatement = query.mock.results[0].value as Database.Statement
    const reads = vi.spyOn(eventStatement, 'all')
    const reader = stream.getReader()
    const chunks: string[] = []
    const decoder = new TextDecoder()
    const first = await reader.read()
    chunks.push(decoder.decode(first.value))
    expect(chunks[0].match(/^id: /gm)).toHaveLength(64)
    expect(chunks[0]).toMatch(/^id: 11\n/)
    expect(chunks[0]).not.toContain('id: 75\n')
    await Promise.resolve()
    expect(reads).toHaveBeenCalledTimes(1)
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      chunks.push(decoder.decode(result.value))
    }
    const ids = [...chunks.join('').matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]))
    expect(ids).toEqual(Array.from({ length: 140 }, (_, index) => index + 11))
    expect(chunks.at(-1)).toContain('id: 150\nevent: run_complete\n')
    expect(query.mock.calls.filter(([sql]) => /FROM run_events/.test(sql))).toHaveLength(1)
    query.mockRestore()
  })

  it('reconnects after the last received event without cancelling the background run', async () => {
    db.prepare("INSERT INTO orchestration_runs VALUES ('session', 'running')").run()
    const first = createSessionEventStream(db, 'session', 0, new AbortController().signal).getReader()
    const received = new TextDecoder().decode((await first.read()).value)
    const ids = [...received.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]))
    await first.cancel()
    expect(db.prepare('SELECT status FROM orchestration_runs').pluck().get()).toBe('running')

    const reconnect = createSessionEventStream(
      db, 'session', ids.at(-1)!, new AbortController().signal,
    ).getReader()
    const resumed = new TextDecoder().decode((await reconnect.read()).value)
    expect(resumed).toMatch(/^id: 65\n/)
    expect(resumed).not.toContain('id: 64\n')
    await reconnect.cancel()
  })

  it('does not start database polling before the consumer reads', async () => {
    vi.useFakeTimers()
    const stream = createSessionEventStream(db, 'session', 150, new AbortController().signal)
    db.prepare("INSERT INTO orchestration_runs VALUES ('session', 'running')").run()
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)
    await stream.cancel()
  })

  it('stops an idle live read immediately on abort and clears its timer', async () => {
    vi.useFakeTimers()
    db.prepare("INSERT INTO orchestration_runs VALUES ('session', 'running')").run()
    const controller = new AbortController()
    const reader = createSessionEventStream(db, 'session', 150, controller.signal).getReader()
    const pending = reader.read()
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(1)
    controller.abort()
    expect(await pending).toEqual({ value: undefined, done: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears an idle poll when its reader is cancelled', async () => {
    vi.useFakeTimers()
    db.prepare("INSERT INTO orchestration_runs VALUES ('session', 'running')").run()
    const reader = createSessionEventStream(db, 'session', 150, new AbortController().signal).getReader()
    const pending = reader.read()
    await Promise.resolve()
    await reader.cancel()
    expect((await pending).done).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ends with a stream error if the database closes while polling', async () => {
    vi.useFakeTimers()
    db.prepare("INSERT INTO orchestration_runs VALUES ('session', 'running')").run()
    const reader = createSessionEventStream(
      db, 'session', 150, new AbortController().signal,
    ).getReader()
    const pending = reader.read()
    const rejected = expect(pending).rejects.toThrow()
    await Promise.resolve()
    db.close()
    await vi.advanceTimersByTimeAsync(250)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })
})
