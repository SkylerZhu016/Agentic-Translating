'use client'

import { useEffect, useState } from 'react'
import { Badge, Card, Spinner } from '@/src/components/ui'
import type {
  LlmAnalyticsOverview,
  LlmUsageSource,
} from '@/src/lib/contracts/llm-call-records'

const countFormatter = new Intl.NumberFormat('zh-CN')
const decimalFormatter = new Intl.NumberFormat('zh-CN', {
  maximumFractionDigits: 1,
})
const amountFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 8,
})
const usageSourceLabel: Record<LlmUsageSource, string> = {
  provider: '供应商返回',
  estimated: '本地估算',
  unknown: '未知',
}

function formatDuration(value: number | null) {
  if (value === null) return '暂无数据'
  if (value >= 1_000) return `${decimalFormatter.format(value / 1_000)} 秒`
  return `${decimalFormatter.format(value)} ms`
}

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
        if (!response.ok) throw new Error('运行账本暂时无法读取')

        const payload = await response.json() as LlmAnalyticsOverview
        setOverview(payload)
      } catch (loadError) {
        if (controller.signal.aborted) return
        setError(loadError instanceof Error ? loadError.message : '运行账本加载失败')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }

    void loadOverview()
    return () => controller.abort()
  }, [])

  const totalTokens = overview == null
    ? 0
    : overview.usage.inputTokens + overview.usage.outputTokens + overview.usage.reasoningTokens
  const usageCoverage = overview?.usage.bySource
    .filter((bucket) => bucket.callCount > 0)
    .map((bucket) => `${usageSourceLabel[bucket.source]} ${countFormatter.format(bucket.callCount)} 次`)
    .join(' · ')

  return (
    <Card
      overline="Usage"
      title="真实运行账本"
      actions={overview != null ? <Badge variant="outline">总调用 {countFormatter.format(overview.calls.total)}</Badge> : undefined}
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
          {error}。此面板错误不影响历史会话列表。
        </div>
      ) : overview != null ? (
        <div className="space-y-4">
          {overview.calls.total === 0 && (
            <div className="rounded-sm border border-dashed border-line-2 bg-paper/60 px-4 py-5 text-center text-sm leading-6 text-ink-4">
              尚无模型调用记录。空账本是正常状态，完成一次模型调用后会在这里汇总。
            </div>
          )}

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <Metric label="总调用" value={countFormatter.format(overview.calls.total)} />
            <Metric label="完成" value={countFormatter.format(overview.calls.complete)} />
            <Metric
              label="失败"
              value={countFormatter.format(overview.calls.failed)}
              detail={overview.calls.cancelled > 0 ? `另有 ${countFormatter.format(overview.calls.cancelled)} 次取消` : undefined}
            />
            <Metric
              label="已知 Token 用量"
              value={countFormatter.format(totalTokens)}
              detail={`输入 ${countFormatter.format(overview.usage.inputTokens)} · 输出 ${countFormatter.format(overview.usage.outputTokens)} · 推理 ${countFormatter.format(overview.usage.reasoningTokens)}${usageCoverage ? `；来源：${usageCoverage}` : ''}`}
            />
            <Metric label="平均首包" value={formatDuration(overview.timing.averageFirstByteMs)} />
            <Metric label="平均耗时" value={formatDuration(overview.timing.averageLatencyMs)} />
          </div>

          <div className="rounded-sm border border-line bg-paper/55 px-3 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium tracking-wide text-ink-3">费用记录</p>
              <Badge variant="subtle">
                未知费用调用数 {countFormatter.format(overview.costs.unknownCallCount)}
              </Badge>
            </div>

            {overview.costs.known.length === 0 ? (
              <p className="mt-3 text-sm text-ink-4">暂无已知费用数据。</p>
            ) : (
              <ul className="mt-3 divide-y divide-line">
                {overview.costs.known.map((cost) => (
                  <li
                    key={`${cost.source}-${cost.currency}`}
                    className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
                  >
                    <div className="flex items-center gap-2">
                      <Badge variant={cost.source === 'provider' ? 'outline' : 'subtle'}>
                        {cost.source === 'provider' ? '供应商返回' : '本地估算'}
                      </Badge>
                      <span className="font-mono text-xs text-ink-3">{cost.currency}</span>
                    </div>
                    <p className="text-sm tabular-nums text-ink">
                      {cost.currency} {amountFormatter.format(cost.amount)}
                      <span className="ml-2 text-xs text-ink-4">
                        {countFormatter.format(cost.callCount)} 次调用
                      </span>
                    </p>
                  </li>
                ))}
              </ul>
            )}

            <p className="mt-3 border-t border-line pt-3 text-xs leading-5 text-ink-4">
              费用仅来自供应商返回值或本地价格快照估算；未知表示没有可核验的费用数据。此处是运行记录，不是供应商账单。
            </p>
          </div>
        </div>
      ) : null}
    </Card>
  )
}
