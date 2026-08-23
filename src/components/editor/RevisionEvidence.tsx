'use client'

import { useState } from 'react'
import { Badge, Button, Modal } from '@/src/components/ui'
import type { DiffSpan, EvidenceReference } from '@/src/lib/contracts/vnext'
import { useI18n } from '@/src/i18n/LocaleProvider'
import { localizeDiagnosticError } from '@/src/i18n/diagnostic'

export interface TextPatchView {
  id: string
  base_version_id: number
  result_version_id: number
  old_text: string
  new_text: string
  reason: string
  evidence_refs_json: string
  diff_spans_json: string
  created_at: string
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function RevisionEvidence({
  sessionId,
  patches,
  currentVersionId,
  onChanged,
}: {
  sessionId: string | null
  patches: TextPatchView[]
  currentVersionId: number | null
  onChanged: () => Promise<unknown>
}) {
  const { t } = useI18n()
  const [selected, setSelected] = useState<TextPatchView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function undo() {
    if (!sessionId || !selected) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/patches/${encodeURIComponent(selected.id)}/revert`,
        { method: 'POST' },
      )
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as {
          error?: string
          message?: string
        } | null
        throw new Error(
          localizeDiagnosticError(t, payload?.error, t('evidence.error.undo')),
        )
      }
      setSelected(null)
      await onChanged()
    } catch (undoError) {
      setError(undoError instanceof Error ? undoError.message : t('evidence.error.undo'))
    } finally {
      setBusy(false)
    }
  }

  if (patches.length === 0) return null
  return (
    <>
      <div className="border-t border-line px-4 py-3">
        <p className="mb-2 text-xs font-medium tracking-wide text-ink-3">{t('evidence.heading')}</p>
        <div className="flex flex-wrap gap-1.5">
          {[...patches].reverse().slice(0, 8).map((patch) => (
            <button
              key={patch.id}
              type="button"
              onClick={() => {
                setSelected(patch)
                setError(null)
              }}
              className="rounded-xs border border-line-2 bg-paper px-2 py-1 text-xs text-ink-2 hover:bg-paper-sink"
            >
              {patch.reason || t('evidence.defaultReason')}
            </button>
          ))}
        </div>
      </div>
      <Modal
        open={selected != null}
        onClose={() => setSelected(null)}
        title={t('evidence.modal.title')}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
              {t('common.close')}
            </Button>
            <Button
              size="sm"
              disabled={
                busy ||
                selected == null ||
                selected.result_version_id !== currentVersionId
              }
              onClick={() => void undo()}
            >
              {t('evidence.undo')}
            </Button>
          </>
        }
      >
        {selected && (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">Patch {selected.id.slice(0, 8)}</Badge>
              <Badge variant="subtle">{t('evidence.version', { version: selected.result_version_id })}</Badge>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-ink-3">{t('evidence.diff')}</p>
              <div className="rounded-sm border border-line bg-paper p-3 font-serif leading-7">
                {parseJson<DiffSpan[]>(selected.diff_spans_json, []).map((span, index) => (
                  <span
                    key={`${index}-${span.type}`}
                    className={
                      span.type === 'insert'
                        ? 'bg-pine/15 text-pine'
                        : span.type === 'delete'
                          ? 'bg-cinnabar/10 text-cinnabar line-through'
                          : ''
                    }
                  >
                    {span.text}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs font-medium text-ink-3">{t('evidence.reason')}</p>
              <p className="mt-1 leading-6 text-ink-2">{selected.reason || t('evidence.notRecorded')}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-ink-3">{t('evidence.candidates')}</p>
              <p className="mt-1 font-mono text-xs leading-5 text-ink-3">
                {parseJson<EvidenceReference[]>(
                  selected.evidence_refs_json,
                  [],
                ).map((reference) => reference.invocationId).join(' · ') || t('evidence.noCandidate')}
              </p>
            </div>
            {error && <p role="alert" className="text-cinnabar">{error}</p>}
          </div>
        )}
      </Modal>
    </>
  )
}
