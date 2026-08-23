'use client'

import { useEffect, useState } from 'react'
import { Badge, Card, Spinner } from '@/src/components/ui'
import { useI18n, type MessageKey } from '@/src/i18n'
import type {
  LlmAnalyticsOverview,
  LlmUsageSource,
} from '@/src/lib/contracts/llm-call-records'

const USAGE_SOURCE_KEYS = {
  provider: 'usage.source.provider',
  estimated: 'usage.source.estimated',
  unknown: 'usage.source.unknown',
} as const satisfies Record<LlmUsageSource, MessageKey>

function Metric({
  label,
  value,
  detail,
}: {
  label: string
  value: string
  detail?: string
}) {
  return (
    <div className="rounded-sm border border-line bg-paper/55 px-3 py-3">
      <p className="text-xs font-medium tracking-wide text-ink-3">{label}</p>
      <p className="mt-1 font-serif text-xl font-medium tabular-nums text-ink">{value}</p>
      {detail != null && <p className="mt-1 text-[0.6875rem] leading-5 text-ink-4">{detail}</p>}
    </div>
  )
}

export function UsageOverviewCard() {
  const { t, formatCurrency, formatDuration, formatNumber } = useI18n()
  const [overview, setOverview] = useState<LlmAnalyticsOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()

    async function loadOverview() {
      try {
        const response = await fetch('/api/analytics/overview', {
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(t('usage.error.read'))

        const payload = await response.json() as LlmAnalyticsOverview
        setOverview(payload)
      } catch (loadError) {
        if (controller.signal.aborted) return
        setError(loadError instanceof Error ? loadError.message : t('usage.error.load'))
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }

    void loadOverview()
    return () => controller.abort()
  }, [t])

  const totalTokens = overview == null
    ? 0
    : overview.usage.inputTokens + overview.usage.outputTokens + overview.usage.reasoningTokens
  const usageCoverage = overview?.usage.bySource
    .filter((bucket) => bucket.callCount > 0)
    .map((bucket) => t('usage.sourceCalls', {
      source: t(USAGE_SOURCE_KEYS[bucket.source]),
      count: formatNumber(bucket.callCount),
    }))
    .join(' · ')

  return (
    <Card
      overline={t('usage.overline')}
      title={t('usage.title')}
      actions={overview != null ? (
        <Badge variant="outline">
          {t('usage.totalCallsBadge', { count: formatNumber(overview.calls.total) })}
        </Badge>
      ) : undefined}
      testId="usage-overview-card"
    >
      {loading ? (
        <div className="flex min-h-32 items-center justify-center text-ink-3">
          <Spinner />
        </div>
      ) : error != null ? (
        <div
          role="alert"
          className="rounded-sm border border-cinnabar/30 bg-cinnabar/5 px-4 py-4 text-sm leading-6 text-cinnabar"
        >
          {t('usage.errorNonBlocking', { error })}
        </div>
      ) : overview != null ? (
        <div className="space-y-4">
          {overview.calls.total === 0 && (
            <div className="rounded-sm border border-dashed border-line-2 bg-paper/60 px-4 py-5 text-center text-sm leading-6 text-ink-4">
              {t('usage.empty')}
            </div>
          )}

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <Metric label={t('usage.metric.total')} value={formatNumber(overview.calls.total)} />
            <Metric label={t('usage.metric.complete')} value={formatNumber(overview.calls.complete)} />
            <Metric
              label={t('usage.metric.failed')}
              value={formatNumber(overview.calls.failed)}
              detail={overview.calls.cancelled > 0
                ? t('usage.metric.cancelled', { count: formatNumber(overview.calls.cancelled) })
                : undefined}
            />
            <Metric
              label={t('usage.metric.tokens')}
              value={formatNumber(totalTokens)}
              detail={t('usage.metric.tokenDetail', {
                input: formatNumber(overview.usage.inputTokens),
                output: formatNumber(overview.usage.outputTokens),
                reasoning: formatNumber(overview.usage.reasoningTokens),
                coverage: usageCoverage ? t('usage.metric.coverage', { sources: usageCoverage }) : '',
              })}
            />
            <Metric
              label={t('usage.metric.firstByte')}
              value={overview.timing.averageFirstByteMs == null
                ? t('usage.noData')
                : formatDuration(overview.timing.averageFirstByteMs)}
            />
            <Metric
              label={t('usage.metric.latency')}
              value={overview.timing.averageLatencyMs == null
                ? t('usage.noData')
                : formatDuration(overview.timing.averageLatencyMs)}
            />
          </div>

          <div className="rounded-sm border border-line bg-paper/55 px-3 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium tracking-wide text-ink-3">{t('usage.cost.title')}</p>
              <Badge variant="subtle">
                {t('usage.cost.unknown', { count: formatNumber(overview.costs.unknownCallCount) })}
              </Badge>
            </div>

            {overview.costs.known.length === 0 ? (
              <p className="mt-3 text-sm text-ink-4">{t('usage.cost.empty')}</p>
            ) : (
              <ul className="mt-3 divide-y divide-line">
                {overview.costs.known.map((cost) => (
                  <li
                    key={`${cost.source}-${cost.currency}`}
                    className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
                  >
                    <div className="flex items-center gap-2">
                      <Badge variant={cost.source === 'provider' ? 'outline' : 'subtle'}>
                        {t(USAGE_SOURCE_KEYS[cost.source])}
                      </Badge>
                      <span className="font-mono text-xs text-ink-3">{cost.currency}</span>
                    </div>
                    <p className="text-sm tabular-nums text-ink">
                      {formatCurrency(cost.amount, cost.currency, {
                        currencyDisplay: 'code',
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 8,
                      })}
                      <span className="ml-2 text-xs text-ink-4">
                        {t('usage.cost.calls', { count: formatNumber(cost.callCount) })}
                      </span>
                    </p>
                  </li>
                ))}
              </ul>
            )}

            <p className="mt-3 border-t border-line pt-3 text-xs leading-5 text-ink-4">
              {t('usage.cost.note')}
            </p>
          </div>
        </div>
      ) : null}
    </Card>
  )
}
