'use client'

import { useEffect, useState } from 'react'
import { Badge, Button, Card } from '@/src/components/ui'
import type { NotifyFn } from './shared'
import { useI18n } from '@/src/i18n'

export function DirectionSettingsCard({ notify }: { notify: NotifyFn }) {
  const { t } = useI18n()
  const [suppressed, setSuppressed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [desktop, setDesktop] = useState(false)

  useEffect(() => {
    setDesktop(Boolean(window.agenticDesktop))
    void fetch('/api/settings')
      .then((response) => response.ok ? response.json() : [])
      .then((settings: Array<{ key: string; value: string }>) => {
        setSuppressed(
          settings.find(
            (entry) => entry.key === 'suppress_direction_switch_warning',
          )?.value === '1',
        )
      })
  }, [])

  async function restoreWarning() {
    setSaving(true)
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'suppress_direction_switch_warning',
          value: '0',
        }),
      })
      if (!response.ok) throw new Error(t('directionSettings.error.save'))
      setSuppressed(false)
      notify(t('directionSettings.restored'), { tone: 'inverted' })
    } catch (error) {
      notify(t('config.error.save'), {
        message: error instanceof Error ? error.message : t('config.error.tryLater'),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card
      overline={t('directionSettings.overline')}
      title={t('directionSettings.title')}
      actions={
        <Badge variant={suppressed ? 'subtle' : 'outline'}>
          {suppressed ? t('directionSettings.suppressed') : t('directionSettings.enabled')}
        </Badge>
      }
    >
      <div
        data-testid="direction-settings-actions"
        className="flex w-full min-w-0 max-w-full flex-wrap items-center gap-3 sm:justify-between"
      >
        <p className="w-full min-w-0 max-w-xl text-sm leading-6 text-ink-3 sm:w-auto sm:flex-1">
          {t('directionSettings.description')}
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={!suppressed || saving}
          onClick={() => void restoreWarning()}
        >
          {t('directionSettings.restore')}
        </Button>
        {desktop && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void window.agenticDesktop?.openDataDirectory()}
            >
              {t('directionSettings.openData')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void window.agenticDesktop?.openDiagnosticLogs()}
            >
              {t('directionSettings.openLogs')}
            </Button>
          </>
        )}
      </div>
    </Card>
  )
}
