import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {
  ISOLATION_OUTCOMES,
  QUALITY_DIMENSIONS,
  ROUND_ID,
  assertPacketHash,
  assertPathInside,
  deepRound,
  hashJson,
  krippendorffAlphaOrdinal,
  mean,
  median,
  pairedBootstrap,
  parseArgs,
  quantile,
  readJson,
  readJsonl,
  sampleStandardDeviation,
  sha256,
  wilsonInterval,
  writeJsonAtomic,
} from './round-0820-lib.mjs'

const FORMAL_REVIEWER_IDS = ['reviewer-A', 'reviewer-B', 'reviewer-C']
const FORMAL_QUALITY_ITEM_COUNT = 24

function usage() {
  return [
    'Usage: node scripts/analyze-round-0820.mjs [--run-dir <private-run-directory>]',
    '  [--blind-dir <private-blind-directory>] [--human-dir <private-human-directory>]',
    '  [--sealed-dir <private-sealed-key-directory>]',
    '  [--output <private-analysis.json>] [--bootstrap <iterations>]',
    '  [--private-root <FSBP_Test/private/round-0820>]',
    '  [--allow-nonformal]  # development fixtures only',
    '',
    'When validated frozen human files are missing, this command emits an explicit automatic_only report and does not read the blind key.',
  ].join('\n')
}

function unsignedValidation(validation) {
  const { validationManifestHash: _ignored, ...unsigned } = validation
  return unsigned
}

function rate(successes, total) {
  return {
    numerator: successes,
    denominator: total,
    proportion: total ? successes / total : null,
    ci95: wilsonInterval(successes, total),
  }
}

function summarizeNumbers(values) {
  return {
    count: values.length,
    total: values.length ? values.reduce((sum, value) => sum + value, 0) : 0,
    mean: mean(values),
    median: median(values),
    p95: quantile(values, 0.95),
  }
}

function usageNumber(record, candidates) {
  for (const key of candidates) {
    const value = record?.usage?.[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function engineeringAnalysis(events, finals) {
  const completeCalls = events.filter((record) => record.status === 'complete')
  const failedAttempts = events.filter((record) => record.status !== 'complete')
  const retries = events.filter((record) => Number(record.attempt) > 1)
  const boundaryFound = completeCalls.filter((record) => record.boundaryFound).length
  const multipleBoundaries = completeCalls.filter((record) => record.boundaryCount > 1).length
  const emptyBodies = completeCalls.filter((record) => !String(record.body ?? '').trim()).length
  const truncated = events.filter((record) => record.truncated).length
  const inputTokens = events
    .map((record) => usageNumber(record, ['prompt_tokens', 'input_tokens']))
    .filter((value) => value !== null)
  const outputTokens = events
    .map((record) => usageNumber(record, ['completion_tokens', 'output_tokens']))
    .filter((value) => value !== null)
  const latency = events
    .map((record) => record.latencyMs)
    .filter((value) => typeof value === 'number')
  const failuresByCode = {}
  for (const record of failedAttempts) {
    const code = record.errorCode ?? 'unknown_failure'
    failuresByCode[code] = (failuresByCode[code] ?? 0) + 1
  }
  const attemptedStatuses = {
    complete: finals.filter((record) => record.status === 'complete').length,
    failed: finals.filter((record) => (
      record.status === 'failed' && record.errorCode !== 'PRECHECK_FAILED'
    )).length,
    precheckFailed: finals.filter((record) => (
      record.status === 'precheck_failed' || record.errorCode === 'PRECHECK_FAILED'
    )).length,
    cancelled: finals.filter((record) => record.status === 'cancelled').length,
    incompleteOutput: finals.filter((record) => record.status === 'incomplete_output').length,
  }
  const conditionMetrics = {}
  for (const condition of ['direct', 'multi_raw', 'multi_fsbp']) {
    const selected = completeCalls.filter((record) => record.condition === condition)
    const attempted = events.filter((record) => record.condition === condition)
    conditionMetrics[condition] = {
      attemptedCalls: attempted.length,
      completeCalls: selected.length,
      boundaryRate: rate(selected.filter((record) => record.boundaryFound).length, selected.length),
      truncationRate: rate(attempted.filter((record) => record.truncated).length, attempted.length),
      latencyMs: summarizeNumbers(
        selected.map((record) => record.latencyMs).filter((value) => typeof value === 'number'),
      ),
      inputTokens: summarizeNumbers(
        selected
          .map((record) => usageNumber(record, ['prompt_tokens', 'input_tokens']))
          .filter((value) => value !== null),
      ),
      outputTokens: summarizeNumbers(
        selected
          .map((record) => usageNumber(record, ['completion_tokens', 'output_tokens']))
          .filter((value) => value !== null),
      ),
    }
  }
  let paired = 0
  let invalidPairs = 0
  const multiByPair = new Map()
  for (const record of finals.filter((entry) => ['multi_raw', 'multi_fsbp'].includes(entry.condition))) {
    const key = `${record.datasetName}:${record.sampleId}`
    const group = multiByPair.get(key) ?? []
    group.push(record)
    multiByPair.set(key, group)
  }
  for (const group of multiByPair.values()) {
    const raw = group.find((record) => record.condition === 'multi_raw')
    const fsbp = group.find((record) => record.condition === 'multi_fsbp')
    if (
      raw && fsbp &&
      raw.candidateSetHash && raw.candidateSetHash === fsbp.candidateSetHash &&
      raw.pairId && raw.pairId === fsbp.pairId &&
      raw.comparisonControlHash && raw.comparisonControlHash === fsbp.comparisonControlHash
    ) paired += 1
    else invalidPairs += 1
  }
  return {
    attempts: {
      total: events.length,
      complete: completeCalls.length,
      failed: failedAttempts.length,
      retryAttempts: retries.length,
      failureRate: rate(failedAttempts.length, events.length),
      retryRate: rate(retries.length, events.length),
      failuresByCode,
    },
    protocol: {
      boundaryFound: rate(boundaryFound, completeCalls.length),
      multipleBoundaries: rate(multipleBoundaries, completeCalls.length),
      emptyBody: rate(emptyBodies, completeCalls.length),
      truncation: rate(truncated, events.length),
    },
    resources: {
      inputTokens: summarizeNumbers(inputTokens),
      outputTokens: summarizeNumbers(outputTokens),
      latencyMs: summarizeNumbers(latency),
    },
    conditions: conditionMetrics,
    outcomes: {
      total: finals.length,
      attemptedDenominator: finals.length,
      attemptedStatuses,
      complete: finals.filter((record) => record.status === 'complete').length,
      failed: finals.filter((record) => record.status !== 'complete').length,
      failureRate: rate(
        finals.filter((record) => record.status !== 'complete').length,
        finals.length,
      ),
    },
    pairingAudit: {
      exactPairs: paired,
      invalidOrIncompletePairs: invalidPairs,
      valid: invalidPairs === 0,
    },
  }
}

function combination(n, k) {
  const size = Math.min(k, n - k)
  let result = 1
  for (let index = 1; index <= size; index += 1) {
    result = (result * (n - size + index)) / index
  }
  return result
}

function exactBinomialTwoSided(successes, total) {
  if (!total) return null
  const observed = combination(total, successes) / (2 ** total)
  let probability = 0
  for (let count = 0; count <= total; count += 1) {
    const current = combination(total, count) / (2 ** total)
    if (current <= observed + 1e-15) probability += current
  }
  return Math.min(1, probability)
}

function normalCdf(value) {
  const sign = value < 0 ? -1 : 1
  const x = Math.abs(value) / Math.sqrt(2)
  const t = 1 / (1 + 0.3275911 * x)
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const erf = sign * (1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x))
  return 0.5 * (1 + erf)
}

function signedRanks(differences) {
  const values = differences
    .filter((difference) => difference !== 0)
    .map((difference) => ({ difference, absolute: Math.abs(difference), rank: 0 }))
    .sort((left, right) => left.absolute - right.absolute)
  for (let index = 0; index < values.length;) {
    let end = index + 1
    while (end < values.length && values[end].absolute === values[index].absolute) end += 1
    const averageRank = ((index + 1) + end) / 2
    for (let cursor = index; cursor < end; cursor += 1) values[cursor].rank = averageRank
    index = end
  }
  return values
}

function wilcoxonSignedRank(differences) {
  const ranked = signedRanks(differences)
  if (!ranked.length) {
    return { n: 0, positiveRank: 0, negativeRank: 0, pValue: 1, method: 'all_ties', rankBiserial: 0 }
  }
  const positiveRank = ranked
    .filter((entry) => entry.difference > 0)
    .reduce((sum, entry) => sum + entry.rank, 0)
  const negativeRank = ranked
    .filter((entry) => entry.difference < 0)
    .reduce((sum, entry) => sum + entry.rank, 0)
  const totalRank = positiveRank + negativeRank
  let pValue
  let method
  if (ranked.length <= 16) {
    const observedDistance = Math.abs(positiveRank - totalRank / 2)
    let extreme = 0
    const permutations = 2 ** ranked.length
    for (let mask = 0; mask < permutations; mask += 1) {
      let sum = 0
      for (let index = 0; index < ranked.length; index += 1) {
        if (mask & (1 << index)) sum += ranked[index].rank
      }
      if (Math.abs(sum - totalRank / 2) >= observedDistance - 1e-12) extreme += 1
    }
    pValue = extreme / permutations
    method = 'exact_sign_permutation'
  } else {
    const variance = ranked.reduce((sum, entry) => sum + entry.rank ** 2, 0) / 4
    const z = (Math.abs(positiveRank - totalRank / 2) - 0.5) / Math.sqrt(variance)
    pValue = Math.min(1, 2 * (1 - normalCdf(Math.max(0, z))))
    method = 'normal_approximation_with_continuity_correction'
  }
  return {
    n: ranked.length,
    positiveRank,
    negativeRank,
    pValue,
    method,
    rankBiserial: totalRank ? (positiveRank - negativeRank) / totalRank : 0,
  }
}

function mcnemarExact(leftBad, rightBad) {
  let leftOnly = 0
  let rightOnly = 0
  for (let index = 0; index < leftBad.length; index += 1) {
    if (leftBad[index] && !rightBad[index]) leftOnly += 1
    if (!leftBad[index] && rightBad[index]) rightOnly += 1
  }
  const discordant = leftOnly + rightOnly
  if (!discordant) return { leftOnly, rightOnly, discordant, pValue: 1 }
  const tail = Math.min(leftOnly, rightOnly)
  let cumulative = 0
  for (let count = 0; count <= tail; count += 1) {
    cumulative += combination(discordant, count) / (2 ** discordant)
  }
  return { leftOnly, rightOnly, discordant, pValue: Math.min(1, 2 * cumulative) }
}

function holm(entries) {
  const valid = entries
    .filter((entry) => typeof entry.pValue === 'number')
    .sort((left, right) => left.pValue - right.pValue)
  let prior = 0
  for (const [index, entry] of valid.entries()) {
    const adjusted = Math.min(1, Math.max(prior, entry.pValue * (valid.length - index)))
    entry.adjustedPValue = adjusted
    prior = adjusted
  }
}

function averageRankForLabel(ranking, label) {
  let position = 1
  for (const group of ranking) {
    const averageRank = (position + (position + group.length - 1)) / 2
    if (group.includes(label)) return averageRank
    position += group.length
  }
  throw new Error(`Ranking omits ${label}.`)
}

function kendallWForItem(records, labels) {
  const judges = records.length
  const subjects = labels.length
  if (judges < 2 || subjects < 2) return null
  const rankSums = Object.fromEntries(labels.map((label) => [label, 0]))
  let tieCorrection = 0
  for (const record of records) {
    for (const label of labels) rankSums[label] += averageRankForLabel(record.ranking, label)
    for (const group of record.ranking) tieCorrection += group.length ** 3 - group.length
  }
  const average = judges * (subjects + 1) / 2
  const sumSquares = labels.reduce(
    (sum, label) => sum + (rankSums[label] - average) ** 2,
    0,
  )
  const denominator = judges ** 2 * (subjects ** 3 - subjects) - judges * tieCorrection
  return denominator ? (12 * sumSquares) / denominator : null
}

function weightedQualityTotal(scores, weights) {
  let weighted = 0
  let applicableWeight = 0
  for (const dimension of QUALITY_DIMENSIONS) {
    const score = scores[dimension]
    const weight = weights[dimension]
    if (score === null || score === undefined) continue
    if (typeof weight !== 'number' || weight <= 0) {
      throw new Error(`Quality rubric has no positive weight for ${dimension}.`)
    }
    weighted += score * weight
    applicableWeight += weight
  }
  return applicableWeight ? 10 * weighted / applicableWeight : null
}

function pairedScoreResult(differences, { seed, iterations, namespace }) {
  const standardDeviation = sampleStandardDeviation(differences)
  const wilcoxon = wilcoxonSignedRank(differences)
  return {
    pairedItems: differences.length,
    meanDifference: mean(differences),
    medianDifference: median(differences),
    standardizedEffectDz: standardDeviation ? mean(differences) / standardDeviation : null,
    rankBiserialEffect: wilcoxon.rankBiserial,
    bootstrapMeanDifference: pairedBootstrap(differences, {
      seed: `${seed}:${namespace}:mean`,
      iterations,
      statistic: mean,
    }),
    bootstrapMedianDifference: pairedBootstrap(differences, {
      seed: `${seed}:${namespace}:median`,
      iterations,
      statistic: median,
    }),
    wilcoxon,
  }
}

function stratifiedQualityEffects(itemEffects, field) {
  const groups = new Map()
  for (const item of itemEffects) {
    const value = String(item[field] ?? 'uncategorized')
    const group = groups.get(value) ?? []
    group.push(item)
    groups.set(value, group)
  }
  return Object.fromEntries([...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, items]) => {
      const wins = items.filter((item) => item.difference > 0).length
      const ties = items.filter((item) => item.difference === 0).length
      const losses = items.length - wins - ties
      return [name, {
        itemCount: items.length,
        meanWeightedTotalDifference: mean(items.map((item) => item.difference)),
        medianWeightedTotalDifference: median(items.map((item) => item.difference)),
        targetWins: wins,
        ties,
        targetLosses: losses,
        targetWinRate: items.length ? wins / items.length : null,
        tieRate: items.length ? ties / items.length : null,
      }]
    }))
}

function qualityAnalysis(records, packet, key, { seed, iterations }) {
  const mapping = key.mapping
  const decodedAll = []
  for (const record of records) {
    const conditionByLabel = mapping[record.itemId]
    if (!conditionByLabel) throw new Error(`Blind key omits quality item ${record.itemId}.`)
    const conditions = [...new Set(Object.values(conditionByLabel))].sort()
    if (
      conditions.length !== 2 || !conditions.includes('external_gpt_baseline') ||
      !conditions.includes('multi_fsbp')
    ) {
      throw new Error(
        `Quality item ${record.itemId} must decode to exactly external_gpt_baseline and multi_fsbp.`,
      )
    }
    decodedAll.push({ ...record, conditionByLabel })
  }
  const decoded = decodedAll.filter((record) => record.unableToJudge !== true)
  const weights = packet.rubric?.weights
  if (
    !weights || QUALITY_DIMENSIONS.some((dimension) => (
      typeof weights[dimension] !== 'number' || weights[dimension] <= 0
    ))
  ) throw new Error('Quality packet has no complete positive scoring weights.')
  const conditions = ['external_gpt_baseline', 'multi_fsbp']
  const conditionScores = Object.fromEntries(
    conditions.map((condition) => [
      condition,
      Object.fromEntries(QUALITY_DIMENSIONS.map((dimension) => [dimension, []])),
    ]),
  )
  const revision = Object.fromEntries(
    conditions.map((condition) => [condition, []]),
  )
  const severeErrors = Object.fromEntries(
    conditions.map((condition) => [condition, 0]),
  )
  const weightedTotals = Object.fromEntries(conditions.map((condition) => [condition, []]))
  for (const record of decoded) {
    for (const [label, condition] of Object.entries(record.conditionByLabel)) {
      for (const dimension of QUALITY_DIMENSIONS) {
        const score = record.candidateScores[label][dimension]
        if (score !== null) conditionScores[condition][dimension].push(score)
      }
      revision[condition].push(record.revisionNeeded[label])
      weightedTotals[condition].push(weightedQualityTotal(record.candidateScores[label], weights))
    }
    for (const issue of record.severeErrors) {
      severeErrors[record.conditionByLabel[issue.candidate]] += 1
    }
  }
  const summaries = Object.fromEntries(
    Object.entries(conditionScores).map(([condition, dimensions]) => [
      condition,
      {
        dimensions: Object.fromEntries(
          Object.entries(dimensions).map(([dimension, values]) => [
            dimension,
            { count: values.length, mean: mean(values), median: median(values) },
          ]),
        ),
        revisionNeeded: rate(revision[condition].filter(Boolean).length, revision[condition].length),
        severeErrorCount: severeErrors[condition],
        weightedTotal: {
          range: [10, 100],
          count: weightedTotals[condition].length,
          mean: mean(weightedTotals[condition]),
          median: median(weightedTotals[condition]),
        },
      },
    ]),
  )

  const comparator = 'external_gpt_baseline'
  const target = 'multi_fsbp'
  const comparison = {
    comparator,
    target,
    inferentialUnit: 'item',
    effectDirection: 'target_minus_comparator',
    dimensions: {},
    weightedTotal: null,
    ranking: { targetWins: 0, ties: 0, targetLosses: 0 },
  }
  const itemMean = (item, condition, selector) => {
    const values = []
    for (const record of decoded.filter((entry) => entry.itemId === item.itemId)) {
      const label = Object.keys(record.conditionByLabel)
        .find((candidate) => record.conditionByLabel[candidate] === condition)
      const value = selector(record, label)
      if (value !== null && value !== undefined) values.push(value)
    }
    return values.length ? mean(values) : null
  }
  const pEntries = []
  for (const dimension of QUALITY_DIMENSIONS) {
    const differences = packet.items.flatMap((item) => {
      const comparatorScore = itemMean(
        item,
        comparator,
        (record, label) => record.candidateScores[label][dimension],
      )
      const targetScore = itemMean(
        item,
        target,
        (record, label) => record.candidateScores[label][dimension],
      )
      return comparatorScore === null || targetScore === null
        ? []
        : [targetScore - comparatorScore]
    })
    const result = pairedScoreResult(differences, {
      seed,
      iterations,
      namespace: `quality:${comparator}:${dimension}`,
    })
    comparison.dimensions[dimension] = result
    pEntries.push({ dimension, pValue: result.wilcoxon.pValue, result })
  }
  holm(pEntries)
  for (const entry of pEntries) entry.result.holmAdjustedPValue = entry.adjustedPValue

  const itemEffects = []
  for (const item of packet.items) {
    const comparatorTotal = itemMean(
      item,
      comparator,
      (record, label) => weightedQualityTotal(record.candidateScores[label], weights),
    )
    const targetTotal = itemMean(
      item,
      target,
      (record, label) => weightedQualityTotal(record.candidateScores[label], weights),
    )
    if (comparatorTotal !== null && targetTotal !== null) {
      itemEffects.push({
        itemId: item.itemId,
        direction: item.direction,
        category: item.category,
        comparatorWeightedTotal: comparatorTotal,
        targetWeightedTotal: targetTotal,
        difference: targetTotal - comparatorTotal,
      })
    }
    const itemRecords = decoded.filter((record) => record.itemId === item.itemId)
    if (!itemRecords.length) continue
    const comparatorRank = mean(itemRecords.map((record) => {
      const label = Object.keys(record.conditionByLabel)
        .find((candidate) => record.conditionByLabel[candidate] === comparator)
      return averageRankForLabel(record.ranking, label)
    }))
    const targetRank = mean(itemRecords.map((record) => {
      const label = Object.keys(record.conditionByLabel)
        .find((candidate) => record.conditionByLabel[candidate] === target)
      return averageRankForLabel(record.ranking, label)
    }))
    if (targetRank < comparatorRank) comparison.ranking.targetWins += 1
    else if (targetRank > comparatorRank) comparison.ranking.targetLosses += 1
    else comparison.ranking.ties += 1
  }
  const weightedDifferences = itemEffects.map((item) => item.difference)
  comparison.weightedTotal = {
    range: [10, 100],
    formula: packet.rubric.weightedTotalFormula,
    ...pairedScoreResult(weightedDifferences, {
      seed,
      iterations,
      namespace: `quality:${comparator}:weighted-total`,
    }),
  }
  const weightedWins = weightedDifferences.filter((difference) => difference > 0).length
  const weightedTies = weightedDifferences.filter((difference) => difference === 0).length
  const weightedLosses = weightedDifferences.length - weightedWins - weightedTies
  comparison.weightedOutcome = {
    targetWins: weightedWins,
    ties: weightedTies,
    targetLosses: weightedLosses,
    targetWinRate: weightedDifferences.length ? weightedWins / weightedDifferences.length : null,
    tieRate: weightedDifferences.length ? weightedTies / weightedDifferences.length : null,
    targetLossRate: weightedDifferences.length ? weightedLosses / weightedDifferences.length : null,
    exactBinomialPValueExcludingTies: exactBinomialTwoSided(
      weightedWins,
      weightedWins + weightedLosses,
    ),
  }
  const nonTies = comparison.ranking.targetWins + comparison.ranking.targetLosses
  comparison.ranking.exactBinomialPValue = exactBinomialTwoSided(
    comparison.ranking.targetWins,
    nonTies,
  )

  const alpha = {}
  for (const dimension of QUALITY_DIMENSIONS) {
    const units = []
    for (const item of packet.items) {
      for (const label of item.candidates.map((candidate) => candidate.label)) {
        const ratings = decoded
          .filter((record) => record.itemId === item.itemId)
          .map((record) => record.candidateScores[label][dimension])
          .filter((score) => score !== null)
        if (ratings.length) units.push(ratings)
      }
    }
    alpha[dimension] = krippendorffAlphaOrdinal(units)
  }
  const wByItem = packet.items.map((item) => ({
    itemId: item.itemId,
    value: kendallWForItem(
      decoded.filter((record) => record.itemId === item.itemId),
      item.candidates.map((candidate) => candidate.label),
    ),
  }))
  const weightedAlphaUnits = []
  for (const item of packet.items) {
    for (const label of item.candidates.map((candidate) => candidate.label)) {
      const ratings = decoded
        .filter((record) => record.itemId === item.itemId)
        .map((record) => weightedQualityTotal(record.candidateScores[label], weights))
        .filter((score) => score !== null)
      if (ratings.length) weightedAlphaUnits.push(ratings)
    }
  }
  return {
    status: 'complete',
    reviewerIds: [...new Set(decodedAll.map((record) => record.reviewerId))].sort(),
    itemCount: packet.items.length,
    recordCount: decodedAll.length,
    scorableRecordCount: decoded.length,
    unableToJudgeRecordCount: decodedAll.length - decoded.length,
    scoringWeights: weights,
    weightedTotalFormula: packet.rubric.weightedTotalFormula,
    summaries,
    comparisons: [comparison],
    stratifiedWeightedTotal: {
      byDirection: stratifiedQualityEffects(itemEffects, 'direction'),
      byCategory: stratifiedQualityEffects(itemEffects, 'category'),
    },
    agreement: {
      krippendorffAlphaOrdinal: alpha,
      weightedTotalKrippendorffAlphaOrdinal: krippendorffAlphaOrdinal(weightedAlphaUnits),
      kendallWByItem: wByItem,
      kendallWMean: mean(wByItem.map((entry) => entry.value).filter((value) => value !== null)),
      note: 'Kendall W is computed within each item because anonymous candidates are item-specific.',
    },
    decodedEvidenceHash: hashJson(
      decodedAll.map((record) => ({
        reviewerId: record.reviewerId,
        itemId: record.itemId,
        conditionByLabel: record.conditionByLabel,
      })),
    ),
  }
}

function isolationAnalysis(records, packet, key, { seed, iterations }) {
  const mapping = key.mapping
  const decoded = records.map((record) => {
    const conditionByLabel = mapping[record.itemId]
    if (!conditionByLabel) throw new Error(`Blind key omits isolation item ${record.itemId}.`)
    return { ...record, conditionByLabel }
  })
  const confirmed = decoded.filter((record) => record.targetedErrorConfirmed)
  const summaries = {}
  for (const condition of ['multi_raw', 'multi_fsbp']) {
    const outcomes = []
    for (const record of confirmed) {
      const label = Object.keys(record.conditionByLabel)
        .find((candidate) => record.conditionByLabel[candidate] === condition)
      outcomes.push(record.outcomes[label])
    }
    const counts = Object.fromEntries(
      ISOLATION_OUTCOMES.map((outcome) => [
        outcome,
        outcomes.filter((value) => value === outcome).length,
      ]),
    )
    const clearTotal = outcomes.length - counts.unclear
    summaries[condition] = {
      counts,
      clearDenominator: clearTotal,
      retainedOrAmplified: rate(counts.retained + counts.amplified, clearTotal),
      corrected: rate(counts.corrected, clearTotal),
      unclearReported: counts.unclear,
    }
  }
  const bad = (outcome) => ['retained', 'amplified'].includes(outcome)
  const pairedItems = []
  for (const item of packet.items) {
    const recordsForItem = confirmed.filter((record) => record.itemId === item.itemId)
    const outcomesByCondition = { multi_raw: [], multi_fsbp: [] }
    for (const record of recordsForItem) {
      for (const [label, condition] of Object.entries(record.conditionByLabel)) {
        const outcome = record.outcomes[label]
        if (outcome !== 'unclear') outcomesByCondition[condition].push(outcome)
      }
    }
    if (!outcomesByCondition.multi_raw.length || !outcomesByCondition.multi_fsbp.length) continue
    const rawBadRate = mean(outcomesByCondition.multi_raw.map((outcome) => Number(bad(outcome))))
    const fsbpBadRate = mean(outcomesByCondition.multi_fsbp.map((outcome) => Number(bad(outcome))))
    const rawCorrectionRate = mean(
      outcomesByCondition.multi_raw.map((outcome) => Number(outcome === 'corrected')),
    )
    const fsbpCorrectionRate = mean(
      outcomesByCondition.multi_fsbp.map((outcome) => Number(outcome === 'corrected')),
    )
    pairedItems.push({
      itemId: item.itemId,
      rawBadRate,
      fsbpBadRate,
      rawCorrectionRate,
      fsbpCorrectionRate,
    })
  }
  const rawBad = pairedItems.map((item) => item.rawBadRate >= 0.5)
  const fsbpBad = pairedItems.map((item) => item.fsbpBadRate >= 0.5)
  const badDifferences = pairedItems.map(
    (item) => item.fsbpBadRate - item.rawBadRate,
  )
  const correctionDifferences = pairedItems.map(
    (item) => item.fsbpCorrectionRate - item.rawCorrectionRate,
  )
  return {
    status: 'complete',
    reviewerIds: [...new Set(decoded.map((record) => record.reviewerId))].sort(),
    itemCount: packet.items.length,
    recordCount: decoded.length,
    confirmedRecordCount: confirmed.length,
    unconfirmedRecordCount: decoded.length - confirmed.length,
    summaries,
    pairedAnalysis: {
      unit: 'item_cluster',
      clearPairs: pairedItems.length,
      reviewerRatingsAreClusteredWithinItem: true,
      errorRetentionRiskDifference: {
        direction: 'multi_fsbp_minus_multi_raw',
        ...pairedBootstrap(badDifferences, {
          seed: `${seed}:isolation:bad-risk`,
          iterations,
          statistic: mean,
        }),
        mcnemar: mcnemarExact(rawBad, fsbpBad),
        mcnemarAggregation: 'item-level majority; exact 0.5 is classified as retained-or-amplified',
      },
      correctionRiskDifference: {
        direction: 'multi_fsbp_minus_multi_raw',
        ...pairedBootstrap(correctionDifferences, {
          seed: `${seed}:isolation:correction-risk`,
          iterations,
          statistic: mean,
        }),
      },
    },
    decodedEvidenceHash: hashJson(
      decoded.map((record) => ({
        reviewerId: record.reviewerId,
        itemId: record.itemId,
        conditionByLabel: record.conditionByLabel,
      })),
    ),
  }
}

async function validationState({ kind, packet, packetPath, humanDir, allowNonformal }) {
  const validationPath = path.join(humanDir, `${kind}-human-validation.json`)
  const validation = await readJson(validationPath).catch((error) => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
  if (!validation) return { status: 'missing_validation', validationPath }
  if (
    validation.validationManifestHash !== hashJson(unsignedValidation(validation)) ||
    validation.namespace !== 'fsbp' ||
    !validation.valid || validation.kind !== kind ||
    validation.packetId !== packet.packetId ||
    validation.packetHash !== packet.packetHash
  ) {
    throw new Error(`${kind}: validation manifest identity or hash is invalid.`)
  }
  const packetBytes = await readFile(packetPath)
  if (sha256(packetBytes) !== validation.packetFileSha256) {
    throw new Error(`${kind}: packet bytes changed after human validation.`)
  }
  const frozenPath = path.join(humanDir, validation.frozenHumanFile)
  const frozenBytes = await readFile(frozenPath)
  if (
    sha256(frozenBytes) !== validation.frozenHumanFileSha256 ||
    validation.humanInputSha256 !== validation.frozenHumanFileSha256
  ) {
    throw new Error(`${kind}: frozen human score hash mismatch.`)
  }
  if (![
    'package_credential_verified_process_attested',
    'legacy_unbound_process_attested',
  ].includes(validation.bindingStatus)) {
    throw new Error(
      `${kind}: validation predates return-binding status; revalidate the original returns ` +
      'with credentials or explicit --allow-legacy-unbound.',
    )
  }
  if (!allowNonformal) {
    if (validation.bindingStatus !== 'package_credential_verified_process_attested') {
      throw new Error(
        `${kind}: formal analysis requires verified A/B/C package credentials.`,
      )
    }
  }
  const reviewerIds = Array.isArray(validation.reviewerIds)
    ? [...validation.reviewerIds].sort()
    : []
  const expectedReviewers = [...FORMAL_REVIEWER_IDS].sort()
  if (
    validation.reviewerCount !== FORMAL_REVIEWER_IDS.length ||
    reviewerIds.join(',') !== expectedReviewers.join(',')
  ) {
    throw new Error(`${kind}: analysis requires exactly ${FORMAL_REVIEWER_IDS.join(', ')}.`)
  }
  const expectedItemCount = packet.items.length
  if (
    (!allowNonformal && kind === 'quality' && expectedItemCount !== FORMAL_QUALITY_ITEM_COUNT) ||
    validation.itemCount !== expectedItemCount ||
    validation.recordCount !== FORMAL_REVIEWER_IDS.length * expectedItemCount
  ) {
    throw new Error(
      `${kind}: analysis requires all three reviewers to complete ` +
      `${expectedItemCount} packet items each.`,
    )
  }
  const frozenRecords = await readJsonl(frozenPath)
  const itemIds = new Set(packet.items.map((item) => item.itemId))
  const coverage = new Set()
  for (const record of frozenRecords) {
    if (
      record.packetId !== packet.packetId || record.packetHash !== packet.packetHash ||
      record.kind !== kind || record.reviewerType !== 'human' ||
      !expectedReviewers.includes(record.reviewerId) || !itemIds.has(record.itemId)
    ) {
      throw new Error(`${kind}: frozen human records contain an unexpected reviewer or item.`)
    }
    const coverageKey = `${record.reviewerId}\u0000${record.itemId}`
    if (coverage.has(coverageKey)) {
      throw new Error(`${kind}: frozen human records contain duplicate reviewer/item coverage.`)
    }
    coverage.add(coverageKey)
  }
  if (coverage.size !== FORMAL_REVIEWER_IDS.length * expectedItemCount) {
    throw new Error(`${kind}: frozen human records do not contain complete A/B/C coverage.`)
  }
  return {
    status: 'validated_frozen',
    validation,
    frozenPath,
    coverageComplete: true,
    packageCredentialVerified: validation.packageCredentialVerified === true,
  }
}

function markdownReport(analysis) {
  const lines = [
    '# Round 0820 实验统计',
    '',
    `状态：\`${analysis.status}\``,
    '',
    `来源资格：mode=\`${String(analysis.sourceEligibility?.mode)}\`，formalEligible=\`${String(analysis.sourceEligibility?.formalEligible)}\`，clean=\`${String(analysis.sourceEligibility?.clean)}\`，determinism=\`${String(analysis.sourceEligibility?.determinism)}\`。`,
    `结果资格：requestedMode=\`${String(analysis.resultEligibility?.requestedMode)}\`，coverageComplete=\`${String(analysis.resultEligibility?.coverageComplete)}\`，packageCredentialsVerified=\`${String(analysis.resultEligibility?.packageCredentialsVerified)}\`。`,
    `人工回表绑定：quality=\`${String(analysis.humanBinding?.quality ?? 'not_available')}\`。`,
    '',
    `统计输入指纹：\`${analysis.inputFingerprint}\``,
    '',
    '## 工程与协议记录',
    '',
    `模型调用 ${analysis.engineering.attempts.total} 次，成功 ${analysis.engineering.attempts.complete} 次，失败尝试 ${analysis.engineering.attempts.failed} 次。`,
    `最终条件记录 ${analysis.engineering.outcomes.total} 条，其中失败 ${analysis.engineering.outcomes.failed} 条；失败记录均保留。`,
    `严格配对 ${analysis.engineering.pairingAudit.exactPairs} 组，异常或不完整 ${analysis.engineering.pairingAudit.invalidOrIncompletePairs} 组。`,
  ]
  if (!['complete', 'development_complete'].includes(analysis.status)) {
    lines.push(
      '',
      '## 等待人工评分',
      '',
      `缺少：${analysis.missingHuman.join('、') || '无'}。`,
      '盲键尚未读取，质量胜负与注释隔离结论保持未解码状态。',
    )
    return `${lines.join('\n')}\n`
  }
  lines.push('', '## 译文质量', '')
  for (const comparison of analysis.quality.comparisons) {
    const overall = comparison.dimensions.overall_quality
    lines.push(
      `- Agentic 对独立直译：10–100 加权总分均值差 ${comparison.weightedTotal.meanDifference}，95% bootstrap CI [${comparison.weightedTotal.bootstrapMeanDifference.ci95.join(', ')}]；加权胜/平/负 ${comparison.weightedOutcome.targetWins}/${comparison.weightedOutcome.ties}/${comparison.weightedOutcome.targetLosses}。`,
      `- 六维中的总体质量单项均值差 ${overall.meanDifference}，95% bootstrap CI [${overall.bootstrapMeanDifference.ci95.join(', ')}]，rank-biserial ${overall.rankBiserialEffect}。`,
    )
  }
  if (analysis.isolation.status === 'complete') {
    lines.push(
      '',
      '## 注释隔离',
      '',
      `有效清晰配对 ${analysis.isolation.pairedAnalysis.clearPairs}；错误保留/放大风险差（multi_fsbp - multi_raw）${analysis.isolation.pairedAnalysis.errorRetentionRiskDifference.estimate}，95% CI [${analysis.isolation.pairedAnalysis.errorRetentionRiskDifference.ci95.join(', ')}]。`,
      '',
      '统计同时保留反向结果、unclear 与未确认记录；结论边界应结合样本量和区间宽度表述。',
    )
  } else {
    lines.push(
      '',
      '## 注释隔离',
      '',
      '本次人工任务只收集译文质量评分，注释隔离未进入人工统计。',
    )
  }
  return `${lines.join('\n')}\n`
}

async function writeTextAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.tmp`
  await writeFile(temporary, value, 'utf8')
  await rename(temporary, filePath)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const allowNonformal = args['allow-nonformal'] === true
  const privateRoot = path.resolve(
    args['private-root'] ?? path.join(process.cwd(), 'FSBP_Test', 'private', ROUND_ID),
  )
  let runDir
  if (args['run-dir']) {
    runDir = path.resolve(args['run-dir'])
  } else {
    const freeze = await readJson(path.join(privateRoot, 'freeze-manifest.json'))
    const defaultRunId = `${ROUND_ID}-${freeze.freezeManifestSha256.slice(0, 12)}`
    runDir = path.join(privateRoot, 'runs', args['run-id'] ?? defaultRunId)
  }
  const provisionalRunManifest = await readJson(path.join(runDir, 'run-manifest.json'))
  const blindDir = path.resolve(
    args['blind-dir'] ?? path.join(privateRoot, 'blind', provisionalRunManifest.runId),
  )
  const humanDir = path.resolve(
    args['human-dir'] ?? path.join(privateRoot, 'human', provisionalRunManifest.runId),
  )
  const sealedDir = path.resolve(
    args['sealed-dir'] ?? path.join(privateRoot, 'sealed', provisionalRunManifest.runId),
  )
  assertPathInside(privateRoot, sealedDir, 'sealed blind-key input')
  const iterations = Number(args.bootstrap ?? 5000)
  if (!Number.isInteger(iterations) || iterations < 100 || iterations > 100_000) {
    throw new Error('--bootstrap must be an integer from 100 through 100000.')
  }

  const [runManifest, blindManifest, events, finals, qualityPacket, isolationPacket] = await Promise.all([
    readJson(path.join(runDir, 'run-manifest.json')),
    readJson(path.join(blindDir, 'blind-manifest.json')),
    readJsonl(path.join(runDir, 'events.jsonl'), { allowMissing: true }),
    readJsonl(path.join(runDir, 'final.jsonl')),
    readJson(path.join(blindDir, 'quality-packet.json')),
    readJson(path.join(blindDir, 'isolation-packet.json')),
  ])
  if (typeof runManifest.freezeManifest !== 'string' || !runManifest.freezeManifest) {
    throw new Error('Run manifest does not identify its frozen source manifest.')
  }
  const freezeManifestPath = path.resolve(runDir, runManifest.freezeManifest)
  assertPathInside(privateRoot, freezeManifestPath, 'freeze manifest input')
  const freezeManifest = await readJson(freezeManifestPath)
  if (
    freezeManifest.roundId !== ROUND_ID || freezeManifest.namespace !== 'fsbp' ||
    freezeManifest.freezeManifestSha256 !== runManifest.freezeManifestSha256
  ) {
    throw new Error('Run and freeze manifests do not describe the same frozen source.')
  }
  const sourceEligibility = {
    mode: freezeManifest.mode ?? runManifest.freezeMode ?? null,
    formalEligible: runManifest.formalEligible === true && freezeManifest.formalEligible === true,
    clean: freezeManifest.source?.clean === true,
    determinism: freezeManifest.determinism_level ?? runManifest.determinism_level ?? null,
  }
  if (!sourceEligibility.formalEligible && !allowNonformal) {
    throw new Error(
      'This run is not formal-eligible. Re-run with --allow-nonformal to emit a development result.',
    )
  }
  const outputPath = path.resolve(
    args.output ?? path.join(
      process.cwd(),
      'FSBP_Test',
      'private',
      ROUND_ID,
      'reports',
      runManifest.runId,
      'analysis.json',
    ),
  )
  assertPathInside(privateRoot, outputPath, 'analysis output')
  const markdownPath = outputPath.replace(/\.json$/i, '.md')
  if (
    runManifest.roundId !== ROUND_ID || blindManifest.roundId !== ROUND_ID ||
    runManifest.namespace !== 'fsbp' || blindManifest.namespace !== 'fsbp' ||
    runManifest.runId !== blindManifest.runId ||
    runManifest.freezeManifestSha256 !== blindManifest.freezeManifestSha256
  ) {
    throw new Error('Run and blind manifests do not describe the same frozen round.')
  }
  assertPacketHash(qualityPacket, 'quality packet')
  assertPacketHash(isolationPacket, 'isolation packet')
  if (
    qualityPacket.packetHash !== blindManifest.packets?.quality?.packetHash ||
    isolationPacket.packetHash !== blindManifest.packets?.isolation?.packetHash
  ) {
    throw new Error('Blind packet hashes do not match blind-manifest.json.')
  }
  const engineering = engineeringAnalysis(events, finals)
  const packets = { quality: qualityPacket, isolation: isolationPacket }
  const states = {}
  const requiredKinds = []
  for (const kind of ['quality', 'isolation']) {
    if (kind === 'isolation' && !allowNonformal) {
      states[kind] = { status: 'not_requested_for_translation_quality_review' }
    } else if (packets[kind].items.length) {
      requiredKinds.push(kind)
      states[kind] = await validationState({
        kind,
        packet: packets[kind],
        packetPath: path.join(blindDir, `${kind}-packet.json`),
        humanDir,
        allowNonformal,
      })
    } else {
      states[kind] = { status: 'not_applicable_no_eligible_items' }
    }
  }
  const missingHuman = requiredKinds
    .filter((kind) => states[kind].status !== 'validated_frozen')
    .map((kind) => `${kind}-human-validation.json`)
  const completedStates = requiredKinds.map((kind) => states[kind])
  const coverageComplete = completedStates.every((state) => state.coverageComplete === true)
  const packageCredentialsVerified = completedStates.every(
    (state) => state.packageCredentialVerified === true,
  )
  const recognizedBindings = completedStates.every((state) => [
    'package_credential_verified_process_attested',
    'legacy_unbound_process_attested',
  ].includes(state.validation?.bindingStatus))
  const resultEligibility = {
    requestedMode: allowNonformal ? 'development_override' : 'formal',
    sourceFormalEligible: sourceEligibility.formalEligible,
    coverageComplete,
    recognizedBindings,
    packageCredentialsVerified,
    formalOutputEligible: (
      !allowNonformal && sourceEligibility.formalEligible && coverageComplete &&
      packageCredentialsVerified
    ),
    developmentOutputEligible: allowNonformal && coverageComplete && recognizedBindings,
  }
  const common = {
    schemaVersion: '1.0.0',
    roundId: ROUND_ID,
    namespace: 'fsbp',
    runId: runManifest.runId,
    freezeManifestSha256: runManifest.freezeManifestSha256,
    sourceEligibility,
    resultEligibility,
    bootstrap: {
      method: 'paired_nonparametric_percentile',
      confidenceLevel: 0.95,
      iterations,
    },
    engineering,
    humanState: Object.fromEntries(
      Object.entries(states).map(([kind, state]) => [kind, state.status]),
    ),
    humanBinding: Object.fromEntries(
      Object.entries(states).map(([kind, state]) => [
        kind,
        state.validation?.bindingStatus ?? null,
      ]),
    ),
  }
  if (!requiredKinds.length) {
    const analysis = deepRound({
      ...common,
      status: 'no_eligible_items',
      decodePerformed: false,
      missingHuman: [],
      quality: { status: 'not_applicable' },
      isolation: { status: 'not_applicable' },
      inputFingerprint: hashJson({ runManifest, blindManifest }),
    })
    await writeJsonAtomic(outputPath, analysis)
    await writeTextAtomic(markdownPath, markdownReport(analysis))
    process.stdout.write(`${JSON.stringify({
      status: analysis.status,
      decodePerformed: false,
      outputPath,
    }, null, 2)}\n`)
    return
  }
  if (missingHuman.length) {
    const analysis = deepRound({
      ...common,
      status: allowNonformal ? 'development_automatic_only' : 'automatic_only',
      automaticOnly: true,
      decodePerformed: false,
      missingHuman,
      quality: qualityPacket.items.length
        ? { status: 'not_computed_missing_human' }
        : { status: 'not_applicable' },
      isolation: allowNonformal && isolationPacket.items.length
        ? { status: 'not_computed_missing_human' }
        : { status: 'not_computed_no_human_review' },
      interRaterAgreement: { status: 'not_computed_missing_human' },
      inputFingerprint: hashJson({
        runManifest,
        blindManifest,
        finalSha256: sha256(await readFile(path.join(runDir, 'final.jsonl'))),
        eventsSha256: events.length ? sha256(await readFile(path.join(runDir, 'events.jsonl'))) : null,
      }),
    })
    await writeJsonAtomic(outputPath, analysis)
    await writeTextAtomic(markdownPath, markdownReport(analysis))
    process.stdout.write(`${JSON.stringify({
      status: analysis.status,
      decodePerformed: false,
      missingHuman,
      outputPath,
    }, null, 2)}\n`)
    return
  }

  // Deliberately delayed until every required human file has passed validation
  // and byte-for-byte hash freezing above.
  const blindKeyPath = path.join(sealedDir, 'blind-key.json')
  const blindKey = await readJson(blindKeyPath)
  if (hashJson(blindKey) !== blindManifest.blindKeySha256) {
    throw new Error('Blind key hash mismatch after the human validation gate.')
  }
  if (
    typeof blindKey.randomizationSecret !== 'string' ||
    sha256(blindKey.randomizationSecret) !== blindKey.seedSha256 ||
    blindKey.seedSha256 !== blindManifest.randomizationSeedSha256 ||
    blindKey.seedSha256 !== qualityPacket.randomizationSeedSha256 ||
    blindKey.seedSha256 !== isolationPacket.randomizationSeedSha256
  ) {
    throw new Error('Blind randomization secret does not match the published seed hash.')
  }
  const qualityRecords = qualityPacket.items.length
    ? await readJsonl(states.quality.frozenPath)
    : []
  const isolationRecords = states.isolation.status === 'validated_frozen'
    ? await readJsonl(states.isolation.frozenPath)
    : []
  const statisticsSeed = blindKey.seedSha256
  const quality = qualityPacket.items.length
    ? qualityAnalysis(
        qualityRecords,
        qualityPacket,
        blindKey.packets.quality,
        { seed: statisticsSeed, iterations },
      )
    : { status: 'not_applicable' }
  const isolation = states.isolation.status === 'validated_frozen'
    ? isolationAnalysis(
        isolationRecords,
        isolationPacket,
        blindKey.packets.isolation,
        { seed: statisticsSeed, iterations },
      )
    : { status: 'not_computed_no_human_review' }
  const inputHashes = {
    runManifest: hashJson(runManifest),
    freezeManifest: hashJson(freezeManifest),
    blindManifest: hashJson(blindManifest),
    finalSha256: sha256(await readFile(path.join(runDir, 'final.jsonl'))),
    eventsSha256: events.length ? sha256(await readFile(path.join(runDir, 'events.jsonl'))) : null,
    blindKeySha256: blindManifest.blindKeySha256,
    qualityHumanSha256: states.quality.validation?.frozenHumanFileSha256 ?? null,
    isolationHumanSha256: states.isolation.validation?.frozenHumanFileSha256 ?? null,
  }
  if (
    (!allowNonformal && !resultEligibility.formalOutputEligible) ||
    (allowNonformal && !resultEligibility.developmentOutputEligible)
  ) {
    throw new Error('Validated returns do not satisfy the requested analysis eligibility contract.')
  }
  const analysis = deepRound({
    ...common,
    status: allowNonformal ? 'development_complete' : 'complete',
    decodePerformed: true,
    missingHuman: [],
    inputHashes,
    inputFingerprint: hashJson(inputHashes),
    quality,
    isolation,
    interpretationPolicy: {
      primaryEvidence: 'effect_sizes_and_95_percent_confidence_intervals',
      pValues: 'supplementary',
      multipleComparisonCorrection: 'Holm_for_six_quality_dimensions',
      contraryResultsRetained: true,
      unclearIsolationOutcomesReportedAndExcludedFromPrimaryRate: true,
      unconfirmedIsolationRecordsReportedAndExcludedFromFormalDenominator: true,
    },
  })
  await writeJsonAtomic(outputPath, analysis)
  await writeTextAtomic(markdownPath, markdownReport(analysis))
  process.stdout.write(`${JSON.stringify({
    status: analysis.status,
    decodePerformed: true,
    inputFingerprint: analysis.inputFingerprint,
    outputPath,
    markdownPath,
  }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
