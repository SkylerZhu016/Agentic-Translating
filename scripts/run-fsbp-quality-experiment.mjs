import { createHash, randomUUID } from 'node:crypto'
import {
  appendFile,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {
  BUILTIN_AGENT_VARIANTS,
  BUILTIN_DIRECTION_BUNDLES,
} from '../src/lib/prompts/bidirectional.ts'

const ROLE_PLAN = {
  poetry: ['semantic-fidelity', 'voice-register', 'poetry-form'],
  literary: ['semantic-fidelity', 'voice-register', 'literary-prose'],
  cultural_argument: ['semantic-fidelity', 'voice-register', 'dissenting'],
  nonliterary: ['semantic-fidelity', 'terminology', 'long-context'],
}
const STAGES = ['review', 'filter', 'orchestrate', 'assemble']
const CONDITIONS = ['direct', 'multi_raw', 'multi_fsbp']

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--config') result.config = argv[++index]
    else if (token === '--run') result.runId = argv[++index]
    else throw new Error(`Unknown argument: ${token}`)
  }
  if (!result.config) {
    throw new Error(
      'Usage: node --experimental-strip-types scripts/run-fsbp-quality-experiment.mjs --config <config.json> [--run <run-id>]',
    )
  }
  return result
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function safeRunId(value) {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error('Run ID may contain only letters, numbers, dot, dash, and underscore.')
  }
  return value
}

function endpointUrl(endpoint) {
  const base = String(endpoint.baseUrl ?? '').replace(/\/+$/, '')
  const route = `/${String(endpoint.chatCompletionsPath ?? '/v1/chat/completions')
    .replace(/^\/+/, '')}`
  if (!base || base.includes('example.invalid')) {
    throw new Error('Configure a real endpoint baseUrl before running.')
  }
  return `${base}${route}`
}

function parseSemanticOutput(rawInput) {
  const raw = String(rawInput ?? '').replace(/\r\n/g, '\n')
  const lines = raw.split('\n')
  const boundary = lines.findIndex((line) => line.trim() === '---')
  if (boundary < 0) return { raw, body: raw.trim(), annotation: null }
  return {
    raw,
    body: lines.slice(0, boundary).join('\n').trim(),
    annotation: lines.slice(boundary + 1).join('\n').trim() || null,
  }
}

function contentText(message) {
  if (typeof message?.content === 'string') return message.content
  if (Array.isArray(message?.content)) {
    return message.content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
  }
  return ''
}

function validateConfig(config) {
  const models = config.models ?? {}
  const generation = config.generation ?? {}
  if (!models.direct || !models.editor) {
    throw new Error('models.direct and models.editor are required.')
  }
  if (!Array.isArray(models.analysis) || models.analysis.length !== 2) {
    throw new Error('models.analysis must contain exactly two model names.')
  }
  if (!Array.isArray(models.candidates) || models.candidates.length !== 3) {
    throw new Error('models.candidates must contain exactly three model names.')
  }
  if (!config.endpoint?.apiKeyEnv) {
    throw new Error('endpoint.apiKeyEnv is required.')
  }
  if (!Number.isInteger(generation.sampleConcurrency ?? 2)) {
    throw new Error('generation.sampleConcurrency must be an integer.')
  }
}

async function readJsonl(filePath) {
  const text = await readFile(filePath, 'utf8')
  if (!text.trim()) return []
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line)
      } catch (error) {
        throw new Error(`${path.basename(filePath)}:${index + 1}: ${error.message}`)
      }
    })
}

function bundleFor(direction) {
  const bundle = BUILTIN_DIRECTION_BUNDLES.find(
    (item) => item.direction === direction,
  )
  if (!bundle) throw new Error(`Missing direction bundle for ${direction}`)
  return bundle
}

function variantFor(archetypeId, direction) {
  const variant = BUILTIN_AGENT_VARIANTS.find(
    (item) =>
      item.archetypeId === archetypeId && item.direction === direction,
  )
  if (!variant) {
    throw new Error(`Missing ${archetypeId} variant for ${direction}`)
  }
  return variant
}

function sourceContext(sample, extra = '') {
  const context = [
    sample.contextBefore ? `Context before:\n${sample.contextBefore}` : '',
    sample.contextAfter ? `Context after:\n${sample.contextAfter}` : '',
    extra,
  ]
    .filter(Boolean)
    .join('\n\n')
  return { context, source: sample.sourceText, brief: sample.taskBrief }
}

function directMessages(sample, bundle) {
  const english = sample.direction === 'zh_to_en'
  const labels = english
    ? {
        role:
          'Produce one complete direct translation without using candidate translations. Output the translation first; optional notes may follow a standalone "---".',
        brief: 'Task brief',
        source: 'Chinese source',
        context: 'Context',
      }
    : {
        role:
          '直接独立完成一份完整译文，不使用候选译文。先输出译文正文；必要说明可放在独立“---”之后。',
        brief: '任务要求',
        source: '英文原文',
        context: '语境',
      }
  const input = sourceContext(sample)
  return [
    {
      role: 'system',
      content: `${bundle.workerBasePrompt}\n\n${labels.role}`,
    },
    {
      role: 'user',
      content: `${labels.brief}:\n${input.brief}\n\n${
        input.context ? `${labels.context}:\n${input.context}\n\n` : ''
      }${labels.source}:\n${input.source}`,
    },
  ]
}

function analysisMessages(sample, variant) {
  const english = sample.direction === 'zh_to_en'
  const input = sourceContext(sample)
  return [
    { role: 'system', content: variant.rolePrompt },
    {
      role: 'user',
      content: english
        ? `Task brief:\n${input.brief}\n\n${
            input.context ? `${input.context}\n\n` : ''
          }Chinese source:\n${input.source}`
        : `任务要求：\n${input.brief}\n\n${
            input.context ? `${input.context}\n\n` : ''
          }英文原文：\n${input.source}`,
    },
  ]
}

function candidateMessages(sample, bundle, variant, analyses) {
  const english = sample.direction === 'zh_to_en'
  const input = sourceContext(sample)
  const analysisBlock = analyses
    .map((record, index) => `Analysis ${index + 1}:\n${record.raw}`)
    .join('\n\n')
  return [
    {
      role: 'system',
      content: `${bundle.workerBasePrompt}\n\n${variant.rolePrompt}`,
    },
    {
      role: 'user',
      content: english
        ? `Task brief:\n${input.brief}\n\n${
            input.context ? `${input.context}\n\n` : ''
          }Independent pre-translation analyses:\n${analysisBlock}\n\nChinese source:\n${input.source}`
        : `任务要求：\n${input.brief}\n\n${
            input.context ? `${input.context}\n\n` : ''
          }两份独立前置分析：\n${analysisBlock}\n\n英文原文：\n${input.source}`,
    },
  ]
}

function stageSystem(bundle, stage) {
  if (stage === 'review') return bundle.reviewPrompt
  if (stage === 'filter') return bundle.filterPrompt
  if (stage === 'orchestrate') return bundle.orchestratePrompt
  if (stage === 'assemble') return bundle.assemblePrompt
  throw new Error(`Unknown stage: ${stage}`)
}

function inherited(record, condition) {
  return condition === 'multi_raw' ? record.raw : record.body
}

function stageMessages(
  sample,
  bundle,
  stage,
  condition,
  candidates,
  stageRecords,
) {
  const english = sample.direction === 'zh_to_en'
  const candidateText = candidates
    .map(
      (record, index) =>
        `Candidate ${index + 1}:\n${inherited(record, condition)}`,
    )
    .join('\n\n')
  const prior = STAGES.slice(0, STAGES.indexOf(stage))
    .map((name) => {
      const record = stageRecords.get(name)
      return record
        ? `${name.toUpperCase()}:\n${inherited(record, condition)}`
        : ''
    })
    .filter(Boolean)
    .join('\n\n')
  const context = [
    `${english ? 'Task brief' : '任务要求'}:\n${sample.taskBrief}`,
    sample.contextBefore
      ? `${english ? 'Context before' : '前置语境'}:\n${sample.contextBefore}`
      : '',
    `${english ? 'Source' : '原文'}:\n${sample.sourceText}`,
    `${english ? 'Candidate translations' : '候选译文'}:\n${candidateText}`,
    prior,
  ]
    .filter(Boolean)
    .join('\n\n')
  return [
    { role: 'system', content: stageSystem(bundle, stage) },
    { role: 'user', content: context },
  ]
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const configPath = path.resolve(args.config)
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  validateConfig(config)

  const apiKey = process.env[config.endpoint.apiKeyEnv]
  if (!apiKey) {
    throw new Error(
      `Missing API key environment variable: ${config.endpoint.apiKeyEnv}`,
    )
  }

  const datasetPath = path.resolve(config.dataset)
  const samples = await readJsonl(datasetPath)
  if (samples.length !== 16 || samples.some((sample) => sample.split !== 'test')) {
    throw new Error('Quality experiment requires the locked 16-sample test set.')
  }
  const datasetVersion = new Set(
    samples.map((sample) => sample.datasetVersion),
  )
  if (datasetVersion.size !== 1 || !datasetVersion.has('0.1.0')) {
    throw new Error('Quality experiment requires dataset version 0.1.0.')
  }

  const sanitizedConfig = structuredClone(config)
  const configHash = sha256(JSON.stringify(sanitizedConfig))
  const defaultRunId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${configHash.slice(0, 8)}`
  const runId = safeRunId(args.runId ?? defaultRunId)
  const runDir = path.resolve('FSBP_Test', 'results', runId)
  const rawPath = path.join(runDir, 'raw.jsonl')
  const finalPath = path.join(runDir, 'final.jsonl')
  await mkdir(runDir, { recursive: true })

  const previous = await readJsonl(rawPath).catch((error) => {
    if (error?.code === 'ENOENT') return []
    throw error
  })
  const successByTask = new Map(
    previous
      .filter((record) => record.status === 'complete')
      .map((record) => [record.taskKey, record]),
  )
  let appendQueue = Promise.resolve()
  const persist = (record) => {
    appendQueue = appendQueue.then(() =>
      appendFile(rawPath, `${JSON.stringify(record)}\n`, 'utf8'),
    )
    return appendQueue
  }

  const generation = {
    temperature: config.generation?.temperature ?? 0.3,
    maxTokens: config.generation?.maxTokens ?? 8192,
    timeoutMs: config.generation?.timeoutMs ?? 900_000,
    retries: config.generation?.retries ?? 2,
    sampleConcurrency: Math.max(
      1,
      Math.min(4, config.generation?.sampleConcurrency ?? 2),
    ),
  }
  const url = endpointUrl(config.endpoint)

  async function runTask({ taskKey, sampleId, phase, model, messages, meta = {} }) {
    const cached = successByTask.get(taskKey)
    if (cached) return cached

    for (let attempt = 1; attempt <= generation.retries + 1; attempt += 1) {
      const startedAt = new Date().toISOString()
      const started = performance.now()
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: generation.temperature,
            max_tokens: generation.maxTokens,
          }),
          signal: AbortSignal.timeout(generation.timeoutMs),
        })
        const responseText = await response.text()
        let payload
        try {
          payload = JSON.parse(responseText)
        } catch {
          throw new Error(
            `HTTP ${response.status}: provider returned non-JSON content`,
          )
        }
        if (!response.ok) {
          throw new Error(
            `HTTP ${response.status}: ${payload?.error?.message ?? response.statusText}`,
          )
        }
        const raw = contentText(payload?.choices?.[0]?.message)
        if (!raw.trim()) {
          throw new Error('Provider returned empty message content.')
        }
        const semantic = parseSemanticOutput(raw)
        if (!semantic.body) {
          throw new Error('FSBP body is empty.')
        }
        const record = {
          id: randomUUID(),
          taskKey,
          sampleId,
          phase,
          model,
          attempt,
          status: 'complete',
          startedAt,
          completedAt: new Date().toISOString(),
          latencyMs: Math.round(performance.now() - started),
          raw: semantic.raw,
          body: semantic.body,
          annotation: semantic.annotation,
          usage: payload.usage ?? null,
          ...meta,
        }
        await persist(record)
        successByTask.set(taskKey, record)
        return record
      } catch (error) {
        const record = {
          id: randomUUID(),
          taskKey,
          sampleId,
          phase,
          model,
          attempt,
          status: 'failed',
          startedAt,
          completedAt: new Date().toISOString(),
          latencyMs: Math.round(performance.now() - started),
          error: error instanceof Error ? error.message : String(error),
          ...meta,
        }
        await persist(record)
        if (attempt > generation.retries) throw error
        await new Promise((resolve) => setTimeout(resolve, attempt * 3000))
      }
    }
    throw new Error(`Unreachable task state: ${taskKey}`)
  }

  const promptSnapshot = {
    agentVariants: BUILTIN_AGENT_VARIANTS,
    directionBundles: BUILTIN_DIRECTION_BUNDLES,
  }
  const manifest = {
    runId,
    runName: config.runName ?? null,
    createdAt: new Date().toISOString(),
    dataset: path.relative(process.cwd(), datasetPath).replace(/\\/g, '/'),
    datasetVersion: '0.1.0',
    sampleIds: samples.map((sample) => sample.id),
    conditions: CONDITIONS,
    config: sanitizedConfig,
    configHash,
    promptVersions: {
      agent: [...new Set(BUILTIN_AGENT_VARIANTS.map((item) => item.promptVersion))],
      bundles: [...new Set(BUILTIN_DIRECTION_BUNDLES.map((item) => item.version))],
    },
  }
  await writeFile(
    path.join(runDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  )
  await writeFile(
    path.join(runDir, 'prompts.json'),
    `${JSON.stringify(promptSnapshot, null, 2)}\n`,
    'utf8',
  )

  const finals = []
  let nextSample = 0
  async function processSample(sample) {
    const bundle = bundleFor(sample.direction)
    const analystVariant = variantFor('cultural-context', sample.direction)
    const [direct, ...analyses] = await Promise.all([
      runTask({
        taskKey: `${sample.id}:direct`,
        sampleId: sample.id,
        phase: 'direct',
        model: config.models.direct,
        messages: directMessages(sample, bundle),
        meta: { condition: 'direct' },
      }),
      ...config.models.analysis.map((model, index) =>
        runTask({
          taskKey: `${sample.id}:analysis:${index + 1}`,
          sampleId: sample.id,
          phase: 'analysis',
          model,
          messages: analysisMessages(sample, analystVariant),
          meta: { analysisIndex: index + 1 },
        }),
      ),
    ])

    const archetypes = ROLE_PLAN[sample.category]
    if (!archetypes) throw new Error(`No role plan for ${sample.category}`)
    const candidates = await Promise.all(
      archetypes.map((archetypeId, index) => {
        const variant = variantFor(archetypeId, sample.direction)
        return runTask({
          taskKey: `${sample.id}:candidate:${variant.id}`,
          sampleId: sample.id,
          phase: 'candidate',
          model: config.models.candidates[index],
          messages: candidateMessages(
            sample,
            bundle,
            variant,
            analyses,
          ),
          meta: {
            agentVariantId: variant.id,
            archetypeId,
            candidateIndex: index + 1,
          },
        })
      }),
    )

    async function runPipeline(condition) {
      const stageRecords = new Map()
      for (const stage of STAGES) {
        const record = await runTask({
          taskKey: `${sample.id}:${condition}:${stage}`,
          sampleId: sample.id,
          phase: 'stage',
          model: config.models.editor,
          messages: stageMessages(
            sample,
            bundle,
            stage,
            condition,
            candidates,
            stageRecords,
          ),
          meta: { condition, stage },
        })
        stageRecords.set(stage, record)
      }
      return stageRecords.get('assemble')
    }

    const [rawFinal, fsbpFinal] = await Promise.all([
      runPipeline('multi_raw'),
      runPipeline('multi_fsbp'),
    ])
    finals.push(
      {
        sampleId: sample.id,
        direction: sample.direction,
        category: sample.category,
        condition: 'direct',
        model: direct.model,
        text: direct.body,
        sourceTaskKey: direct.taskKey,
      },
      {
        sampleId: sample.id,
        direction: sample.direction,
        category: sample.category,
        condition: 'multi_raw',
        model: rawFinal.model,
        text: rawFinal.body,
        sourceTaskKey: rawFinal.taskKey,
      },
      {
        sampleId: sample.id,
        direction: sample.direction,
        category: sample.category,
        condition: 'multi_fsbp',
        model: fsbpFinal.model,
        text: fsbpFinal.body,
        sourceTaskKey: fsbpFinal.taskKey,
      },
    )
    process.stdout.write(`Completed ${sample.id}\n`)
  }

  const workers = Array.from(
    { length: generation.sampleConcurrency },
    async () => {
      while (true) {
        const index = nextSample
        nextSample += 1
        if (index >= samples.length) return
        await processSample(samples[index])
      }
    },
  )
  await Promise.all(workers)
  await appendQueue
  finals.sort(
    (left, right) =>
      samples.findIndex((sample) => sample.id === left.sampleId) -
        samples.findIndex((sample) => sample.id === right.sampleId) ||
      CONDITIONS.indexOf(left.condition) - CONDITIONS.indexOf(right.condition),
  )
  await writeFile(
    finalPath,
    `${finals.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  )
  process.stdout.write(
    `Quality run complete: ${runId}, ${finals.length} blinded candidates.\n`,
  )
}

await main()
