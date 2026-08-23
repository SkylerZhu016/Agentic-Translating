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
import { useI18n } from '@/src/i18n/LocaleProvider'

interface DraftController {
  dirty: boolean
  flush: () => Promise<void>
  isInteractionLocked: () => boolean
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
  const { t } = useI18n()
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
    if (draftController.current?.isInteractionLocked()) return
    await draftController.current?.flush()
    await saveSetting('workspace_direction', target).catch(() => undefined)
    if (suppress) {
      await saveSetting('suppress_direction_switch_warning', '1').catch(
        () => undefined,
      )
      setSuppressed(true)
    }
    setPending(null)
    setSuppressChecked(false)
    const query = new URLSearchParams()
    query.set('direction', target)
    if (pathname === '/') query.set('fresh', '1')
    router.push(`${pathname}?${query.toString()}`)
  }, [pathname, router])

  const requestDirection = useCallback((target: BuiltinDirection) => {
    if (target === direction) return
    if (draftController.current?.isInteractionLocked()) return
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
        title={t('direction.warning.title')}
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
              {t('direction.warning.cancel')}
            </Button>
            <Button
              size="sm"
              testId={TID.direction.confirmButton}
              onClick={() => pending && void performSwitch(pending, suppressChecked)}
            >
              {pending === 'zh_to_en'
                ? t('direction.warning.confirmZhToEn')
                : t('direction.warning.confirmEnToZh')}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-6 text-ink-2">
          {t('direction.warning.description')}
        </p>
        <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm text-ink-2">
          <input
            type="checkbox"
            data-testid={TID.direction.suppressCheckbox}
            checked={suppressChecked}
            onChange={(event) => setSuppressChecked(event.target.checked)}
            className="h-4 w-4 accent-ink"
          />
          {t('direction.warning.suppress')}
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
