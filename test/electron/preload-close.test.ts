import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

type DesktopBridge = {
  onPrepareClose(handler: () => Promise<boolean> | boolean): () => void
}

function fixture() {
  const ipc = Object.assign(new EventEmitter(), {
    send: vi.fn(),
    invoke: vi.fn(),
  })
  let bridge!: DesktopBridge
  runInNewContext(readFileSync(path.join(process.cwd(), 'electron', 'preload.cjs'), 'utf8'), {
    require: () => ({
      contextBridge: {
        exposeInMainWorld: (_name: string, value: DesktopBridge) => { bridge = value },
      },
      ipcRenderer: ipc,
    }),
  })
  return { bridge, ipc }
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('preload draft save acknowledgement', () => {
  it('waits for every registered save before acknowledging a close', async () => {
    const { bridge, ipc } = fixture()
    let finishSave!: (saved: boolean) => void
    bridge.onPrepareClose(() => new Promise<boolean>((resolve) => { finishSave = resolve }))
    const secondSave = vi.fn(async () => true)
    bridge.onPrepareClose(secondSave)
    ipc.emit('agentic:prepare-close', {}, { requestId: 'close-1' })
    await nextTurn()
    expect(secondSave).toHaveBeenCalledOnce()
    expect(ipc.send).not.toHaveBeenCalled()
    finishSave(true)
    await nextTurn()
    expect(ipc.send).toHaveBeenCalledWith('agentic:prepare-close-result', {
      requestId: 'close-1',
      ok: true,
    })
  })

  it.each([false, 'throw'] as const)('reports a failed save without sending draft text (%s)', async (result) => {
    const { bridge, ipc } = fixture()
    bridge.onPrepareClose(async () => {
      if (result === 'throw') throw new Error('private draft text')
      return result
    })
    ipc.emit('agentic:prepare-close', {}, { requestId: 'close-2' })
    await nextTurn()
    expect(ipc.send).toHaveBeenCalledWith('agentic:prepare-close-result', {
      requestId: 'close-2',
      ok: false,
    })
  })

  it('removes unmounted callbacks and allows the loading screen to close', async () => {
    const { bridge, ipc } = fixture()
    const staleSave = vi.fn(async () => false)
    const unsubscribe = bridge.onPrepareClose(staleSave)
    unsubscribe()
    ipc.emit('agentic:prepare-close', {}, { requestId: 'close-3' })
    await nextTurn()
    expect(staleSave).not.toHaveBeenCalled()
    expect(ipc.send).toHaveBeenCalledWith('agentic:prepare-close-result', {
      requestId: 'close-3',
      ok: true,
    })
  })
})
