import type { Translator } from './types'

const NO_WARNING_SUMMARIES = new Set([
  'No deterministic constraint warnings were found.',
  '未发现确定性约束警告',
])

const AUXILIARY_WARNING_PATTERNS = [
  /^(\d+) auxiliary warnings?\.$/,
  /^(\d+) 项辅助警告$/,
]

export function localizeEvidenceSummary(
  t: Translator,
  summary: string,
): string {
  const normalized = summary.trim()
  if (NO_WARNING_SUMMARIES.has(normalized)) {
    return t('evidence.summary.noWarnings')
  }
  for (const pattern of AUXILIARY_WARNING_PATTERNS) {
    const match = pattern.exec(normalized)
    if (match) {
      return t('evidence.summary.auxiliaryWarnings', {
        count: Number(match[1]),
      })
    }
  }
  return summary
}
