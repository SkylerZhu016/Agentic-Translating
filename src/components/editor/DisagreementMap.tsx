'use client'

import { useEffect, useMemo, useState } from 'react'
import type {
  DisagreementDifferenceKind,
  DisagreementFallbackReason,
  DisagreementHintKind,
  DisagreementHotspotDto,
  DisagreementMapDto,
} from '@/src/lib/contracts/disagreement-map'
import { Badge, Button, Card, Spinner } from '@/src/components/ui'
import { localizeDiagnosticError, useI18n, type MessageKey } from '@/src/i18n'
import type { SelectionSnapshot } from './types'

const DIFFERENCE_KEY = {
  wording: 'disagreement.kind.wording',
  punctuation: 'disagreement.kind.punctuation',
  number: 'disagreement.kind.number',
  negation: 'disagreement.kind.negation',
  proper_noun: 'disagreement.kind.properNoun',
  terminology: 'disagreement.kind.terminology',
  structure: 'disagreement.kind.structure',
} as const satisfies Record<DisagreementDifferenceKind, MessageKey>

const HINT_KEY = {
  punctuation: 'disagreement.hint.punctuation',
  number: 'disagreement.hint.number',
  negation: 'disagreement.hint.negation',
  proper_noun: 'disagreement.hint.properNoun',
  terminology: 'disagreement.hint.terminology',
} as const satisfies Record<DisagreementHintKind, MessageKey>

const FALLBACK_KEY = {
  invalid_input: 'disagreement.fallback.invalidInput',
  insufficient_candidates: 'disagreement.fallback.insufficientCandidates',
  empty_source: 'disagreement.fallback.emptySource',
  empty_candidate: 'disagreement.fallback.emptyCandidate',
  too_large: 'disagreement.fallback.tooLarge',
  segmentation_failed: 'disagreement.fallback.segmentationFailed',
  alignment_failed: 'disagreement.fallback.alignmentFailed',
  internal_error: 'disagreement.fallback.internalError',
} as const satisfies Record<DisagreementFallbackReason, MessageKey>

function adoptInstruction(body: string) {
  // This is an Agent instruction, so it stays stable when the display locale changes.
  return `请只把当前选中的最终译文片段替换为下面的候选正文，保持全文其他位置不变。\n\n替换内容：\n${body}`
}

function uniqueSelection(
  currentText: string,
  fragment: string | null,
): SelectionSnapshot | null {
  if (!fragment) return null
  const start = currentText.indexOf(fragment)
  if (start < 0 || currentText.indexOf(fragment, start + 1) >= 0) return null
  return { text: fragment, start, end: start + fragment.length }
}

function isDisagreementMapDto(value: unknown): value is DisagreementMapDto {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    (record.status === 'ready' || record.status === 'full_text_fallback') &&
    Array.isArray(record.hotspots) &&
    typeof record.candidateSetHash === 'string'
  )
}

function Hotspot({
  hotspot,
  currentText,
  canAdopt,
  busy,
  onAdopt,
}: {
  hotspot: DisagreementHotspotDto
  currentText: string
  canAdopt: boolean
  busy: boolean
  onAdopt: (instruction: string, selection: SelectionSnapshot) => void
}) {
  const { t, formatNumber } = useI18n()
  const selection = uniqueSelection(currentText, hotspot.finalSegment)
  const candidateNames = useMemo(
    () => new Map(
      hotspot.candidates.map((candidate) => [
        candidate.invocationId,
        candidate.agentName,
      ]),
    ),
    [hotspot.candidates],
  )

  return (
    <details className="group border-b border-line last:border-b-0">
      <summary className="flex cursor-pointer list-none items-start gap-2 px-4 py-3 text-left hover:bg-paper-sink/60">
        <span className="mt-0.5 text-xs text-ink-4 transition-transform group-open:rotate-90" aria-hidden>
          ▸
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-serif text-sm font-medium text-ink">
            {t('disagreement.hotspot', { number: formatNumber(hotspot.index + 1) })}
          </span>
          <span className="mt-0.5 block truncate text-xs text-ink-3">
            {hotspot.sourceRange.text}
          </span>
        </span>
        <span className="flex max-w-32 flex-wrap justify-end gap-1">
          {hotspot.differenceKinds.slice(0, 3).map((kind) => (
            <Badge key={kind} variant="subtle">{t(DIFFERENCE_KEY[kind])}</Badge>
          ))}
        </span>
      </summary>

      <div className="space-y-4 bg-paper px-4 py-4">
        <div>
          <p className="mb-1 text-xs font-medium tracking-wide text-ink-3">{t('disagreement.sourceSegment')}</p>
          <blockquote className="whitespace-pre-wrap rounded-sm border border-line bg-paper-raise px-3 py-2 font-serif text-sm leading-6 text-ink-2">
            {hotspot.sourceRange.text}
          </blockquote>
        </div>

        {hotspot.finalSegment != null && (
          <div>
            <p className="mb-1 text-xs font-medium tracking-wide text-ink-3">{t('disagreement.finalSegment')}</p>
            <blockquote className="whitespace-pre-wrap rounded-sm border border-line bg-paper-sink/70 px-3 py-2 font-serif text-sm leading-6 text-ink-2">
              {hotspot.finalSegment}
            </blockquote>
          </div>
        )}

        <div className="space-y-2">
          <p className="text-xs font-medium tracking-wide text-ink-3">{t('disagreement.candidateDifferences')}</p>
          {hotspot.candidates.map((candidate) => {
            const isCurrent = hotspot.adoptedCandidateIds.includes(
              candidate.invocationId,
            )
            return (
              <div
                key={candidate.invocationId}
                className="rounded-sm border border-line bg-paper-raise px-3 py-3"
              >
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline">{candidate.agentName}</Badge>
                  <Badge variant="subtle" className="max-w-full break-all">
                    {candidate.model}
                  </Badge>
                  {isCurrent && <Badge variant="solid">{t('disagreement.current')}</Badge>}
                </div>
                <p className="whitespace-pre-wrap font-serif text-sm leading-6 text-ink-2">
                  {candidate.bodySegment}
                </p>
                {!isCurrent && selection && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    disabled={!canAdopt || busy}
                    onClick={() => onAdopt(
                      adoptInstruction(candidate.bodySegment),
                      selection,
                    )}
                  >
                    {t('disagreement.adopt')}
                  </Button>
                )}
              </div>
            )
          })}
          {hotspot.finalSegment != null && !selection && (
            <p className="text-xs leading-5 text-ink-4">
              {t('disagreement.notUnique')}
            </p>
          )}
        </div>

        {hotspot.hints.length > 0 && (
          <div className="rounded-sm border border-line-2 bg-paper-sink/60 px-3 py-3">
            <div className="mb-2 flex items-center gap-2">
              <p className="text-xs font-medium tracking-wide text-ink-3">{t('disagreement.deterministicHints')}</p>
              <Badge variant="outline">{t('disagreement.mechanical')}</Badge>
            </div>
            <ul className="space-y-2 text-xs leading-5 text-ink-3">
              {hotspot.hints.map((hint) => (
                <li key={hint.kind}>
                  <span className="font-medium text-ink-2">{t(HINT_KEY[hint.kind])}: </span>
                  {hint.candidateValues.map((entry) => (
                    <span key={entry.invocationId} className="ml-1.5 inline-block">
                      {candidateNames.get(entry.invocationId) ?? entry.invocationId.slice(0, 8)}
                      {' '}
                      [{entry.values.join(' · ') || t('disagreement.none')}]
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  )
}

export function DisagreementMap({
  sessionId,
  finalVersionId,
  candidateRevision,
  currentText,
  canAdopt,
  busy,
  onAdopt,
}: {
  sessionId: string | null
  finalVersionId: number | null
  candidateRevision: string
  currentText: string
  canAdopt: boolean
  busy: boolean
  onAdopt: (instruction: string, selection: SelectionSnapshot) => void
}) {
  const { t, formatNumber } = useI18n()
  const [requested, setRequested] = useState(false)
  const [reloadNo, setReloadNo] = useState(0)
  const [map, setMap] = useState<DisagreementMapDto | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!requested) return
    if (!sessionId) {
      setMap(null)
      setError(null)
      setLoading(false)
      return
    }

    const controller = new AbortController()
    setMap(null)
    setError(null)
    setLoading(true)

    void fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/disagreement-map`,
      { cache: 'no-store', signal: controller.signal },
    )
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as unknown
        if (!response.ok) {
          const detail = payload && typeof payload === 'object'
            ? payload as { error?: unknown; message?: unknown }
            : null
          throw new Error(
            localizeDiagnosticError(
              t,
              detail?.error,
              t('disagreement.error.request', { status: response.status }),
            ),
          )
        }
        if (!isDisagreementMapDto(payload)) {
          throw new Error(t('disagreement.error.invalid'))
        }
        setMap(payload)
      })
      .catch((fetchError: unknown) => {
        if (controller.signal.aborted) return
        setError(
          fetchError instanceof Error
            ? fetchError.message
            : t('disagreement.error.unavailable'),
        )
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [
    requested,
    sessionId,
    finalVersionId,
    candidateRevision,
    reloadNo,
    t,
  ])

  return (
    <Card
      overline={t('disagreement.overline')}
      title={t('disagreement.title')}
      padded={false}
      testId="disagreement-map"
      actions={map ? (
        <Badge variant={map.status === 'ready' ? 'outline' : 'subtle'}>
          {map.status === 'ready'
            ? t('disagreement.count', { count: formatNumber(map.hotspots.length) })
            : t('disagreement.fullComparison')}
        </Badge>
      ) : undefined}
    >
      <div className="space-y-3 px-4 py-4">
        <p className="text-xs leading-5 text-ink-3">
          {t('disagreement.description')}
        </p>

        {!requested && (
          <Button
            variant="outline"
            size="sm"
            disabled={!sessionId}
            onClick={() => setRequested(true)}
          >
            {t('disagreement.open')}
          </Button>
        )}

        {requested && loading && (
          <div className="flex items-center gap-2 py-2 text-sm text-ink-3">
            <Spinner size="sm" />
            {t('disagreement.loading')}
          </div>
        )}

        {requested && error && !loading && (
          <div role="alert" className="rounded-sm border border-cinnabar/30 bg-cinnabar/5 px-3 py-3">
            <p className="text-sm text-cinnabar">{error}</p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() => setReloadNo((value) => value + 1)}
            >
              {t('disagreement.retry')}
            </Button>
          </div>
        )}

        {requested && map && !loading && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="subtle">
              {map.segmentationMode === 'full_text'
                ? t('disagreement.mode.full')
                : t('disagreement.mode.segmented')}
            </Badge>
            {map.finalAlignmentStatus === 'unavailable' && (
              <span className="text-xs text-ink-4">{t('disagreement.alignmentUnavailable')}</span>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => setReloadNo((value) => value + 1)}
            >
              {t('disagreement.refresh')}
            </Button>
          </div>
        )}
      </div>

      {requested && map?.status === 'ready' && !loading && (
        map.hotspots.length === 0 ? (
          <p className="border-t border-line px-4 py-4 text-sm leading-6 text-ink-3">
            {t('disagreement.noHotspots')}
          </p>
        ) : (
          <div className="max-h-[42rem] overflow-y-auto border-t border-line">
            {map.hotspots.map((hotspot) => (
              <Hotspot
                key={hotspot.id}
                hotspot={hotspot}
                currentText={currentText}
                canAdopt={canAdopt}
                busy={busy}
                onAdopt={onAdopt}
              />
            ))}
          </div>
        )
      )}

      {requested && map?.status === 'full_text_fallback' && map.fallback && !loading && (
        <div className="space-y-3 border-t border-line px-4 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{t('disagreement.fullTextOnly')}</Badge>
            <span className="text-xs text-ink-4">
              {t(FALLBACK_KEY[map.fallback.reason])}
            </span>
          </div>

          <details className="rounded-sm border border-line bg-paper" open>
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-ink-3">
              {t('disagreement.sourceFull')}
            </summary>
            <p className="max-h-48 overflow-y-auto whitespace-pre-wrap border-t border-line px-3 py-3 font-serif text-sm leading-6 text-ink-2">
              {map.fallback.sourceText}
            </p>
          </details>

          {map.fallback.candidates.map((candidate) => (
            <details
              key={candidate.invocationId}
              className="rounded-sm border border-line bg-paper"
            >
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-ink-3">
                {candidate.agentName} · {candidate.model}
              </summary>
              <p className="max-h-48 overflow-y-auto whitespace-pre-wrap border-t border-line px-3 py-3 font-serif text-sm leading-6 text-ink-2">
                {candidate.body}
              </p>
            </details>
          ))}

          {map.fallback.finalText != null && (
            <details className="rounded-sm border border-line bg-paper">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-ink-3">
                {t('disagreement.finalFull')}
              </summary>
              <p className="max-h-48 overflow-y-auto whitespace-pre-wrap border-t border-line px-3 py-3 font-serif text-sm leading-6 text-ink-2">
                {map.fallback.finalText}
              </p>
            </details>
          )}
        </div>
      )}
    </Card>
  )
}
