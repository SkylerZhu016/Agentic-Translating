import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  createWindowCloseHandler,
  prepareRendererForClose,
  readRunningWork,
} from '../../electron/window-lifecycle.mjs'

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('desktop window close guard', () => {
  function fixture(hasRunningWork: () => Promise<boolean> = vi.fn(async () => true)) {
    const actions = {
      canQuit: vi.fn(() => false),
      hasRunningWork,
      chooseAction: vi.fn(async (_activity: 'running' | 'unknown') => 'cancel' as const),
      quit: vi.fn(),
      hide: vi.fn(),
      onError: vi.fn(),
    }
    return { actions, onClose: createWindowCloseHandler(actions) }
  }

  it('cancels close synchronously before the task check can resolve', async () => {
    let finishCheck!: (value: boolean) => void
    const check = vi.fn(() => new Promise<boolean>((resolve) => { finishCheck = resolve }))
    const { actions, onClose } = fixture(check)
    const event = { preventDefault: vi.fn() }

    onClose(event)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(actions.quit).not.toHaveBeenCalled()
    onClose(event)
    expect(check).toHaveBeenCalledOnce()
    finishCheck(true)
    await nextTurn()
    expect(actions.chooseAction).toHaveBeenCalledWith('running')
    expect(actions.quit).not.toHaveBeenCalled()
  })

  it('quits explicitly only after confirming there is no running work', async () => {
    const { actions, onClose } = fixture(vi.fn(async () => false))
    onClose({ preventDefault: vi.fn() })
    await nextTurn()
    expect(actions.quit).toHaveBeenCalledOnce()
    expect(actions.chooseAction).not.toHaveBeenCalled()
  })

  it('keeps the window open and asks the user when the service cannot report activity', async () => {
    const { actions, onClose } = fixture(vi.fn(async () => { throw new Error('timeout') }))
    onClose({ preventDefault: vi.fn() })
    await nextTurn()
    expect(actions.chooseAction).toHaveBeenCalledWith('unknown')
    expect(actions.quit).not.toHaveBeenCalled()
    expect(actions.hide).not.toHaveBeenCalled()
  })

  it('lets an already confirmed app quit close the window without another check', () => {
    const { actions, onClose } = fixture()
    actions.canQuit.mockReturnValue(true)
    const event = { preventDefault: vi.fn() }
    onClose(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(actions.hasRunningWork).not.toHaveBeenCalled()
  })

  it('does not reopen a confirmation when another exit path commits during the check', async () => {
    let finishCheck!: (value: boolean) => void
    const { actions, onClose } = fixture(
      () => new Promise<boolean>((resolve) => { finishCheck = resolve }),
    )
    onClose({ preventDefault: vi.fn() })
    actions.canQuit.mockReturnValue(true)
    finishCheck(true)
    await nextTurn()
    expect(actions.chooseAction).not.toHaveBeenCalled()
    expect(actions.quit).not.toHaveBeenCalled()
  })

  it('waits for the latest draft flush before an idle window can quit', async () => {
    let finishSave!: () => void
    const prepareToQuit = vi.fn(() => new Promise<void>((resolve) => { finishSave = resolve }))
    const quit = vi.fn()
    createWindowCloseHandler({
      canQuit: () => false,
      hasRunningWork: async () => false,
      chooseAction: async () => 'cancel',
      prepareToQuit,
      quit,
      hide: vi.fn(),
    })({ preventDefault: vi.fn() })
    await nextTurn()
    expect(prepareToQuit).toHaveBeenCalledOnce()
    expect(quit).not.toHaveBeenCalled()
    finishSave()
    await nextTurn()
    expect(quit).toHaveBeenCalledOnce()
  })

  it.each([false, true])('requires an explicit discard choice (%s) after draft save failure', async (discard) => {
    const quit = vi.fn()
    const onPreparationFailed = vi.fn(async () => discard)
    createWindowCloseHandler({
      canQuit: () => false,
      hasRunningWork: async () => false,
      chooseAction: async () => 'cancel',
      prepareToQuit: async () => { throw new Error('draft_save_timeout') },
      onPreparationFailed,
      quit,
      hide: vi.fn(),
    })({ preventDefault: vi.fn() })
    await nextTurn()
    expect(onPreparationFailed).toHaveBeenCalledOnce()
    expect(quit).toHaveBeenCalledTimes(discard ? 1 : 0)
  })

  it.each(['hide', 'quit'] as const)('honors the %s action after checking running work', async (action) => {
    const actions = {
      canQuit: () => false,
      hasRunningWork: async () => true,
      chooseAction: async () => action,
      quit: vi.fn(),
      hide: vi.fn(),
    }
    createWindowCloseHandler(actions)({ preventDefault: vi.fn() })
    await nextTurn()
    expect(actions[action]).toHaveBeenCalledOnce()
    expect(actions[action === 'hide' ? 'quit' : 'hide']).not.toHaveBeenCalled()
  })
})

describe('desktop renderer close handshake', () => {
  function fixture() {
    const ipc = new EventEmitter()
    const contents = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      send: vi.fn(),
    })
    return { ipc, contents }
  }

  it('accepts only an acknowledgement for this window and request, then removes listeners', async () => {
    const { ipc, contents } = fixture()
    const pending = prepareRendererForClose(contents as never, ipc as never)
    const request = contents.send.mock.calls[0][1] as { requestId: string }
    let complete = false
    void pending.then(() => { complete = true })
    ipc.emit('agentic:prepare-close-result', { sender: {} }, { ...request, ok: true })
    ipc.emit('agentic:prepare-close-result', { sender: contents }, { requestId: 'stale', ok: true })
    await nextTurn()
    expect(complete).toBe(false)
    ipc.emit('agentic:prepare-close-result', { sender: contents }, { ...request, ok: true })
    await pending
    expect(ipc.listenerCount('agentic:prepare-close-result')).toBe(0)
    expect(contents.listenerCount('destroyed')).toBe(0)
    expect(contents.listenerCount('render-process-gone')).toBe(0)
  })

  it('rejects a failed draft flush and a missing acknowledgement', async () => {
    const { ipc, contents } = fixture()
    const pending = prepareRendererForClose(contents as never, ipc as never)
    const request = contents.send.mock.calls[0][1] as { requestId: string }
    const rejected = expect(pending).rejects.toThrow('draft_save_failed')
    ipc.emit('agentic:prepare-close-result', { sender: contents }, { ...request, ok: false })
    await rejected
    await expect(prepareRendererForClose(contents as never, ipc as never, {
      timeoutMs: 1,
    })).rejects.toThrow('draft_save_timeout')
    expect(ipc.listenerCount('agentic:prepare-close-result')).toBe(0)
  })

  it('keeps the native guard in control if the renderer exits during the save', async () => {
    const { ipc, contents } = fixture()
    const pending = prepareRendererForClose(contents as never, ipc as never)
    const rejected = expect(pending).rejects.toThrow('renderer_unavailable')
    contents.emit('render-process-gone')
    await rejected
    expect(ipc.listenerCount('agentic:prepare-close-result')).toBe(0)
  })
})

describe('desktop activity request', () => {
  it('requires a boolean activity response and sends a bounded no-cache request', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ hasRunningWork: true })))
    await expect(readRunningWork({
      url: 'http://127.0.0.1:3210/api/desktop/activity',
      fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toBe(true)
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:3210/api/desktop/activity',
      expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }),
    )
  })

  it.each([
    new Response('{}'),
    new Response('{"hasRunningWork":"false"}'),
    new Response('{"error":"activity_unavailable"}', { status: 503 }),
  ])('treats unavailable or invalid activity as an error, not as idle', async (response) => {
    await expect(readRunningWork({
      url: 'http://127.0.0.1:3210/api/desktop/activity',
      fetchImpl: vi.fn(async () => response) as typeof fetch,
    })).rejects.toThrow()
  })
})
