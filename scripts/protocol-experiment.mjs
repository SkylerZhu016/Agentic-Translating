import {
  appendFile,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'

const PROTOCOLS = ['strict-json', 'freeform-raw', 'fsbp-v1']
const STAGES = ['review', 'filter', 'orchestrate', 'assemble']

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    result[token.slice(2)] = argv[index + 1]
    index += 1
  }
  return result
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function hash(value) {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : stableJson(value))
    .digest('hex')
}

function parseSemantic(raw) {
  const normalized = raw.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  const separator = lines.findIndex((line) => line.trim() === '---')
  if (separator < 0) return { raw, body: normalized.trim(), annotation: null }
  return {
    raw,
    body: lines.slice(0, separator).join('\n').trim(),
    annotation: lines.slice(separator + 1).join('\n').trim() || null,
  }
}

function parseJsonOutput(raw) {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced?.[1]?.trim() ?? trimmed
  const parsed = JSON.parse(candidate)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The strict output is not a JSON object.')
  }
  return parsed
}

function strictBody(stage, value) {
  const body = stage === 'assemble' ? value.final_translation : value.body
  if (typeof body !== 'string' || !body.trim()) {
    throw new Error(
      stage === 'assemble'
        ? 'Missing non-empty final_translation.'
        : 'Missing non-empty body.',
    )
  }
  return body.trim()
}

function assertNoSecrets(value, pointer = 'config') {
  if (!value || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    if (/^(apiKey|api_key|authorization)$/i.test(key)) {
      throw new Error(
        `${pointer}.${key} is forbidden. Use an apiKeyEnv environment-variable name.`,
      )
    }
    assertNoSecrets(nested, `${pointer}.${key}`)
  }
}

async function loadLocalExperimentEnv(root) {
  const envPath = path.join(root, '.env.experiment.local')
  let text
  try {
    text = await readFile(envPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const name = line.slice(0, separator).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || process.env[name]) {
      continue
    }
    let value = line.slice(separator + 1).trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    process.env[name] = value
  }
}

function resolveModel(spec, label) {
  if (!spec?.baseUrl || !spec?.model || !spec?.apiKeyEnv) {
    throw new Error(`${label} requires baseUrl, model and apiKeyEnv.`)
  }
  const apiKey = process.env[spec.apiKeyEnv]
  if (!apiKey) {
    throw new Error(
      `Missing environment variable ${spec.apiKeyEnv} for ${label}.`,
    )
  }
  return { ...spec, apiKey }
}

async function complete(spec, messages, temperature) {
  const startedAt = Date.now()
  const response = await fetch(
    `${spec.baseUrl.replace(/\/+$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${spec.apiKey}`,
      },
      body: JSON.stringify({
        model: spec.model,
        messages,
        temperature,
        stream: false,
      }),
    },
  )
  const text = await response.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`Non-JSON endpoint response (${response.status}): ${text}`)
  }
  if (!response.ok) {
    throw new Error(
      `Endpoint error ${response.status}: ${
        data?.error?.message ?? text
      }`,
    )
  }
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new Error('Endpoint response does not contain message.content.')
  }
  return {
    content,
    latencyMs: Date.now() - startedAt,
    usage: data.usage ?? null,
  }
}

function candidateMessages(sample) {
  const isEnglishTarget = sample.direction === 'zh_to_en'
  const system = isEnglishTarget
    ? `You are a translation candidate generator. Translate the complete Chinese source into English. Follow the task brief, preserve ambiguity when warranted, and output a complete translation. You may add notes after a standalone --- line; notes are not part of the translation.`
    : `你是候选译文生成 Agent。请将完整英文原文译为中文，遵循任务要求，在确有必要时保留歧义，并输出完整译文。可在独立成行的 --- 后补充注释；注释不属于译文正文。`
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `${
        isEnglishTarget ? 'Task brief' : '任务要求'
      }:\n${sample.taskBrief}\n\n${
        isEnglishTarget ? 'Source text' : '原文'
      }:\n${sample.sourceText}`,
    },
  ]
}

const STAGE_GOALS = {
  review:
    'Assess every candidate for faithfulness, naturalness, voice, structure and important errors.',
  filter:
    'Select the useful candidates and explain which strengths should survive. Do not discard plausible minority interpretations without reason.',
  orchestrate:
    'Plan one coherent final translation using the best supported choices from the candidates and prior analysis.',
  assemble:
    'Produce the complete final translation. Do not output only advice, fragments or a summary.',
}

function strictInstruction(stage) {
  const shapes = {
    review:
      '{"candidate_assessments":[{"candidate_id":"...","analysis":"..."}],"body":"complete review prose","annotation":"optional"}',
    filter:
      '{"selected_candidate_ids":["..."],"body":"complete selection rationale","annotation":"optional"}',
    orchestrate:
      '{"plan":"...","body":"complete orchestration plan","annotation":"optional"}',
    assemble:
      '{"final_translation":"complete translation only","body":"brief assembly rationale","annotation":"optional"}',
  }
  return `Return exactly one valid JSON object with no Markdown fence. Required shape: ${shapes[stage]}`
}

function stageMessages({ sample, protocol, stage, candidates, prior }) {
  const targetEnglish = sample.direction === 'zh_to_en'
  const goal = STAGE_GOALS[stage]
  const protocolInstruction =
    protocol === 'strict-json'
      ? strictInstruction(stage)
      : targetEnglish
        ? 'Use free text. Put optional notes after the first standalone --- line. The text before it must be complete and usable.'
        : '使用自由文本。可在首个独立成行的 --- 后写注释；分隔符前必须是完整、可直接使用的正文。'
  const candidatePayload =
    protocol === 'fsbp-v1'
      ? candidates.map((item) => ({
          id: item.id,
          text: parseSemantic(item.raw).body,
        }))
      : protocol === 'freeform-raw'
        ? candidates.map((item) => ({ id: item.id, raw: item.raw }))
        : candidates.map((item) => {
            const parsed = parseSemantic(item.raw)
            return {
              id: item.id,
              translation: parsed.body,
              annotation: parsed.annotation,
            }
          })
  const priorPayload =
    protocol === 'fsbp-v1'
      ? prior.map((item) => ({ stage: item.stage, body: item.body }))
      : prior.map((item) => ({ stage: item.stage, raw: item.raw }))
  return [
    {
      role: 'system',
      content: `${
        targetEnglish
          ? 'You are one stage in a four-stage translation deliberation pipeline.'
          : '你是四阶段翻译审议流程中的一个阶段。'
      }\n\nStage: ${stage}\nGoal: ${goal}\n${protocolInstruction}`,
    },
    {
      role: 'user',
      content: JSON.stringify(
        {
          direction: sample.direction,
          task_brief: sample.taskBrief,
          source_text: sample.sourceText,
          candidates: candidatePayload,
          prior_stages: priorPayload,
        },
        null,
        2,
      ),
    },
  ]
}

function judgeMessages(sample, orderedFinals) {
  const labels = orderedFinals.map((_, index) =>
    String.fromCharCode(65 + index),
  )
  const candidates = Object.fromEntries(
    labels.map((label, index) => [label, orderedFinals[index].body]),
  )
  return [
    {
      role: 'system',
      content:
        'You are an independent translation evaluator. Rank the anonymous candidates. Evaluate faithfulness, naturalness, style/voice, structure and overall coherence on a 1-10 scale. Do not infer the generating protocol. Return one JSON object only.',
    },
    {
      role: 'user',
      content: JSON.stringify(
        {
          direction: sample.direction,
          task_brief: sample.taskBrief,
          source_text: sample.sourceText,
          candidates,
          required_output: {
            ranking: labels,
            scores: Object.fromEntries(
              labels.map((label) => [
                label,
                {
                  faithfulness: '1-10',
                  naturalness: '1-10',
                  style: '1-10',
                  structure: '1-10',
                  coherence: '1-10',
                },
              ]),
            ),
            reason: 'brief comparative explanation',
          },
        },
        null,
        2,
      ),
    },
  ]
}

async function loadCompleted(rawPath) {
  const completed = new Map()
  try {
    const text = await readFile(rawPath, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      const record = JSON.parse(line)
      if (record.key) completed.set(record.key, record)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return completed
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.config) {
    throw new Error(
      'Usage: npm run experiment:protocol -- --config experiments/configs/main.json [--run run-id]',
    )
  }
  const root = process.cwd()
  await loadLocalExperimentEnv(root)
  const configPath = path.resolve(root, args.config)
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  assertNoSecrets(config)
  if (!Array.isArray(config.candidateModels) || config.candidateModels.length !== 3) {
    throw new Error('candidateModels must contain exactly three model specs.')
  }
  const samplesPath = path.resolve(path.dirname(configPath), config.samples)
  const samples = JSON.parse(await readFile(samplesPath, 'utf8'))
  if (!Array.isArray(samples) || samples.length !== 20) {
    throw new Error('The main experiment requires exactly 20 samples.')
  }
  const directions = new Set(samples.map((sample) => sample.direction))
  if (!directions.has('en_to_zh') || !directions.has('zh_to_en')) {
    throw new Error('Samples must cover both en_to_zh and zh_to_en.')
  }
  const stressCount = samples.filter((sample) => sample.stressAnnotation).length
  if (stressCount !== 6) {
    throw new Error('Exactly six samples must define stressAnnotation.')
  }
  const candidateModels = config.candidateModels.map((spec, index) =>
    resolveModel(spec, `candidateModels[${index}]`),
  )
  const coordinator = resolveModel(config.coordinatorModel, 'coordinatorModel')
  const judge = resolveModel(config.judgeModel, 'judgeModel')

  const safeConfig = {
    ...config,
    configPath: path.relative(root, configPath),
  }
  const runId =
    args.run ??
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${
      hash({ config: safeConfig, samples }).slice(0, 8)
    }`
  const runDir = path.join(root, 'experiments', 'results', runId)
  await mkdir(runDir, { recursive: true })
  const rawPath = path.join(runDir, 'raw.jsonl')
  const completed = await loadCompleted(rawPath)
  const append = async (record) => {
    const enriched = { ...record, recordedAt: new Date().toISOString() }
    await appendFile(rawPath, `${JSON.stringify(enriched)}\n`, 'utf8')
    completed.set(record.key, enriched)
    return enriched
  }

  await writeFile(
    path.join(runDir, 'run-config.json'),
    `${JSON.stringify(safeConfig, null, 2)}\n`,
    'utf8',
  )
  await writeFile(
    path.join(runDir, 'manifest.json'),
    `${JSON.stringify(
      {
        runId,
        createdAt: new Date().toISOString(),
        configHash: hash(safeConfig),
        samplesHash: hash(samples),
        sampleCount: samples.length,
        stressSampleCount: stressCount,
        protocols: PROTOCOLS,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  await writeFile(
    path.join(runDir, 'prompts.json'),
    `${JSON.stringify(
      {
        candidate: {
          en_to_zh: candidateMessages({
            direction: 'en_to_zh',
            taskBrief: '{{task_brief}}',
            sourceText: '{{source_text}}',
          })[0].content,
          zh_to_en: candidateMessages({
            direction: 'zh_to_en',
            taskBrief: '{{task_brief}}',
            sourceText: '{{source_text}}',
          })[0].content,
        },
        stageGoals: STAGE_GOALS,
        strictShapes: Object.fromEntries(
          STAGES.map((stage) => [stage, strictInstruction(stage)]),
        ),
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  for (const sample of samples) {
    const candidates = await Promise.all(candidateModels.map(async (model, index) => {
      const key = `candidate:${sample.id}:${index}`
      let record = completed.get(key)
      if (!record) {
        const result = await complete(
          model,
          candidateMessages(sample),
          config.temperatures?.candidate ?? 0.5,
        )
        const raw = sample.stressAnnotation
          ? `${parseSemantic(result.content).body}\n---\n${sample.stressAnnotation}`
          : result.content
        record = await append({
          key,
          type: 'candidate',
          sampleId: sample.id,
          direction: sample.direction,
          modelLabel: model.name ?? `candidate-${index + 1}`,
          model: model.model,
          raw,
          semantic: parseSemantic(raw),
          stressInjected: Boolean(sample.stressAnnotation),
          latencyMs: result.latencyMs,
          usage: result.usage,
        })
      }
      return { id: `candidate-${index + 1}`, raw: record.raw }
    }))

    const protocolFinals = await Promise.all(PROTOCOLS.map(async (protocol) => {
      const prior = []
      let failed = false
      for (const stage of STAGES) {
        const key = `stage:${sample.id}:${protocol}:${stage}`
        let record = completed.get(key)
        if (!record) {
          try {
            let attempts = 0
            let result = await complete(
              coordinator,
              stageMessages({
                sample,
                protocol,
                stage,
                candidates,
                prior,
              }),
              config.temperatures?.stage ?? 0.2,
            )
            let body
            let parsed = null
            if (protocol === 'strict-json') {
              try {
                parsed = parseJsonOutput(result.content)
                body = strictBody(stage, parsed)
              } catch (firstError) {
                attempts = 1
                const repairMessages = stageMessages({
                  sample,
                  protocol,
                  stage,
                  candidates,
                  prior,
                })
                repairMessages.push({
                  role: 'assistant',
                  content: result.content,
                })
                repairMessages.push({
                  role: 'user',
                  content: `Repair the output once. ${firstError.message} ${strictInstruction(stage)}`,
                })
                result = await complete(
                  coordinator,
                  repairMessages,
                  config.temperatures?.stage ?? 0.2,
                )
                parsed = parseJsonOutput(result.content)
                body = strictBody(stage, parsed)
              }
            } else {
              body = parseSemantic(result.content).body
              if (!body) throw new Error('The free-form stage body is empty.')
            }
            record = await append({
              key,
              type: 'stage',
              sampleId: sample.id,
              direction: sample.direction,
              protocol,
              stage,
              status: 'complete',
              raw: result.content,
              body,
              parsed,
              retryCount: attempts,
              formatSuccess: true,
              latencyMs: result.latencyMs,
              usage: result.usage,
            })
          } catch (error) {
            record = await append({
              key,
              type: 'stage',
              sampleId: sample.id,
              direction: sample.direction,
              protocol,
              stage,
              status: 'failed',
              error: error instanceof Error ? error.message : String(error),
              retryCount: protocol === 'strict-json' ? 1 : 0,
              formatSuccess: false,
            })
          }
        }
        if (record.status !== 'complete') {
          failed = true
          break
        }
        prior.push({ stage, raw: record.raw, body: record.body })
      }
      if (!failed) {
        const assembled = prior.find((item) => item.stage === 'assemble')
        return { protocol, body: assembled.body }
      }
      return null
    }))
    const finals = protocolFinals.filter(Boolean)

    if (finals.length === PROTOCOLS.length) {
      const orders = [finals, [...finals].reverse()]
      await Promise.all(orders.map(async (order, orderIndex) => {
        const key = `judge:${sample.id}:${orderIndex}`
        if (completed.has(key)) return
        try {
          const result = await complete(
            judge,
            judgeMessages(sample, order),
            config.temperatures?.judge ?? 0,
          )
          const parsed = parseJsonOutput(result.content)
          const labels = order.map((_, index) =>
            String.fromCharCode(65 + index),
          )
          if (
            !Array.isArray(parsed.ranking) ||
            parsed.ranking.length !== labels.length ||
            new Set(parsed.ranking).size !== labels.length
          ) {
            throw new Error('Judge ranking is missing or malformed.')
          }
          await append({
            key,
            type: 'judge',
            sampleId: sample.id,
            direction: sample.direction,
            orderIndex,
            labelToProtocol: Object.fromEntries(
              labels.map((label, index) => [
                label,
                order[index].protocol,
              ]),
            ),
            ranking: parsed.ranking,
            scores: parsed.scores ?? {},
            reason: parsed.reason ?? '',
            raw: result.content,
            latencyMs: result.latencyMs,
            usage: result.usage,
          })
        } catch (error) {
          await append({
            key,
            type: 'judge',
            sampleId: sample.id,
            direction: sample.direction,
            orderIndex,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }))
    }
  }

  process.stdout.write(
    `Protocol experiment run saved: ${runId}\nGenerate the report with: npm run experiment:report -- --run ${runId}\n`,
  )
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`)
  process.exitCode = 1
})
