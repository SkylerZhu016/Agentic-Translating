'use client'

import { useId } from 'react'
import { Input } from '@/src/components/ui'
import { useI18n } from '@/src/i18n'

export function parseOutputBudget(value: string): number | null | undefined {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (!/^\d+$/.test(trimmed)) return undefined
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

export function OutputBudgetHint() {
  const { t } = useI18n()
  return (
    <div className="space-y-1 text-xs leading-5 text-ink-4">
      <p>{t('outputBudget.hint')}</p>
      <p>{t('outputBudget.deepSeekHint')}</p>
    </div>
  )
}

// ModelPicker reserves a status line. Collapse only an empty line beside a budget.
export const MODEL_BUDGET_LAYOUT =
  'min-w-0 space-y-1 [&>div:first-child>div:last-child:empty]:hidden'

export function OutputBudgetField({
  value,
  onChange,
  role,
}: {
  value: string
  onChange: (value: string) => void
  role: string
}) {
  const { t } = useI18n()
  const id = useId()
  const invalid = parseOutputBudget(value) === undefined

  return (
    <div className="grid gap-1 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-x-2">
      <label htmlFor={id} className="text-[11px] text-ink-3">
        {t('outputBudget.label')}
      </label>
      <Input
        id={id}
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t('outputBudget.placeholder')}
        aria-label={t('outputBudget.aria', { role })}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-error` : undefined}
      />
      {invalid && (
        <p id={`${id}-error`} role="alert" className="text-[11px] leading-4 text-cinnabar sm:col-span-2">
          {t('outputBudget.error')}
        </p>
      )}
    </div>
  )
}
