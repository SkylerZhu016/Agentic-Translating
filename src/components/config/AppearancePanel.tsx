'use client'

import { useEffect, useId, useState } from 'react'
import { Button, Card, Input } from '@/src/components/ui'
import { useI18n } from '@/src/i18n'
import { APPEARANCE_THEMES, normalizeAccent, useAppearance } from '@/src/lib/appearance'

export function AppearancePanel() {
  const { t } = useI18n()
  const {
    themeId,
    customAccent,
    effectiveAccent,
    persistenceError,
    setTheme,
    setAccent,
    resetAccent,
  } = useAppearance()
  const id = useId()
  const currentTheme = APPEARANCE_THEMES.find((theme) => theme.id === themeId) ?? APPEARANCE_THEMES[0]
  const requestedAccent = customAccent ?? currentTheme.colors.accent
  const [draftAccent, setDraftAccent] = useState(requestedAccent)
  const [invalidAccent, setInvalidAccent] = useState(false)

  useEffect(() => {
    setDraftAccent(requestedAccent)
    setInvalidAccent(false)
  }, [themeId, requestedAccent])

  function commitAccent() {
    const normalized = normalizeAccent(draftAccent)
    if (!normalized) {
      setInvalidAccent(true)
      return
    }
    if (normalized !== normalizeAccent(requestedAccent) && !setAccent(normalized)) {
      setInvalidAccent(true)
      return
    }
    setDraftAccent(normalized)
    setInvalidAccent(false)
  }

  function resetCurrentAccent() {
    resetAccent()
    setDraftAccent(currentTheme.colors.accent)
    setInvalidAccent(false)
  }

  const pickerColor = normalizeAccent(draftAccent) ?? normalizeAccent(requestedAccent) ?? effectiveAccent

  return (
    <Card title={t('appearance.title')} testId="appearance-panel">
      <p className="max-w-2xl text-sm leading-6 text-ink-3">{t('appearance.description')}</p>
      <fieldset className="mt-5 min-w-0">
        <legend className="text-sm font-medium text-ink">{t('appearance.chooseTheme')}</legend>
        <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {APPEARANCE_THEMES.map((theme) => {
            const selected = themeId === theme.id
            const accent = selected ? effectiveAccent : theme.colors.accent
            return (
              <label key={theme.id} className="relative min-w-0 cursor-pointer">
                <input
                  type="radio"
                  name={`${id}-theme`}
                  value={theme.id}
                  data-testid={`appearance-theme-${theme.id}`}
                  checked={selected}
                  onChange={() => setTheme(theme.id)}
                  aria-label={t(theme.nameKey)}
                  aria-describedby={`${id}-${theme.id}-hint`}
                  className="peer sr-only"
                />
                <span
                  className={[
                    'block h-full min-w-0 overflow-hidden rounded-md border p-2.5 transition-shadow',
                    'peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-pine',
                    selected ? 'border-pine ring-1 ring-pine' : 'border-line hover:border-line-2',
                  ].join(' ')}
                  style={{ backgroundColor: theme.colors.paper }}
                >
                  <span
                    aria-hidden="true"
                    className="mb-3 flex h-20 overflow-hidden rounded-sm border"
                    style={{ borderColor: theme.colors.line, backgroundColor: theme.colors.surface }}
                  >
                    <span className="flex w-9 shrink-0 flex-col gap-2 p-2" style={{ backgroundColor: theme.colors.panel }}>
                      <span className="h-2 rounded-sm" style={{ backgroundColor: accent }} />
                      <span className="h-1.5 rounded-sm opacity-25" style={{ backgroundColor: theme.colors.ink }} />
                      <span className="h-1.5 rounded-sm opacity-25" style={{ backgroundColor: theme.colors.ink }} />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-2 p-3">
                      <span className="h-1.5 w-3/5 rounded-sm opacity-70" style={{ backgroundColor: theme.colors.ink }} />
                      <span className="h-1 w-full rounded-sm opacity-20" style={{ backgroundColor: theme.colors.ink }} />
                      <span className="h-1 w-4/5 rounded-sm opacity-20" style={{ backgroundColor: theme.colors.ink }} />
                      <span className="mt-auto h-3 w-10 rounded-sm" style={{ backgroundColor: accent }} />
                    </span>
                  </span>
                  <span className="flex min-w-0 items-center justify-between gap-2" style={{ color: theme.colors.ink }}>
                    <span className="min-w-0 text-sm font-semibold">{t(theme.nameKey)}</span>
                    <span
                      aria-hidden="true"
                      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border"
                      style={{
                        borderColor: selected ? accent : theme.colors.line,
                        backgroundColor: selected ? accent : theme.colors.surface,
                      }}
                    >
                      {selected && <svg viewBox="0 0 12 12" className="h-3 w-3 text-white" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m2.5 6 2.2 2.2 4.8-4.8" /></svg>}
                    </span>
                  </span>
                  <span
                    id={`${id}-${theme.id}-hint`}
                    className="mt-1 block text-xs leading-5"
                    style={{ color: theme.colors.ink }}
                  >
                    {t(`appearance.theme.${theme.id}.hint` as const)}
                  </span>
                </span>
              </label>
            )
          })}
        </div>
      </fieldset>

      <div className="mt-5 border-t border-line pt-5">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-ink">{t('appearance.customAccent')}</h3>
          <Button size="sm" variant="ghost" testId="appearance-reset-accent" onClick={resetCurrentAccent}>{t('appearance.resetAccent')}</Button>
        </div>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-3">{t('appearance.customAccent.hint')}</p>
        <div className="mt-3 flex min-w-0 flex-wrap items-start gap-x-5 gap-y-3">
          <div className="min-w-0">
            <label htmlFor={`${id}-hex`} className="mb-1.5 block text-xs font-medium text-ink-3">{t('appearance.inputColor')}</label>
            <div className="flex min-w-0 items-center gap-2">
              <input
                type="color"
                data-testid="appearance-accent-picker"
                value={pickerColor}
                aria-label={t('appearance.pickColor')}
                onChange={(event) => {
                  const next = event.target.value
                  setDraftAccent(next)
                  setInvalidAccent(false)
                  setAccent(next)
                }}
                className="h-9 w-12 shrink-0 cursor-pointer rounded-sm border border-line bg-paper-raise p-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine"
              />
              <Input
                id={`${id}-hex`}
                testId="appearance-accent-hex"
                value={draftAccent}
                onChange={(event) => {
                  setDraftAccent(event.target.value)
                  setInvalidAccent(false)
                }}
                onBlur={commitAccent}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    event.currentTarget.blur()
                  } else if (event.key === 'Escape') {
                    setDraftAccent(requestedAccent)
                    setInvalidAccent(false)
                  }
                }}
                aria-invalid={invalidAccent || undefined}
                aria-describedby={`${id}-hex-hint${invalidAccent ? ` ${id}-hex-error` : ''}`}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                className="max-w-36 font-mono uppercase"
              />
            </div>
            <p id={`${id}-hex-hint`} className="mt-1.5 text-xs leading-5 text-ink-4">{t('appearance.hexHint')}</p>
            {invalidAccent && <p id={`${id}-hex-error`} role="alert" className="mt-1 max-w-xs text-xs leading-5 text-cinnabar">{t('appearance.invalidColor')}</p>}
          </div>
          <div className="min-w-0">
            <p className="mb-1.5 text-xs font-medium text-ink-3">{t('appearance.appliedColor')}</p>
            <div className="flex h-9 items-center gap-2 text-sm text-ink">
              <span className="h-5 w-5 shrink-0 rounded-full border border-line" style={{ backgroundColor: effectiveAccent }} aria-hidden="true" />
              <span className="font-mono" data-testid="appearance-applied-accent">{effectiveAccent.toUpperCase()}</span>
            </div>
          </div>
        </div>
        <p className="mt-3 max-w-2xl text-xs leading-5 text-ink-3">{t('appearance.contrastHint')}</p>
      </div>
      <p role="status" data-testid="appearance-save-status" className={`mt-4 text-xs leading-5 ${persistenceError ? 'text-cinnabar' : 'text-ink-4'}`}>
        {t(persistenceError ? 'appearance.saveError' : 'appearance.localSave')}
      </p>
    </Card>
  )
}
