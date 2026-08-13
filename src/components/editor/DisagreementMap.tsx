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
import type { SelectionSnapshot } from './types'

const DIFFERENCE_LABEL: Record<DisagreementDifferenceKind, string> = {
  wording: '措辞',
  punctuation: '标点',
  number: '数字',
  negation: '否定',
  proper_noun: '专名',
  terminology: '术语',
  structure: '结构',
}

const HINT_LABEL: Record<DisagreementHintKind, string> = {
  punctuation: '标点清单不同',
  number: '数字清单不同',
  negation: '否定表达不同',
  proper_noun: '专名清单不同',
  terminology: '术语清单不同',
}

const FALLBACK_LABEL: Record<DisagreementFallbackReason, string> = {
  invalid_input: '输入不完整',
  insufficient_candidates: '可比较候选不足',
  empty_source: '原文为空',
  empty_candidate: '候选正文为空',
  too_large: '文本过长',
  segmentation_failed: '分段失败',
  alignment_failed: '片段未能对齐',
  internal_error: '比较过程异常',
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
            原文片段 {hotspot.index + 1}
          </span>
          <span className="mt-0.5 block truncate text-xs text-ink-3">
            {hotspot.sourceRange.text}
          </span>
        </span>
        <span className="flex max-w-32 flex-wrap justify-end gap-1">
          {hotspot.differenceKinds.slice(0, 3).map((kind) => (
            <Badge key={kind} variant="subtle">{DIFFERENCE_LABEL[kind]}</Badge>
          ))}
        </span>
      </summary>

      <div className="space-y-4 bg-paper px-4 py-4">
        <div>
          <p className="mb-1 text-xs font-medium tracking-wide text-ink-3">来源片段</p>
          <blockquote className="whitespace-pre-wrap rounded-sm border border-line bg-paper-raise px-3 py-2 font-serif text-sm leading-6 text-ink-2">
            {hotspot.sourceRange.text}
          </blockquote>
        </div>

        {hotspot.finalSegment != null && (
          <div>
            <p className="mb-1 text-xs font-medium tracking-wide text-ink-3">当前最终译文片段</p>
            <blockquote className="whitespace-pre-wrap rounded-sm border border-line bg-paper-sink/70 px-3 py-2 font-serif text-sm leading-6 text-ink-2">
              {hotspot.finalSegment}
            </blockquote>
          </div>
        )}

        <div className="space-y-2">
          <p className="text-xs font-medium tracking-wide text-ink-3">候选差异</p>
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
                  {isCurrent && <Badge variant="solid">当前采用</Badge>}
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
                      `请只把当前选中的最终译文片段替换为下面的候选正文，保持全文其他位置不变。\n\n替换内容：\n${candidate.bodySegment}`,
                      selection,
                    )}
                  >
                    交给编辑 Agent 采用
                  </Button>
                )}
              </div>
            )
          })}
          {hotspot.finalSegment != null && !selection && (
            <p className="text-xs leading-5 text-ink-4">
              当前译文中无法唯一定位这段文字，因此暂不提供自动采用操作。
            </p>
          )}
        </div>

        {hotspot.hints.length > 0 && (
          <div className="rounded-sm border border-line-2 bg-paper-sink/60 px-3 py-3">
            <div className="mb-2 flex items-center gap-2">
              <p className="text-xs font-medium tracking-wide text-ink-3">确定性提示</p>
              <Badge variant="outline">机械确定</Badge>
            </div>
            <ul className="space-y-2 text-xs leading-5 text-ink-3">
              {hotspot.hints.map((hint) => (
                <li key={hint.kind}>
                  <span className="font-medium text-ink-2">{HINT_LABEL[hint.kind]}：</span>
                  {hint.candidateValues.map((entry) => (
                    <span key={entry.invocationId} className="ml-1.5 inline-block">
                      {candidateNames.get(entry.invocationId) ?? entry.invocationId.slice(0, 8)}
                      {' '}
                      [{entry.values.join('、') || '无'}]
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
            typeof detail?.message === 'string'
              ? detail.message
              : typeof detail?.error === 'string'
                ? detail.error
                : `分歧地图请求失败（${response.status}）`,
          )
        }
        if (!isDisagreementMapDto(payload)) {
          throw new Error('分歧地图返回了无法识别的数据')
        }
        setMap(payload)
      })
      .catch((fetchError: unknown) => {
        if (controller.signal.aborted) return
        setError(
          fetchError instanceof Error
            ? fetchError.message
            : '分歧地图暂时无法加载',
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
  ])

  return (
    <Card
      overline="Evidence"
      title="分歧地图"
      padded={false}
      testId="disagreement-map"
      actions={map ? (
        <Badge variant={map.status === 'ready' ? 'outline' : 'subtle'}>
          {map.status === 'ready' ? `${map.hotspots.length} 处分歧` : '全文比较'}
        </Badge>
      ) : undefined}
    >
      <div className="space-y-3 px-4 py-4">
        <p className="text-xs leading-5 text-ink-3">
          对照各翻译 Agent 的候选正文与当前译文。提示仅是机械差异，不判断对错。
        </p>

        {!requested && (
          <Button
            variant="outline"
            size="sm"
            disabled={!sessionId}
            onClick={() => setRequested(true)}
          >
            查看分歧地图
          </Button>
        )}

        {requested && loading && (
          <div className="flex items-center gap-2 py-2 text-sm text-ink-3">
            <Spinner size="sm" />
            正在比较候选正文…
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
              重试
            </Button>
          </div>
        )}

        {requested && map && !loading && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="subtle">
              {map.segmentationMode === 'full_text' ? '全文' : '按片段'}
            </Badge>
            {map.finalAlignmentStatus === 'unavailable' && (
              <span className="text-xs text-ink-4">当前译文未能按片段对齐</span>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => setReloadNo((value) => value + 1)}
            >
              刷新
            </Button>
          </div>
        )}
      </div>

      {requested && map?.status === 'ready' && !loading && (
        map.hotspots.length === 0 ? (
          <p className="border-t border-line px-4 py-4 text-sm leading-6 text-ink-3">
            当前候选在机械比较阈值下没有形成明显分歧片段。
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
            <Badge variant="outline">本次只能按全文比较</Badge>
            <span className="text-xs text-ink-4">
              {FALLBACK_LABEL[map.fallback.reason]}
            </span>
          </div>

          <details className="rounded-sm border border-line bg-paper" open>
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-ink-3">
              原文全文
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
                当前最终译文全文
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
