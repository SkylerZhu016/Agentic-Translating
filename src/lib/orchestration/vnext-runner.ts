import { createHash, randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import type { ConfigSnapshot, Stage } from '../contracts/types'
import type {
  AgentDirectionVariant,
  ModelBinding,
} from '../contracts/vnext'
import {
  chatCompletion,
  isAsyncIterable,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
} from '../llm/client'
import { runFanOut, type AgentRuntime } from './fanout'
import { estimateTokens } from '../guards/tokens'
import { parseSemanticAgentOutput } from '../protocol/semantic-output'
import {
  checkTranslationEvidence,
  type TranslationEvidenceReport,
} from '../evidence/checker'

const callAgentsArgsSchema = z.object({
  calls: z.array(z.object({
    agentVariantId: z.string().min(1),
    additionalInstruction: z.string().default(''),
    selectionReason: z.string().default(''),
  })).min(2).max(4),
})

const writeDraftArgsSchema = z.object({
  text: z.string().min(1),
  reason: z.string().default(''),
  evidenceInvocationIds: z.array(z.string().min(1)).min(2),
})

const submitFinalArgsSchema = z.object({
  versionId: z.number().int().positive(),
  summary: z.string().default(''),
})

interface SessionRecord {
  id: string
  source_text: string
  source_lang: string
  target_lang: string
  state: string
  task_brief?: string
  config_snapshot: string
}

interface InvocationResult {
  id: string
  variant: AgentDirectionVariant
  body: string
  evidence: TranslationEvidenceReport
}

interface ResolvedEndpoint {
  id: number
  baseUrl: string
  apiKey: string
  contextWindow: number | null
}

const running = new Map<string, Promise<void>>()

/** Test/release gate helper: wait until every server-owned vNext run settles. */
export async function waitForVNextRunsToSettle() {
  while (running.size > 0) {
    await Promise.allSettled([...running.values()])
  }
}

function promptIsEnglish(snapshot: ConfigSnapshot) {
  return snapshot.promptBundleSnapshot?.promptLanguage === 'en'
}

function promptText(snapshot: ConfigSnapshot, chinese: string, english: string) {
  return promptIsEnglish(snapshot) ? english : chinese
}

function emitEvent(
  db: Database.Database,
  runId: string,
  sessionId: string,
  eventType: string,
  payload: unknown = {},
) {
  const row = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM run_events WHERE run_id=?',
  ).get(runId) as { seq: number }
  db.prepare(`
    INSERT INTO run_events (run_id, session_id, seq, event_type, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(runId, sessionId, row.seq, eventType, JSON.stringify(payload))
}

function resolveEndpoint(
  snapshot: ConfigSnapshot,
  endpointId: number | null,
): ResolvedEndpoint {
  const modern = snapshot.endpointSnapshots?.find(
    (endpoint) => endpoint.id === endpointId,
  )
  if (modern) {
    return {
      id: modern.id,
      baseUrl: modern.baseUrl,
      apiKey: modern.apiKey,
      contextWindow: modern.contextWindow,
    }
  }
  const legacy =
    snapshot.endpoints?.find((endpoint) => endpoint.id === endpointId) ??
    snapshot.endpoint
  if (!legacy) throw new Error(`Endpoint ${endpointId ?? '(unset)'} is unavailable`)
  return {
    id: legacy.id,
    baseUrl: legacy.base_url,
    apiKey: legacy.api_key,
    contextWindow: legacy.context_window ?? null,
  }
}

function assertContextFits(
  endpoint: ResolvedEndpoint,
  messages: ChatCompletionRequest['messages'],
  tools?: ChatCompletionRequest['tools'],
) {
  if (!endpoint.contextWindow) return
  const estimate = estimateTokens(
    messages.map((message) => message.content).join('\n') +
      (tools ? JSON.stringify(tools) : ''),
  )
  if (estimate > endpoint.contextWindow) {
    throw new Error(
      `上下文估算为 ${estimate} tokens，超过端点上限 ${endpoint.contextWindow}；未对正文做任何裁剪。`,
    )
  }
}

async function complete(
  endpoint: ResolvedEndpoint,
  request: ChatCompletionRequest,
): Promise<ChatCompletionResponse> {
  assertContextFits(endpoint, request.messages, request.tools)
  const response = await chatCompletion(
    { baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey },
    { ...request, stream: false },
  )
  if (!isAsyncIterable(response)) return response
  let content = ''
  let toolCalls: ChatCompletionResponse['toolCalls']
  for await (const event of response) {
    if (event.type === 'text') content += event.content
    if (event.type === 'done') {
      content = event.content || content
      toolCalls = event.toolCalls
    }
  }
  return { content, toolCalls }
}

function buildCallAgentsTool(snapshot: ConfigSnapshot): ChatCompletionRequest['tools'] {
  return [{
    type: 'function',
    function: {
      name: 'call_agents',
      description:
        snapshot.promptBundleSnapshot?.toolDescriptions.call_agents ??
        'Choose and call two to four complementary translation agents.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['calls'],
        properties: {
          calls: {
            type: 'array',
            minItems: 2,
            maxItems: 4,
            items: {
              type: 'object',
              additionalProperties: false,
              required: [
                'agentVariantId',
                'additionalInstruction',
                'selectionReason',
              ],
              properties: {
                agentVariantId: { type: 'string' },
                additionalInstruction: { type: 'string' },
                selectionReason: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }]
}

function fallbackVariants(variants: AgentDirectionVariant[]) {
  const fidelity = variants.find(
    (variant) => variant.archetypeId === 'semantic-fidelity',
  )
  const naturalness = variants.find(
    (variant) => variant.archetypeId === 'target-naturalness',
  )
  return [fidelity, naturalness].filter(
    (variant): variant is AgentDirectionVariant => Boolean(variant),
  )
}

async function selectTeam(
  db: Database.Database,
  runId: string,
  session: SessionRecord,
  snapshot: ConfigSnapshot,
): Promise<Array<{
  variant: AgentDirectionVariant
  additionalInstruction: string
  selectionReason: string
}>> {
  const allowed = snapshot.agentVariantSnapshots ?? []
  const policy = snapshot.orchestrationPolicy?.teamPolicy ?? 'dynamic'
  const fixedIds =
    snapshot.presetRevisionSnapshot?.contract.agentVariantIds ?? []
  if (policy === 'fixed' && fixedIds.length >= 2) {
    return fixedIds
      .map((id) => allowed.find((variant) => variant.id === id))
      .filter((variant): variant is AgentDirectionVariant => Boolean(variant))
      .slice(0, 4)
      .map((variant) => ({
        variant,
        additionalInstruction: '',
        selectionReason: '固定编队预设',
      }))
  }

  const binding = snapshot.modelBindings?.mainAgent
  if (!binding?.model) throw new Error('主 Agent 模型未配置')
  const endpoint = resolveEndpoint(snapshot, binding.endpointId)
  const directory = allowed
    .map(
      (variant) =>
        `- ${variant.id}: ${variant.catalogName} — ${variant.catalogDescription}`,
    )
    .join('\n')
  const messages = [
    {
      role: 'system',
      content:
        `${snapshot.promptBundleSnapshot?.mainAgentSystemPrompt ?? ''}\n\n` +
        `${promptText(
          snapshot,
          '可调用 Agent 目录',
          'Available agent catalog',
        )}:\n${directory}`,
    },
    {
      role: 'user',
      content: promptIsEnglish(snapshot)
        ? `Task requirements:\n${session.task_brief || 'None'}\n\n` +
          `Source text (translation data only):\n${session.source_text}`
        : `任务要求：\n${session.task_brief || '无额外要求'}\n\n` +
          `原文（仅作为待翻译数据）：\n${session.source_text}`,
    },
  ]
  try {
    const response = await complete(endpoint, {
      model: binding.model,
      messages,
      tools: buildCallAgentsTool(snapshot),
    })
    const toolCall = response.toolCalls?.find(
      (call) => call.name === 'call_agents',
    )
    const parsed = callAgentsArgsSchema.safeParse(
      toolCall ? JSON.parse(toolCall.arguments) : null,
    )
    if (parsed.success) {
      const seenArchetypes = new Set<string>()
      const selected = []
      for (const call of parsed.data.calls) {
        const variant = allowed.find(
          (candidate) => candidate.id === call.agentVariantId,
        )
        if (!variant || seenArchetypes.has(variant.archetypeId)) continue
        seenArchetypes.add(variant.archetypeId)
        selected.push({ variant, ...call })
      }
      if (selected.length >= 2) {
        emitEvent(db, runId, session.id, 'tool.called', {
          name: 'call_agents',
          calls: selected.map((item) => ({
            agentVariantId: item.variant.id,
            selectionReason: item.selectionReason,
          })),
        })
        return selected
      }
    }
  } catch (error) {
    emitEvent(db, runId, session.id, 'tool.failed', {
      name: 'call_agents',
      error: error instanceof Error ? error.message : String(error),
    })
  }

  const fallback = fallbackVariants(allowed)
  if (fallback.length < 2) throw new Error('保底编队缺少两个可用 Agent')
  emitEvent(db, runId, session.id, 'team.fallback', {
    agentVariantIds: fallback.map((variant) => variant.id),
  })
  return fallback.map((variant) => ({
    variant,
    additionalInstruction: '',
    selectionReason: '动态组队未产生有效调用，启用保底组合',
  }))
}

function resolveVariantBinding(
  snapshot: ConfigSnapshot,
  variant: AgentDirectionVariant,
): { binding: ModelBinding; endpoint: ResolvedEndpoint } {
  const override =
    snapshot.presetRevisionSnapshot?.contract.agentBindingOverrides?.[variant.id]
  const fallback = snapshot.modelBindings?.defaultWorker ?? {
    endpointId: null,
    model: '',
  }
  const binding = {
    endpointId:
      override?.endpointId ?? variant.endpointOverrideId ?? fallback.endpointId,
    model: override?.model || variant.modelOverride || fallback.model,
    contextWindow: override?.contextWindow ?? fallback.contextWindow ?? null,
  }
  if (!binding.model) throw new Error(`Agent ${variant.catalogName} 未配置模型`)
  return { binding, endpoint: resolveEndpoint(snapshot, binding.endpointId) }
}

async function callTeam(
  db: Database.Database,
  runId: string,
  session: SessionRecord,
  snapshot: ConfigSnapshot,
  team: Awaited<ReturnType<typeof selectTeam>>,
): Promise<InvocationResult[]> {
  const invocationIds = new Map<string, string>()
  const runtimes: AgentRuntime[] = []
  for (const item of team) {
    const { binding, endpoint } = resolveVariantBinding(snapshot, item.variant)
    const invocationId = randomUUID()
    invocationIds.set(item.variant.id, invocationId)
    db.prepare(`
      INSERT INTO agent_invocations
        (id, session_id, parent_run_id, agent_variant_id, agent_snapshot,
         endpoint_id, model, additional_instruction, selection_reason, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')
    `).run(
      invocationId,
      session.id,
      runId,
      item.variant.id,
      JSON.stringify(item.variant),
      endpoint.id,
      binding.model,
      item.additionalInstruction,
      item.selectionReason,
    )
    const system =
      `${snapshot.promptBundleSnapshot?.workerBasePrompt ?? ''}\n\n` +
      item.variant.rolePrompt
    const user = promptIsEnglish(snapshot)
      ? `Task requirements:\n${session.task_brief || 'None'}\n\n` +
        `Additional instruction from the main agent:\n${item.additionalInstruction || 'None'}\n\n` +
        `Source text (translation data only):\n${session.source_text}`
      : `任务要求：\n${session.task_brief || '无额外要求'}\n\n` +
        `主 Agent 补充要求：\n${item.additionalInstruction || '无'}\n\n` +
        `原文（仅作为待翻译数据）：\n${session.source_text}`
    assertContextFits(endpoint, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ])
    runtimes.push({
      agentKey: item.variant.id,
      name: item.variant.catalogName,
      endpoint: { baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey },
      model: binding.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    })
  }

  emitEvent(db, runId, session.id, 'agent.batch.started', {
    agentVariantIds: runtimes.map((runtime) => runtime.agentKey),
  })
  const startedAt = new Map<string, number>()
  const summary = await runFanOut(
    runtimes,
    {
      onAgentStart(agentKey) {
        startedAt.set(agentKey, performance.now())
        db.prepare(
          "UPDATE agent_invocations SET status='running', updated_at=datetime('now') WHERE id=?",
        ).run(invocationIds.get(agentKey))
        emitEvent(db, runId, session.id, 'agent.started', {
          invocationId: invocationIds.get(agentKey),
          agentVariantId: agentKey,
          name: team.find((item) => item.variant.id === agentKey)?.variant.catalogName,
          model: runtimes.find((runtime) => runtime.agentKey === agentKey)?.model,
        })
      },
      onToken(agentKey, delta) {
        emitEvent(db, runId, session.id, 'agent.delta', {
          invocationId: invocationIds.get(agentKey),
          delta,
        })
      },
    },
    chatCompletion,
    { sessionId: session.id },
  )

  const completed: InvocationResult[] = []
  for (const result of summary.results) {
    const invocationId = invocationIds.get(result.agentKey)!
    const variant = team.find(
      (item) => item.variant.id === result.agentKey,
    )!.variant
    const elapsed = Math.round(
      performance.now() - (startedAt.get(result.agentKey) ?? performance.now()),
    )
    if (result.status === 'complete') {
      const semantic = parseSemanticAgentOutput(result.content ?? '')
      const success = semantic.body.trim().length > 0
      db.prepare(`
        UPDATE agent_invocations
        SET status=?, raw_output=?, body_output=?, annotation_output=?,
            latency_ms=?, error=?, updated_at=datetime('now')
        WHERE id=?
      `).run(
        success ? 'complete' : 'failed',
        semantic.raw,
        semantic.body,
        semantic.annotation,
        elapsed,
        success ? null : 'Agent returned an empty body before the FSBP boundary',
        invocationId,
      )
      emitEvent(
        db,
        runId,
        session.id,
        success ? 'agent.completed' : 'agent.failed',
        {
          invocationId,
          agentVariantId: result.agentKey,
          raw: semantic.raw,
          body: semantic.body,
          annotation: semantic.annotation,
          latencyMs: elapsed,
        },
      )
      if (success) {
        const evidence = checkTranslationEvidence({
          direction: snapshot.direction ?? 'en_to_zh',
          sourceText: session.source_text,
          translatedText: semantic.body,
          constraints: snapshot.constraints,
          reportLanguage: snapshot.promptBundleSnapshot?.promptLanguage,
        })
        completed.push({
          id: invocationId,
          variant,
          body: semantic.body,
          evidence,
        })
        emitEvent(db, runId, session.id, 'evidence.checked', {
          invocationId,
          report: evidence,
        })
      }
    } else {
      db.prepare(`
        UPDATE agent_invocations
        SET status='failed', error=?, latency_ms=?, updated_at=datetime('now')
        WHERE id=?
      `).run(result.error ?? 'Agent call failed', elapsed, invocationId)
      emitEvent(db, runId, session.id, 'agent.failed', {
        invocationId,
        agentVariantId: result.agentKey,
        error: result.error ?? 'Agent call failed',
      })
    }
  }
  return completed
}

function candidateContext(
  candidates: InvocationResult[],
  promptLanguage: 'zh' | 'en',
) {
  return candidates
    .map(
      (candidate, index) =>
        (promptLanguage === 'en'
          ? `Candidate ${index + 1} / ${candidate.variant.catalogName}\n` +
            `Invocation ID: ${candidate.id}\n${candidate.body}\n\n` +
            `Auxiliary evidence:\n${candidate.evidence.naturalLanguage}`
          : `候选 ${index + 1} / ${candidate.variant.catalogName}\n` +
            `调用 ID: ${candidate.id}\n${candidate.body}\n\n` +
            `辅助证据：\n${candidate.evidence.naturalLanguage}`),
    )
    .join('\n\n')
}

async function createMainDraft(
  db: Database.Database,
  runId: string,
  session: SessionRecord,
  snapshot: ConfigSnapshot,
  candidates: InvocationResult[],
) {
  const binding = snapshot.modelBindings?.mainAgent
  if (!binding?.model) throw new Error('主 Agent 模型未配置')
  const endpoint = resolveEndpoint(snapshot, binding.endpointId)
  const writeDraftTool: NonNullable<ChatCompletionRequest['tools']>[number] = {
    type: 'function',
    function: {
      name: 'write_draft',
      description:
        snapshot.promptBundleSnapshot?.toolDescriptions.write_draft ??
        'Create the first complete translation draft with candidate evidence.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'reason', 'evidenceInvocationIds'],
        properties: {
          text: { type: 'string' },
          reason: { type: 'string' },
          evidenceInvocationIds: {
            type: 'array',
            minItems: 2,
            items: { type: 'string' },
          },
        },
      },
    },
  }
  const messages = [
    {
      role: 'system',
      content:
        `${snapshot.promptBundleSnapshot?.mainAgentSystemPrompt ?? ''}\n\n` +
        promptText(
          snapshot,
          '必须且只能调用一次 write_draft，并引用至少两个成功候选的调用 ID。',
          'Use write_draft exactly once. Cite at least two successful invocation IDs.',
        ),
    },
    {
      role: 'user',
      content: promptIsEnglish(snapshot)
        ? `Task requirements:\n${session.task_brief || 'None'}\n\n` +
          `Source text:\n${session.source_text}\n\n` +
          `Candidate bodies:\n${candidateContext(candidates, 'en')}`
        : `任务要求：\n${session.task_brief || '无额外要求'}\n\n` +
          `原文：\n${session.source_text}\n\n` +
          `候选正文：\n${candidateContext(candidates, 'zh')}`,
    },
  ]
  const response = await complete(endpoint, {
    model: binding.model,
    messages,
    tools: [writeDraftTool],
  })
  const toolCall = response.toolCalls?.find((call) => call.name === 'write_draft')
  let args: unknown = null
  try {
    args = toolCall ? JSON.parse(toolCall.arguments) : null
  } catch {
    args = null
  }
  const parsed = writeDraftArgsSchema.safeParse(args)
  const validIds = new Set(candidates.map((candidate) => candidate.id))
  if (
    !parsed.success ||
    new Set(parsed.data.evidenceInvocationIds).size < 2 ||
    parsed.data.evidenceInvocationIds.some((id) => !validIds.has(id))
  ) {
    emitEvent(db, runId, session.id, 'tool.failed', {
      name: 'write_draft',
      error: 'write_draft 必须引用至少两个本次成功候选',
    })
    throw new Error('主 Agent 未能提交带有两个有效候选证据的第一版成稿')
  }
  emitEvent(db, runId, session.id, 'tool.called', {
    name: 'write_draft',
    reason: parsed.data.reason,
    evidenceInvocationIds: parsed.data.evidenceInvocationIds,
  })
  const hash = createHash('sha256').update(parsed.data.text).digest('hex')
  const result = db.prepare(`
    INSERT INTO final_versions
      (session_id, version_no, text, source, parent_version_id, content_hash)
    VALUES (?, 1, ?, 'main_draft', NULL, ?)
  `).run(session.id, parsed.data.text, hash)
  const versionId = Number(result.lastInsertRowid)
  emitEvent(db, runId, session.id, 'version.created', {
    versionId,
    versionNo: 1,
    source: 'main_draft',
    reason: parsed.data.reason,
    evidenceInvocationIds: parsed.data.evidenceInvocationIds,
  })

  const submitTool: NonNullable<ChatCompletionRequest['tools']>[number] = {
    type: 'function',
    function: {
      name: 'submit_final',
      description:
        snapshot.promptBundleSnapshot?.toolDescriptions.submit_final ??
        'Mark a text version as the final version.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['versionId', 'summary'],
        properties: {
          versionId: { type: 'integer' },
          summary: { type: 'string' },
        },
      },
    },
  }
  const submitResponse = await complete(endpoint, {
    model: binding.model,
    messages: [
      {
        role: 'system',
          content:
            `${snapshot.promptBundleSnapshot?.mainAgentSystemPrompt ?? ''}\n\n` +
            promptText(
              snapshot,
              '证据化初稿已保存。请对该版本调用 submit_final。',
              'The evidence-backed draft is saved. Use submit_final for that version.',
            ),
      },
      {
        role: 'user',
        content: `versionId=${versionId}\n\n${parsed.data.text}`,
      },
    ],
    tools: [submitTool],
  })
  const submitCall = submitResponse.toolCalls?.find(
    (call) => call.name === 'submit_final',
  )
  let submitArgs: unknown = null
  try {
    submitArgs = submitCall ? JSON.parse(submitCall.arguments) : null
  } catch {
    submitArgs = null
  }
  const submit = submitFinalArgsSchema.safeParse(submitArgs)
  if (!submit.success || submit.data.versionId !== versionId) {
    emitEvent(db, runId, session.id, 'tool.failed', {
      name: 'submit_final',
      error: 'submit_final 引用了无效版本',
    })
    throw new Error('第一版已保存，但主 Agent 未正确提交最终版本')
  }
  db.prepare(
    "UPDATE sessions SET final_version_id=?, state='assembled', updated_at=datetime('now') WHERE id=?",
  ).run(versionId, session.id)
  emitEvent(db, runId, session.id, 'tool.called', {
    name: 'submit_final',
    versionId,
    summary: submit.data.summary,
  })
}

async function runFourStages(
  db: Database.Database,
  runId: string,
  session: SessionRecord,
  snapshot: ConfigSnapshot,
  candidates: InvocationResult[],
) {
  const binding = snapshot.modelBindings?.mainAgent
  if (!binding?.model) throw new Error('统筹模型未配置')
  const endpoint = resolveEndpoint(snapshot, binding.endpointId)
  const bundle = snapshot.promptBundleSnapshot
  if (!bundle) throw new Error('方向提示词包缺失')
  const templates: Record<Stage, string> = {
    review: bundle.reviewPrompt,
    filter: bundle.filterPrompt,
    orchestrate: bundle.orchestratePrompt,
    assemble: bundle.assemblePrompt,
  }
  const prior: Partial<Record<Stage, string>> = {}
  db.prepare(
    "UPDATE sessions SET state='coordinating', updated_at=datetime('now') WHERE id=?",
  ).run(session.id)
  for (const stage of ['review', 'filter', 'orchestrate', 'assemble'] as Stage[]) {
    emitEvent(db, runId, session.id, 'stage.started', { stage })
    const response = await complete(endpoint, {
      model: binding.model,
      messages: [
        {
          role: 'system',
          content:
            `${templates[stage]}\n\n` +
            (bundle.promptLanguage === 'en'
              ? 'Write freely. Notes may follow a standalone --- line; only the body continues downstream.'
              : '自由输出；注释可置于独立一行的 --- 之后，只有正文继续传给下游。'),
        },
        {
          role: 'user',
          content: bundle.promptLanguage === 'en'
            ? `Task requirements:\n${session.task_brief || 'None'}\n\n` +
              `Source text:\n${session.source_text}\n\n` +
              `Candidate bodies:\n${candidateContext(candidates, 'en')}\n\n` +
              `Prior stage bodies:\n${Object.entries(prior)
                .map(([name, body]) => `${name}:\n${body}`)
                .join('\n\n')}`
            : `任务要求：\n${session.task_brief || '无'}\n\n` +
              `原文：\n${session.source_text}\n\n` +
              `候选正文：\n${candidateContext(candidates, 'zh')}\n\n` +
              `前置阶段正文：\n${Object.entries(prior)
                .map(([name, body]) => `${name}:\n${body}`)
                .join('\n\n')}`,
        },
      ],
    })
    const semantic = parseSemanticAgentOutput(response.content)
    if (!semantic.body.trim()) throw new Error(`${stage} 阶段正文为空`)
    db.prepare(`
      INSERT INTO stage_outputs
        (session_id, stage, status, prompt_used, raw_output, error)
      VALUES (?, ?, 'complete', ?, ?, NULL)
      ON CONFLICT(session_id, stage) DO UPDATE SET
        status='complete', prompt_used=excluded.prompt_used,
        raw_output=excluded.raw_output, error=NULL
    `).run(session.id, stage, templates[stage], semantic.raw)
    prior[stage] = semantic.body
    emitEvent(db, runId, session.id, 'stage.completed', {
      stage,
      raw: semantic.raw,
      body: semantic.body,
      annotation: semantic.annotation,
    })
  }
  const finalText = prior.assemble!
  const hash = createHash('sha256').update(finalText).digest('hex')
  const result = db.prepare(`
    INSERT INTO final_versions
      (session_id, version_no, text, source, parent_version_id, content_hash)
    VALUES (?, 1, ?, 'assemble', NULL, ?)
  `).run(session.id, finalText, hash)
  const versionId = Number(result.lastInsertRowid)
  db.prepare(
    "UPDATE sessions SET final_version_id=?, state='assembled', updated_at=datetime('now') WHERE id=?",
  ).run(versionId, session.id)
  emitEvent(db, runId, session.id, 'version.created', {
    versionId,
    versionNo: 1,
    source: 'assemble',
  })
}

async function executeRun(
  db: Database.Database,
  runId: string,
  session: SessionRecord,
) {
  try {
    db.prepare(
      "UPDATE orchestration_runs SET status='running', started_at=datetime('now') WHERE id=?",
    ).run(runId)
    db.prepare(
      "UPDATE sessions SET state='translating', updated_at=datetime('now') WHERE id=?",
    ).run(session.id)
    emitEvent(db, runId, session.id, 'main.started')
    const snapshot = JSON.parse(session.config_snapshot) as ConfigSnapshot
    if (snapshot.version !== 3) {
      throw new Error('旧会话不支持 vNext 动态运行；仍可查看或使用原四阶段流程')
    }
    const team = await selectTeam(db, runId, session, snapshot)
    let candidates = await callTeam(db, runId, session, snapshot, team)
    if (candidates.length < 2) {
      const usedArchetypes = new Set(
        candidates.map((candidate) => candidate.variant.archetypeId),
      )
      const supplement = (snapshot.agentVariantSnapshots ?? []).find(
        (variant) => !usedArchetypes.has(variant.archetypeId) &&
          !team.some((item) => item.variant.id === variant.id),
      )
      if (supplement) {
        emitEvent(db, runId, session.id, 'team.fallback', {
          reason: '仅一个候选成功，补充互补角色',
          agentVariantIds: [supplement.id],
        })
        candidates = candidates.concat(
          await callTeam(db, runId, session, snapshot, [{
            variant: supplement,
            additionalInstruction: '',
            selectionReason: '补足第二个独立原型候选',
          }]),
        )
      }
    }
    if (candidates.length < 2) {
      throw new Error('少于两个不同 Agent 原型成功，不能建立第一版成稿')
    }
    db.prepare(
      "UPDATE sessions SET state='translated', updated_at=datetime('now') WHERE id=?",
    ).run(session.id)
    const reviewMode =
      snapshot.orchestrationPolicy?.reviewMode ?? 'main_editor'
    if (reviewMode === 'four_stage') {
      await runFourStages(db, runId, session, snapshot, candidates)
    } else {
      await createMainDraft(db, runId, session, snapshot, candidates)
    }
    db.prepare(`
      UPDATE orchestration_runs
      SET status='complete', phase='complete', completed_at=datetime('now')
      WHERE id=?
    `).run(runId)
    emitEvent(db, runId, session.id, 'session.completed')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    db.prepare(`
      UPDATE orchestration_runs
      SET status='failed', error=?, completed_at=datetime('now')
      WHERE id=?
    `).run(message, runId)
    emitEvent(db, runId, session.id, 'run.interrupted', { error: message })
  } finally {
    running.delete(runId)
  }
}

export function startVNextRun(
  db: Database.Database,
  sessionId: string,
): { runId: string; reused: boolean } {
  const existing = db.prepare(`
    SELECT id FROM orchestration_runs
    WHERE session_id=? AND status IN ('queued','running')
    ORDER BY created_at DESC LIMIT 1
  `).get(sessionId) as { id: string } | undefined
  if (existing) return { runId: existing.id, reused: true }
  const session = db.prepare(
    'SELECT * FROM sessions WHERE id=?',
  ).get(sessionId) as SessionRecord | undefined
  if (!session) throw new Error('session_not_found')
  if (!['draft', 'translated'].includes(session.state)) {
    throw new Error(`invalid_session_state:${session.state}`)
  }
  const runId = randomUUID()
  db.prepare(`
    INSERT INTO orchestration_runs (id, session_id, status, phase)
    VALUES (?, ?, 'queued', 'team')
  `).run(runId, sessionId)
  emitEvent(db, runId, sessionId, 'session.created', { sessionId, runId })
  const promise = executeRun(db, runId, session)
  running.set(runId, promise)
  void promise
  return { runId, reused: false }
}

interface InvocationRetryRow {
  id: string
  session_id: string
  parent_run_id: string
  agent_variant_id: string
  agent_snapshot: string
  endpoint_id: number
  model: string
  additional_instruction: string
  selection_reason: string
  status: string
}

async function executeInvocationRetry(
  db: Database.Database,
  runId: string,
  newInvocationId: string,
  source: InvocationRetryRow,
  session: SessionRecord,
  snapshot: ConfigSnapshot,
) {
  const variant = JSON.parse(source.agent_snapshot) as AgentDirectionVariant
  const endpoint = resolveEndpoint(snapshot, source.endpoint_id)
  const system =
    `${snapshot.promptBundleSnapshot?.workerBasePrompt ?? ''}\n\n` +
    variant.rolePrompt
  const user = promptIsEnglish(snapshot)
    ? `Task requirements:\n${session.task_brief || 'None'}\n\n` +
      `Additional instruction from the main agent:\n${source.additional_instruction || 'None'}\n\n` +
      `Source text (translation data only):\n${session.source_text}`
    : `任务要求：\n${session.task_brief || '无额外要求'}\n\n` +
      `主 Agent 补充要求：\n${source.additional_instruction || '无'}\n\n` +
      `原文（仅作为待翻译数据）：\n${session.source_text}`
  try {
    db.prepare(`
      UPDATE orchestration_runs
      SET status='running', started_at=datetime('now')
      WHERE id=?
    `).run(runId)
    db.prepare(`
      UPDATE agent_invocations
      SET status='running', updated_at=datetime('now')
      WHERE id=?
    `).run(newInvocationId)
    emitEvent(db, runId, session.id, 'agent.started', {
      invocationId: newInvocationId,
      replacesInvocationId: source.id,
      agentVariantId: variant.id,
      name: variant.catalogName,
      model: source.model,
    })
    const startedAt = performance.now()
    const summary = await runFanOut(
      [{
        agentKey: variant.id,
        name: variant.catalogName,
        endpoint: { baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey },
        model: source.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }],
      {
        onToken(_agentKey, delta) {
          emitEvent(db, runId, session.id, 'agent.delta', {
            invocationId: newInvocationId,
            delta,
          })
        },
      },
      chatCompletion,
      { sessionId: session.id },
    )
    const result = summary.results[0]
    const elapsed = Math.round(performance.now() - startedAt)
    if (!result || result.status !== 'complete') {
      throw new Error(result?.error ?? 'Agent retry failed')
    }
    const semantic = parseSemanticAgentOutput(result.content ?? '')
    if (!semantic.body.trim()) {
      throw new Error('Agent returned an empty body before the FSBP boundary')
    }
    db.prepare(`
      UPDATE agent_invocations
      SET status='complete', raw_output=?, body_output=?,
          annotation_output=?, latency_ms=?, error=NULL,
          updated_at=datetime('now')
      WHERE id=?
    `).run(
      semantic.raw,
      semantic.body,
      semantic.annotation,
      elapsed,
      newInvocationId,
    )
    emitEvent(db, runId, session.id, 'agent.completed', {
      invocationId: newInvocationId,
      replacesInvocationId: source.id,
      agentVariantId: variant.id,
      raw: semantic.raw,
      body: semantic.body,
      annotation: semantic.annotation,
      latencyMs: elapsed,
    })
    const evidence = checkTranslationEvidence({
      direction: snapshot.direction ?? 'en_to_zh',
      sourceText: session.source_text,
      translatedText: semantic.body,
      constraints: snapshot.constraints,
      reportLanguage: snapshot.promptBundleSnapshot?.promptLanguage,
    })
    emitEvent(db, runId, session.id, 'evidence.checked', {
      invocationId: newInvocationId,
      report: evidence,
    })
    const completed = db.prepare(`
      SELECT agent_snapshot
      FROM agent_invocations
      WHERE session_id=? AND status='complete'
    `).all(session.id) as Array<{ agent_snapshot: string }>
    const archetypes = new Set(
      completed.flatMap((item) => {
        try {
          const parsed = JSON.parse(item.agent_snapshot) as AgentDirectionVariant
          return parsed.archetypeId ? [parsed.archetypeId] : []
        } catch {
          return []
        }
      }),
    )
    db.prepare(`
      UPDATE sessions
      SET state=?, updated_at=datetime('now')
      WHERE id=?
    `).run(archetypes.size >= 2 ? 'translated' : 'draft', session.id)
    db.prepare(`
      UPDATE orchestration_runs
      SET status='complete', phase='retry', completed_at=datetime('now')
      WHERE id=?
    `).run(runId)
    emitEvent(db, runId, session.id, 'agent.retry.completed', {
      invocationId: newInvocationId,
      replacedInvocationId: source.id,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    db.prepare(`
      UPDATE agent_invocations
      SET status='failed', error=?, updated_at=datetime('now')
      WHERE id=?
    `).run(message, newInvocationId)
    db.prepare(`
      UPDATE orchestration_runs
      SET status='failed', phase='retry', error=?,
          completed_at=datetime('now')
      WHERE id=?
    `).run(message, runId)
    emitEvent(db, runId, session.id, 'agent.failed', {
      invocationId: newInvocationId,
      replacesInvocationId: source.id,
      agentVariantId: variant.id,
      error: message,
    })
  } finally {
    running.delete(runId)
  }
}

export function startVNextInvocationRetry(
  db: Database.Database,
  sessionId: string,
  invocationId: string,
): {
  runId: string
  invocationId: string
  afterEventId: number
} {
  const session = db.prepare(
    'SELECT * FROM sessions WHERE id=?',
  ).get(sessionId) as SessionRecord | undefined
  if (!session) throw new Error('session_not_found')
  const snapshot = JSON.parse(session.config_snapshot) as ConfigSnapshot
  if (snapshot.version !== 3) throw new Error('not_vnext_session')
  const source = db.prepare(`
    SELECT * FROM agent_invocations
    WHERE id=? AND session_id=?
  `).get(invocationId, sessionId) as InvocationRetryRow | undefined
  if (!source) throw new Error('invocation_not_found')
  if (!['failed', 'interrupted'].includes(source.status)) {
    throw new Error(`invocation_not_retryable:${source.status}`)
  }
  const active = db.prepare(`
    SELECT 1 FROM orchestration_runs
    WHERE session_id=? AND status IN ('queued','running')
    LIMIT 1
  `).get(sessionId)
  if (active) throw new Error('session_run_still_active')
  const afterEventId = (
    db.prepare(
      'SELECT COALESCE(MAX(id), 0) AS id FROM run_events WHERE session_id=?',
    ).get(sessionId) as { id: number }
  ).id
  const runId = randomUUID()
  const newInvocationId = randomUUID()
  db.transaction(() => {
    db.prepare(`
      INSERT INTO orchestration_runs
        (id, session_id, kind, status, phase)
      VALUES (?, ?, 'agent_retry', 'queued', 'retry')
    `).run(runId, sessionId)
    db.prepare(`
      INSERT INTO agent_invocations
        (id, session_id, parent_run_id, agent_variant_id, agent_snapshot,
         endpoint_id, model, additional_instruction, selection_reason, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')
    `).run(
      newInvocationId,
      sessionId,
      runId,
      source.agent_variant_id,
      source.agent_snapshot,
      source.endpoint_id,
      source.model,
      source.additional_instruction,
      `Retry of ${source.id}: ${source.selection_reason}`,
    )
    emitEvent(db, runId, sessionId, 'tool.called', {
      name: 'retry_agent',
      invocationId: source.id,
      newInvocationId,
    })
  })()
  const promise = executeInvocationRetry(
    db,
    runId,
    newInvocationId,
    source,
    session,
    snapshot,
  )
  running.set(runId, promise)
  void promise
  return { runId, invocationId: newInvocationId, afterEventId }
}
