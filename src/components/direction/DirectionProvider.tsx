'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Button, Modal } from '@/src/components/ui'
import type { BuiltinDirection } from '@/src/lib/contracts/vnext'
import { TID } from '@/src/lib/testids'

interface DraftController {
  dirty: boolean
  flush: () => Promise<void>
}

interface DirectionContextValue {
  direction: BuiltinDirection
  requestDirection: (direction: BuiltinDirection) => void
  registerDraftController: (controller: DraftController | null) => void
}

const DirectionContext = createContext<DirectionContextValue | null>(null)

async function saveSetting(key: string, value: string) {
  await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  })
}

export function DirectionProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const router = useRouter()
  const [direction, setDirection] = useState<BuiltinDirection>('en_to_zh')
  const [suppressed, setSuppressed] = useState(false)
  const [pending, setPending] = useState<BuiltinDirection | null>(null)
  const [suppressChecked, setSuppressChecked] = useState(false)
  const draftController = useRef<DraftController | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const sessionId = searchParams.get('session')
      const [settings, sessionPayload] = await Promise.all([
        fetch('/api/settings')
          .then((response) =>
            response.ok
              ? response.json() as Promise<Array<{ key: string; value: string }>>
              : [],
          )
          .catch(() => []),
        sessionId
          ? fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)
              .then((response) =>
                response.ok
                  ? response.json() as Promise<{
                      session?: { direction?: BuiltinDirection }
                    }>
                  : null,
              )
              .catch(() => null)
          : Promise.resolve(null),
      ])
      if (cancelled) return
      setSuppressed(
        settings.find(
          (entry) => entry.key === 'suppress_direction_switch_warning',
        )?.value === '1',
      )
      if (sessionId) {
        if (sessionPayload?.session?.direction) {
          setDirection(sessionPayload.session.direction)
          return
        }
      }
      const queryDirection = searchParams.get('direction')
      if (queryDirection === 'en_to_zh' || queryDirection === 'zh_to_en') {
        setDirection(queryDirection)
        return
      }
      const stored = settings.find((entry) => entry.key === 'workspace_direction')?.value
      if (stored === 'en_to_zh' || stored === 'zh_to_en') setDirection(stored)
    })()
    return () => {
      cancelled = true
    }
  }, [searchParams])

  const performSwitch = useCallback(async (target: BuiltinDirection, suppress: boolean) => {
    await draftController.current?.flush()
    await saveSetting('workspace_direction', target)
    if (suppress) {
      await saveSetting('suppress_direction_switch_warning', '1')
      setSuppressed(true)
    }
    setDirection(target)
    setPending(null)
    setSuppressChecked(false)
    const query = new URLSearchParams()
    query.set('direction', target)
    router.push(`${pathname}?${query.toString()}`)
  }, [pathname, router])

  const requestDirection = useCallback((target: BuiltinDirection) => {
    if (target === direction) return
    const hasSession = pathname === '/' && Boolean(searchParams.get('session'))
    const hasDraft = pathname === '/' && Boolean(draftController.current?.dirty)
    if (!suppressed && (hasSession || hasDraft)) {
      setPending(target)
      return
    }
    void performSwitch(target, false)
  }, [direction, pathname, performSwitch, searchParams, suppressed])

  const registerDraftController = useCallback((controller: DraftController | null) => {
    draftController.current = controller
  }, [])

  return (
    <DirectionContext.Provider
      value={{ direction, requestDirection, registerDraftController }}
    >
      {children}
      <Modal
        open={pending != null}
        testId={TID.direction.warningDialog}
        onClose={() => {
          setPending(null)
          setSuppressChecked(false)
        }}
        title="切换翻译模式？"
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setPending(null)
                setSuppressChecked(false)
              }}
            >
              取消
            </Button>
            <Button
              size="sm"
              testId={TID.direction.confirmButton}
              onClick={() => pending && void performSwitch(pending, suppressChecked)}
            >
              {pending === 'zh_to_en' ? '切换至中译英' : '切换至英译中'}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-6 text-ink-2">
          切换模式会自动切换会话。旧会话进度已自动保存。
        </p>
        <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm text-ink-2">
          <input
            type="checkbox"
            data-testid={TID.direction.suppressCheckbox}
            checked={suppressChecked}
            onChange={(event) => setSuppressChecked(event.target.checked)}
            className="h-4 w-4 accent-ink"
          />
          不再提示
        </label>
      </Modal>
    </DirectionContext.Provider>
  )
}

export function useDirection() {
  const context = useContext(DirectionContext)
  if (!context) throw new Error('useDirection must be used inside DirectionProvider')
  return context
}
