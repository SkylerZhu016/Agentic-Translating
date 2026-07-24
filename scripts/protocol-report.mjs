import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const PROTOCOLS = ['strict-json', 'freeform-raw', 'fsbp-v1']
const SCORE_KEYS = [
  'faithfulness',
  'naturalness',
  'style',
  'structure',
  'coherence',
]

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue
    result[argv[index].slice(2)] = argv[index + 1]
    index += 1
  }
  return result
}

function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0
}

function wilson(wins, total, z = 1.959963984540054) {
  if (total === 0) return [0, 0]
  const p = wins / total
  const denominator = 1 + (z * z) / total
  const centre = p + (z * z) / (2 * total)
  const margin =
    z *
    Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total)
  return [(centre - margin) / denominator, (centre + margin) / denominator]
}

function binomialCoefficient(n, k) {
  let value = 1
  for (let index = 1; index <= k; index += 1) {
    value = (value * (n - index + 1)) / index
  }
  return value
}

function signTestP(wins, losses) {
  const n = wins + losses
  if (n === 0) return 1
  const tail = Math.min(wins, losses)
  let probability = 0
  for (let index = 0; index <= tail; index += 1) {
    probability += binomialCoefficient(n, index) * 0.5 ** n
  }
  return Math.min(1, probability * 2)
}

function csvCell(value) {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function htmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.run) {
    throw new Error(
      'Usage: npm run experiment:report -- --run <run-id>',
    )
  }
  const root = process.cwd()
  const runDir = path.join(root, 'experiments', 'results', args.run)
  const raw = await readFile(path.join(runDir, 'raw.jsonl'), 'utf8')
  const records = raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const manifest = JSON.parse(
    await readFile(path.join(runDir, 'manifest.json'), 'utf8'),
  )
  const runConfig = JSON.parse(
    await readFile(path.join(runDir, 'run-config.json'), 'utf8'),
  )
  const configPath = path.resolve(root, runConfig.configPath)
  const samples = JSON.parse(
    await readFile(
      path.resolve(path.dirname(configPath), runConfig.samples),
      'utf8',
    ),
  )
  const sampleById = new Map(samples.map((sample) => [sample.id, sample]))
  const stages = records.filter((record) => record.type === 'stage')
  const judgments = records.filter(
    (record) => record.type === 'judge' && Array.isArray(record.ranking),
  )
  const judgmentsBySample = new Map()
  for (const judgment of judgments) {
    const entries = judgmentsBySample.get(judgment.sampleId) ?? []
    entries.push(judgment)
    judgmentsBySample.set(judgment.sampleId, entries)
  }
  const sampleRankingSummaries = [...judgmentsBySample.entries()].map(
    ([sampleId, items]) => {
      const rankTotals = Object.fromEntries(
        PROTOCOLS.map((protocol) => [protocol, 0]),
      )
      for (const judgment of items) {
        const ranked = judgment.ranking.map(
          (label) => judgment.labelToProtocol[label],
        )
        for (const protocol of PROTOCOLS) {
          rankTotals[protocol] += ranked.indexOf(protocol) + 1
        }
      }
      const bestTotal = Math.min(...Object.values(rankTotals))
      return {
        sampleId,
        items,
        rankTotals,
        winners: PROTOCOLS.filter(
          (protocol) => rankTotals[protocol] === bestTotal,
        ),
      }
    },
  )
  const decidedSampleRankings = sampleRankingSummaries.filter(
    (summary) => summary.winners.length === 1,
  )
  const rows = []

  for (const protocol of PROTOCOLS) {
    const protocolStages = stages.filter(
      (record) => record.protocol === protocol,
    )
    const completeStages = protocolStages.filter(
      (record) => record.status === 'complete',
    )
    const rankings = []
    const scores = Object.fromEntries(SCORE_KEYS.map((key) => [key, []]))
    for (const judgment of judgments) {
      const protocolByLabel = judgment.labelToProtocol
      const rankedProtocols = judgment.ranking.map(
        (label) => protocolByLabel[label],
      )
      rankings.push(rankedProtocols.indexOf(protocol) + 1)
      for (const [label, item] of Object.entries(judgment.scores ?? {})) {
        if (protocolByLabel[label] !== protocol) continue
        for (const key of SCORE_KEYS) {
          const numeric = Number(item?.[key])
          if (Number.isFinite(numeric)) scores[key].push(numeric)
        }
      }
    }
    const wins = decidedSampleRankings.filter(
      (summary) => summary.winners[0] === protocol,
    ).length
    const [low, high] = wilson(wins, decidedSampleRankings.length)
    const structuralFinals = completeStages.filter((record) => {
      if (record.stage !== 'assemble') return false
      const sample = sampleById.get(record.sampleId)
      return (
        sample &&
        sample.sourceText.split(/\r?\n/).filter((line) => line.trim()).length >
          1
      )
    })
    const hardConstraintPasses = structuralFinals.filter((record) => {
      const sample = sampleById.get(record.sampleId)
      const sourceLines = sample.sourceText
        .split(/\r?\n/)
        .filter((line) => line.trim()).length
      const targetLines = record.body
        .split(/\r?\n/)
        .filter((line) => line.trim()).length
      return sourceLines === targetLines
    }).length
    const expectedStageCount = manifest.sampleCount * 4
    rows.push({
      protocol,
      stage_completion_rate: completeStages.length / expectedStageCount,
      format_success_rate:
        protocolStages.filter((record) => record.formatSuccess).length /
        expectedStageCount,
      retries: protocolStages.reduce(
        (sum, record) => sum + (record.retryCount ?? 0),
        0,
      ),
      mean_latency_ms: mean(
        completeStages
          .map((record) => Number(record.latencyMs))
          .filter(Number.isFinite),
      ),
      total_tokens: completeStages.reduce(
        (sum, record) => sum + Number(record.usage?.total_tokens ?? 0),
        0,
      ),
      judge_wins: wins,
      judge_count: decidedSampleRankings.length,
      judge_ties:
        sampleRankingSummaries.length - decidedSampleRankings.length,
      judge_evaluations: rankings.length,
      win_rate:
        decidedSampleRankings.length
          ? wins / decidedSampleRankings.length
          : 0,
      wilson_low: low,
      wilson_high: high,
      mean_rank: mean(rankings),
      hard_constraint_passes: hardConstraintPasses,
      hard_constraint_count: structuralFinals.length,
      hard_constraint_satisfaction:
        structuralFinals.length === 0
          ? 0
          : hardConstraintPasses / structuralFinals.length,
      ...Object.fromEntries(
        SCORE_KEYS.map((key) => [`score_${key}`, mean(scores[key])]),
      ),
    })
  }

  const pairs = []
  for (let left = 0; left < PROTOCOLS.length; left += 1) {
    for (let right = left + 1; right < PROTOCOLS.length; right += 1) {
      const a = PROTOCOLS[left]
      const b = PROTOCOLS[right]
      let aWins = 0
      let bWins = 0
      let ties = 0
      for (const summary of sampleRankingSummaries) {
        if (summary.rankTotals[a] < summary.rankTotals[b]) aWins += 1
        else if (summary.rankTotals[a] > summary.rankTotals[b]) bWins += 1
        else ties += 1
      }
      pairs.push({
        a,
        b,
        aWins,
        bWins,
        ties,
        p: signTestP(aWins, bWins),
      })
    }
  }

  const stressIds = new Set(
    samples
      .filter((sample) => sample.stressAnnotation)
      .map((sample) => sample.id),
  )
  const stressSummaries = sampleRankingSummaries.filter((summary) =>
    stressIds.has(summary.sampleId),
  )
  const stressWins = Object.fromEntries(
    PROTOCOLS.map((protocol) => [
      protocol,
      stressSummaries.filter(
        (summary) =>
          summary.winners.length === 1 &&
          summary.winners[0] === protocol,
      ).length,
    ]),
  )
  const stressTies = stressSummaries.filter(
    (summary) => summary.winners.length !== 1,
  ).length
  const doubleJudged = sampleRankingSummaries.filter(
    (summary) => summary.items.length === 2,
  )
  const stableTopChoices = doubleJudged.filter((summary) => {
    const winners = summary.items.map(
      (item) => item.labelToProtocol[item.ranking[0]],
    )
    return winners[0] === winners[1]
  }).length

  const headers = Object.keys(rows[0])
  const csv = [
    headers.join(','),
    ...rows.map((row) =>
      headers.map((header) => csvCell(row[header])).join(','),
    ),
  ].join('\n')
  await writeFile(path.join(runDir, 'metrics.csv'), `${csv}\n`, 'utf8')

  const failures = stages.filter((record) => record.status !== 'complete')
  const markdown = `# FSBP 协议消融实验报告：${args.run}

> 本报告由保存的原始运行记录自动生成。分数来自独立裁判模型，不等同于专家人工盲评。

## 运行完整性

- 样本：${manifest.sampleCount}
- 压力样本：${manifest.stressSampleCount}
- 样本哈希：\`${manifest.samplesHash}\`
- 配置哈希：\`${manifest.configHash}\`
- 已完成裁判次序评估：${judgments.length}

## 主要结果

| 协议 | 阶段完成率 | 格式成功率 | 重试 | 诗行结构满足率 | 样本级胜率（Wilson 95% CI） | 平均排名 | 忠实 | 自然 | 文体 | 结构 | 连贯 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${rows.map((row) => `| ${row.protocol} | ${(row.stage_completion_rate * 100).toFixed(1)}% | ${(row.format_success_rate * 100).toFixed(1)}% | ${row.retries} | ${(row.hard_constraint_satisfaction * 100).toFixed(1)}% (${row.hard_constraint_passes}/${row.hard_constraint_count}) | ${(row.win_rate * 100).toFixed(1)}% (${(row.wilson_low * 100).toFixed(1)}–${(row.wilson_high * 100).toFixed(1)}%) | ${row.mean_rank.toFixed(2)} | ${row.score_faithfulness.toFixed(2)} | ${row.score_naturalness.toFixed(2)} | ${row.score_style.toFixed(2)} | ${row.score_structure.toFixed(2)} | ${row.score_coherence.toFixed(2)} |`).join('\n')}

## 压力样本与顺序复评

- 两次顺序评估聚合后，共有 ${decidedSampleRankings.length} 个样本得到唯一首选，${sampleRankingSummaries.length - decidedSampleRankings.length} 个样本并列；主表的胜率和 Wilson 区间以唯一首选样本为单位。
- 误导性注释压力样本的样本级首选：${PROTOCOLS.map((protocol) => `${protocol}=${stressWins[protocol]}`).join('，')}，并列=${stressTies}（共 ${stressSummaries.length} 个压力样本）。
- 正序与逆序复评的首选一致率：${doubleJudged.length === 0 ? '0.0' : ((stableTopChoices / doubleJudged.length) * 100).toFixed(1)}%（${stableTopChoices}/${doubleJudged.length} 个样本）。
- 诗行结构满足率只检查多行诗歌样本的非空行数是否保持一致，是最低限度的确定性结构证据，不代表韵律或文学质量。

## 成对符号检验

| 协议 A | 协议 B | A 胜 | B 胜 | 并列 | 双侧 p 值 |
|---|---|---:|---:|---:|---:|
${pairs.map((pair) => `| ${pair.a} | ${pair.b} | ${pair.aWins} | ${pair.bWins} | ${pair.ties} | ${pair.p.toFixed(4)} |`).join('\n')}

## 失败案例

${failures.length === 0 ? '本次记录中没有阶段失败。' : failures.map((failure) => `- ${failure.sampleId} / ${failure.protocol} / ${failure.stage}: ${failure.error}`).join('\n')}

## 解释边界

- Wilson 区间以每个原文样本聚合两次交换顺序后的唯一首选为观测；并列样本不进入胜率分母。
- 成对符号检验先在每个样本内聚合两次排序，再以两个协议的相对先后为观测并排除并列；它不证明因果。
- 自动裁判可能存在模型偏好、位置偏差和自洽偏差；交换顺序只能部分缓解。
- 应结合 \`raw.jsonl\` 的失败案例和后续专家盲评解释结果。
`

  const reportsDir = path.join(root, 'experiments', 'reports')
  await mkdir(reportsDir, { recursive: true })
  const markdownPath = path.join(reportsDir, `${args.run}.md`)
  const htmlPath = path.join(reportsDir, `${args.run}.html`)
  await writeFile(markdownPath, markdown, 'utf8')
  const tableRows = rows
    .map(
      (row) => `<tr><td>${htmlEscape(row.protocol)}</td><td>${(
        row.stage_completion_rate * 100
      ).toFixed(1)}%</td><td>${(row.format_success_rate * 100).toFixed(
        1,
      )}%</td><td>${(row.hard_constraint_satisfaction * 100).toFixed(
        1,
      )}%</td><td>${(row.win_rate * 100).toFixed(1)}%</td><td>${row.mean_rank.toFixed(
        2,
      )}</td></tr>`,
    )
    .join('')
  await writeFile(
    htmlPath,
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>FSBP ${htmlEscape(args.run)}</title><style>body{font-family:system-ui,sans-serif;max-width:960px;margin:40px auto;padding:0 20px;color:#25221d;background:#f7f1e4}table{border-collapse:collapse;width:100%;background:#fffaf0}th,td{border:1px solid #c9bfad;padding:10px;text-align:left}pre{white-space:pre-wrap;background:#fffaf0;border:1px solid #c9bfad;padding:18px}</style></head><body><h1>FSBP 协议实验</h1><p>运行：${htmlEscape(args.run)}</p><table><thead><tr><th>协议</th><th>完成率</th><th>格式成功率</th><th>结构满足率</th><th>胜率</th><th>平均排名</th></tr></thead><tbody>${tableRows}</tbody></table><h2>完整报告</h2><pre>${htmlEscape(markdown)}</pre></body></html>`,
    'utf8',
  )
  process.stdout.write(
    `Report written:\n${markdownPath}\n${htmlPath}\n${path.join(runDir, 'metrics.csv')}\n`,
  )
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`)
  process.exitCode = 1
})
