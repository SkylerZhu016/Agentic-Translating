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
import {
  analyzePoetrySource,
  containsLyricSpecificRequest,
  poetryBoundaryMapText,
  poetrySettingsText,
  type PoetrySourceAnalysis,
} from '../poetry/analysis'
import { createRepositories } from '../db/repositories'
import { createVNextRepositories } from '../db/vnext-repositories'
import { createWorkspaceModelProfilesRepo } from '../db/release-config-repositories'
import { decryptSecret, encryptSecret } from '../security/secrets'

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
  final_version_id?: number | null
}

interface InvocationResult {
  id: string
  variant: AgentDirectionVariant
  body: string
  evidence: TranslationEvidenceReport
}

interface ContextAnalysisResult {
  id: string
  variant: AgentDirectionVariant
  model: string
  content: string
}

interface PoetryPlanResult {
  id: string
  model: string
  raw: string
  body: string
  annotation: string | null
  sourceAnalysis: PoetrySourceAnalysis
}

interface ResolvedEndpoint {
  id: number
  baseUrl: string
  chatCompletionsPath: string
  apiKey: string
  contextWindow: number | null
}

const running = new Map<string, Promise<void>>()

class RunPausedError extends Error {
  constructor() {
    super('run_paused')
    this.name = 'RunPausedError'
  }
}

function ensureRunControl(db: Database.Database, sessionId: string) {
  db.prepare(`
    INSERT OR IGNORE INTO session_run_controls (session_id)
    VALUES (?)
  `).run(sessionId)
}

function isPauseRequested(db: Database.Database, sessionId: string) {
  ensureRunControl(db, sessionId)
  return Boolean(
    (db.prepare(`
      SELECT pause_requested FROM session_run_controls WHERE session_id=?
    `).get(sessionId) as { pause_requested: number }).pause_requested,
  )
}

function assertRunMayContinue(db: Database.Database, sessionId: string) {
  if (isPauseRequested(db, sessionId)) throw new RunPausedError()
}

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

function contextAnalysisText(
  analyses: ContextAnalysisResult[],
  promptLanguage: 'zh' | 'en',
) {
  if (analyses.length === 0) {
    return promptLanguage === 'en'
      ? 'No pre-translation imagery analysis was available.'
      : '本次没有可用的前置意象分析。'
  }
  return analyses
    .map((analysis, index) =>
      promptLanguage === 'en'
        ? `Independent imagery analysis ${index + 1} (${analysis.model}):\n${analysis.content}`
        : `独立意象分析 ${index + 1}（${analysis.model}）：\n${analysis.content}`,
    )
    .join('\n\n')
}

function poetryPlanText(
  plan: PoetryPlanResult | null,
  promptLanguage: 'zh' | 'en',
) {
  if (!plan) {
    return promptLanguage === 'en'
      ? 'No specialist prosody and rhyme plan was produced.'
      : '本次没有生成可用的诗体与韵律规划。'
  }
  return promptLanguage === 'en'
    ? `Specialist prosody and rhyme plan (${plan.model}):\n${plan.body}`
    : `诗体与韵律专项规划（${plan.model}）：\n${plan.body}`
}

function poetryPlanBlock(
  plan: PoetryPlanResult | null,
  promptLanguage: 'zh' | 'en',
) {
  if (!plan) return ''
  return promptLanguage === 'en'
    ? `\n\nProsody and rhyme plan:\n${poetryPlanText(plan, 'en')}`
    : `\n\n诗体与韵律规划：\n${poetryPlanText(plan, 'zh')}`
}

interface StoredInvocation {
  id: string
  agent_snapshot: string
  model: string
  status: string
  raw_output: string | null
  body_output: string | null
  annotation_output: string | null
  replaces_invocation_id: string | null
  created_at: string
}

function loadCheckpointOutputs(
  db: Database.Database,
  session: SessionRecord,
  snapshot: ConfigSnapshot,
): {
  candidates: InvocationResult[]
  contextAnalyses: ContextAnalysisResult[]
  poetryPlan: PoetryPlanResult | null
} {
  const rows = db.prepare(`
    SELECT id, agent_snapshot, model, status, raw_output, body_output,
           annotation_output,
           replaces_invocation_id, created_at
    FROM agent_invocations
    WHERE session_id=?
    ORDER BY created_at, id
  `).all(session.id) as StoredInvocation[]
  const byId = new Map(rows.map((row) => [row.id, row]))
  const rootOf = (row: StoredInvocation) => {
    let current = row
    const visited = new Set<string>()
    while (
      current.replaces_invocation_id &&
      !visited.has(current.id)
    ) {
      visited.add(current.id)
      const parent = byId.get(current.replaces_invocation_id)
      if (!parent) break
      current = parent
    }
    return current.id
  }
  const latestSuccessfulByChain = new Map<string, StoredInvocation>()
  for (const row of rows) {
    if (row.status === 'complete' && row.body_output?.trim()) {
      latestSuccessfulByChain.set(rootOf(row), row)
    }
  }

  const candidates: InvocationResult[] = []
  const contextAnalyses: ContextAnalysisResult[] = []
  let poetryPlan: PoetryPlanResult | null = null
  for (const row of latestSuccessfulByChain.values()) {
    let variant: AgentDirectionVariant & { roleKind?: string }
    try {
      variant = JSON.parse(row.agent_snapshot) as AgentDirectionVariant & {
        roleKind?: string
      }
    } catch {
      continue
    }
    if (variant.roleKind === 'context_analysis') {
      contextAnalyses.push({
        id: row.id,
        variant,
        model: row.model,
        content: row.body_output!,
      })
      continue
    }
    if (variant.roleKind === 'poetry_plan') {
      poetryPlan = {
        id: row.id,
        model: row.model,
        raw: row.raw_output ?? row.body_output!,
        body: row.body_output!,
        annotation: row.annotation_output,
        sourceAnalysis: analyzePoetrySource({
          sourceText: session.source_text,
          taskBrief: session.task_brief,
          constraints: snapshot.constraints,
        }),
      }
      continue
    }
    if (variant.archetypeId === 'cultural-context') continue
    candidates.push({
      id: row.id,
      variant,
      body: row.body_output!,
      evidence: checkTranslationEvidence({
        direction: snapshot.direction ?? 'en_to_zh',
        sourceText: session.source_text,
        translatedText: row.body_output!,
        constraints: snapshot.constraints,
        reportLanguage: snapshot.promptBundleSnapshot?.promptLanguage,
      }),
    })
  }
  return { candidates, contextAnalyses, poetryPlan }
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
      chatCompletionsPath:
        modern.chatCompletionsPath ?? '/v1/chat/completions',
      apiKey: decryptSecret(modern.apiKey),
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
    chatCompletionsPath:
      legacy.chat_completions_path ?? '/v1/chat/completions',
    apiKey: decryptSecret(legacy.api_key),
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
    {
      baseUrl: endpoint.baseUrl,
      chatCompletionsPath: endpoint.chatCompletionsPath,
      apiKey: endpoint.apiKey,
    },
    { ...request, stream: request.stream ?? true },
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

type TeamSelection = {
  variant: AgentDirectionVariant
  additionalInstruction: string
  selectionReason: string
}

function looksLikeClassicalChinesePoetry(sourceText: string): boolean {
  const phrases = sourceText
    .split(/[，。！？；\n]+/u)
    .map((part) => part.trim())
    .filter(Boolean)
  if (phrases.length < 4) return false
  const verseLike = phrases.filter((phrase) => {
    const chineseChars = phrase.match(/\p{Script=Han}/gu)?.length ?? 0
    return chineseChars >= 4 && chineseChars <= 12 &&
      chineseChars / Math.max(Array.from(phrase).length, 1) >= 0.7
  })
  return verseLike.length / phrases.length >= 0.75
}

export function inferRequiredDynamicArchetypes(
  source: string,
  brief = '',
  constraints: ConfigSnapshot['constraints'] = {},
): string[] {
  const combined = `${brief}\n${source}`.toLowerCase()
  const isPoetry =
    /诗|词|曲|韵|格律|poem|poetry|verse|rhyme|meter/.test(combined) ||
    source.split(/\r?\n/).filter((line) => line.trim()).length >= 4 ||
    looksLikeClassicalChinesePoetry(source)
  if (
    constraints?.poetryMode !== 'off' &&
    (constraints?.poetryMode === 'on' || isPoetry)
  ) {
    return ['semantic-fidelity', 'poetry-form']
  }
  if (/法律|合同|政策|法规|合规|legal|contract|policy|regulat/.test(combined)) {
    return ['semantic-fidelity', 'formal-regulated']
  }
  if (/技术|学术|论文|术语|工程|technical|academic|terminolog|engineering/.test(combined)) {
    return ['semantic-fidelity', 'terminology']
  }
  if (/典故|宗教|民俗|文化|历史称谓|allusion|religion|folklore|cultural/.test(combined)) {
    return ['semantic-fidelity']
  }
  if (/小说|散文|戏剧|文学|叙事|novel|prose|drama|literary|narrative/.test(combined)) {
    return ['semantic-fidelity']
  }
  return ['semantic-fidelity', 'target-naturalness']
}

function enforceDynamicTeam(
  session: SessionRecord,
  allowed: AgentDirectionVariant[],
  selected: TeamSelection[],
  constraints: ConfigSnapshot['constraints'] = {},
) {
  const required = inferRequiredDynamicArchetypes(
    session.source_text,
    session.task_brief ?? '',
    constraints,
  )
  const result: typeof selected = []
  const selectedByArchetype = new Map(
    selected.map((item) => [item.variant.archetypeId, item]),
  )
  for (const archetypeId of required) {
    const existing = selectedByArchetype.get(archetypeId)
    const variant =
      existing?.variant ??
      allowed.find((candidate) => candidate.archetypeId === archetypeId)
    if (!variant || result.some((item) => item.variant.id === variant.id)) continue
    result.push(
      existing ?? {
        variant,
        additionalInstruction: '',
        selectionReason:
          /^en(?:glish)?$/i.test(session.target_lang)
            ? 'Required complementary role for this task profile'
            : '当前任务类型的必需互补角色',
      },
    )
  }
  for (const item of selected) {
    if (result.length >= 4) break
    if (result.some(
      (candidate) =>
        candidate.variant.archetypeId === item.variant.archetypeId,
    )) continue
    result.push(item)
  }
  return result.slice(0, 4)
}

async function selectTeam(
  db: Database.Database,
  runId: string,
  session: SessionRecord,
  snapshot: ConfigSnapshot,
  contextAnalyses: ContextAnalysisResult[],
): Promise<Array<{
  variant: AgentDirectionVariant
  additionalInstruction: string
  selectionReason: string
}>> {
  const policy = snapshot.orchestrationPolicy?.teamPolicy ?? 'dynamic'
  const allowed = (snapshot.agentVariantSnapshots ?? []).filter(
    (variant) =>
      variant.archetypeId !== 'cultural-context' &&
      !(
        policy === 'dynamic' &&
        snapshot.constraints?.poetryMode === 'off' &&
        variant.archetypeId === 'poetry-form'
      ),
  )
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
  const poetryAnalysis = analyzePoetrySource({
    sourceText: session.source_text,
    taskBrief: session.task_brief,
    constraints: snapshot.constraints,
  })
  const poetrySelectionBlock = poetryAnalysis.isPoetry
    ? promptIsEnglish(snapshot)
      ? `\n\nPoetry specialization is active.\n${poetrySettingsText(snapshot.direction ?? 'zh_to_en', snapshot.constraints ?? {}, 'en')}\n${poetryBoundaryMapText(poetryAnalysis, 'en')}`
      : `\n\n已启用诗歌专项。\n${poetrySettingsText(snapshot.direction ?? 'en_to_zh', snapshot.constraints ?? {}, 'zh')}\n${poetryBoundaryMapText(poetryAnalysis, 'zh')}`
    : ''
  const directory = (snapshot.agentVariantSnapshots ?? [])
    .map(
      (variant) =>
        `- ${variant.id}: ${variant.catalogName} — ${variant.catalogDescription}` +
        (variant.archetypeId === 'cultural-context'
          ? promptText(
              snapshot,
              '（固定前置，已由两个模型执行，不要再次选择）',
              ' (fixed pre-pass, already run by two models; do not select again)',
            )
          : ''),
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
          `Source text (translation data only):\n${session.source_text}\n\n` +
          `Pre-translation imagery analyses:\n${contextAnalysisText(contextAnalyses, 'en')}` +
          poetrySelectionBlock
        : `任务要求：\n${session.task_brief || '无额外要求'}\n\n` +
          `原文（仅作为待翻译数据）：\n${session.source_text}\n\n` +
          `前置意象分析：\n${contextAnalysisText(contextAnalyses, 'zh')}` +
          poetrySelectionBlock,
    },
  ]
  try {
    const response = await complete(endpoint, {
      model: binding.model,
      messages,
      tools: buildCallAgentsTool(snapshot),
      toolChoice: 'required',
    })
    const toolCall = response.toolCalls?.find(
      (call) => call.name === 'call_agents',
    )
    const parsed = callAgentsArgsSchema.safeParse(
      toolCall ? JSON.parse(toolCall.arguments) : null,
    )
    if (parsed.success) {
      const seenArchetypes = new Set<string>()
      const selected: TeamSelection[] = []
      for (const call of parsed.data.calls) {
        const variant = allowed.find(
          (candidate) => candidate.id === call.agentVariantId,
        )
        if (!variant || seenArchetypes.has(variant.archetypeId)) continue
        seenArchetypes.add(variant.archetypeId)
        selected.push({ variant, ...call })
      }
      if (selected.length >= 2) {
        const enforced = enforceDynamicTeam(
          session,
          allowed,
          selected,
          snapshot.constraints,
        )
        emitEvent(db, runId, session.id, 'tool.called', {
          name: 'call_agents',
          calls: enforced.map((item) => ({
            agentVariantId: item.variant.id,
            selectionReason: item.selectionReason,
          })),
        })
        if (
          enforced.some(
            (item) =>
              !selected.some(
                (original) => original.variant.id === item.variant.id,
              ),
          )
        ) {
          emitEvent(db, runId, session.id, 'team.adjusted', {
            reason: promptText(
              snapshot,
              '补足最低安全角色，其他角色仍由主 Agent 自主选择',
              'Added only the minimum safety role; all other roles remain the main agent choice',
            ),
            agentVariantIds: enforced.map((item) => item.variant.id),
          })
        }
        return enforced
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

async function runImageryPrepass(
  db: Database.Database,
  runId: string,
  session: SessionRecord,
  snapshot: ConfigSnapshot,
): Promise<ContextAnalysisResult[]> {
  const variant = (snapshot.agentVariantSnapshots ?? []).find(
    (candidate) => candidate.archetypeId === 'cultural-context',
  )
  if (!variant) {
    emitEvent(db, runId, session.id, 'team.fallback', {
      reason: '当前方向未启用意象与文化助手，跳过前置分析',
    })
    return []
  }

  const possibleBindings = [
    snapshot.modelBindings?.defaultWorker,
    snapshot.modelBindings?.mainAgent,
    snapshot.modelBindings?.editingAgent,
  ].filter(
    (binding): binding is ModelBinding =>
      Boolean(binding?.model && binding.endpointId != null),
  )
  const distinctBindings: ModelBinding[] = []
  for (const binding of possibleBindings) {
    if (distinctBindings.some((item) => item.model === binding.model)) continue
    distinctBindings.push(binding)
  }
  const bindings = distinctBindings.slice(0, 2)
  if (bindings.length < 2) {
    emitEvent(db, runId, session.id, 'team.fallback', {
      reason: '前置意象分析未找到两个不同模型，已按可用模型降级',
      modelCount: bindings.length,
    })
  }
  if (bindings.length === 0) return []

  emitEvent(db, runId, session.id, 'agent.batch.started', {
    roleKind: 'context_analysis',
    agentVariantIds: bindings.map(() => variant.id),
    models: bindings.map((binding) => binding.model),
  })

  const jobs = bindings.map(async (
    binding,
    index,
  ): Promise<ContextAnalysisResult | null> => {
    const endpoint = resolveEndpoint(snapshot, binding.endpointId)
    const invocationId: string = randomUUID()
    const snapshotWithRole = {
      ...variant,
      roleKind: 'context_analysis',
      analysisIndex: index + 1,
    }
    db.prepare(`
      INSERT INTO agent_invocations
        (id, session_id, parent_run_id, agent_variant_id, agent_snapshot,
         endpoint_id, model, additional_instruction, selection_reason, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, 'running')
    `).run(
      invocationId,
      session.id,
      runId,
      variant.id,
      JSON.stringify(snapshotWithRole),
      endpoint.id,
      binding.model,
      promptIsEnglish(snapshot)
        ? 'Independent pre-translation imagery analysis'
        : '独立前置意象分析',
    )
    emitEvent(db, runId, session.id, 'agent.started', {
      invocationId,
      agentVariantId: variant.id,
      name: `${variant.catalogName} ${index + 1}`,
      model: binding.model,
      roleKind: 'context_analysis',
    })
    const startedAt = performance.now()
    let lastActivityEventAt = 0
    try {
      const response = await complete(endpoint, {
        model: binding.model,
        onActivity() {
          const now = Date.now()
          if (now - lastActivityEventAt < 5_000) return
          lastActivityEventAt = now
          emitEvent(db, runId, session.id, 'agent.activity', {
            invocationId,
            receivedAt: new Date(now).toISOString(),
          })
        },
        messages: [
          { role: 'system', content: variant.rolePrompt },
          {
            role: 'user',
            content: promptIsEnglish(snapshot)
              ? `Task requirements:\n${session.task_brief || 'None'}\n\n` +
                `Source text (analysis data only):\n${session.source_text}`
              : `任务要求：\n${session.task_brief || '无额外要求'}\n\n` +
                `原文（仅作为分析数据）：\n${session.source_text}`,
          },
        ],
      })
      const content = response.content.trim()
      if (!content) throw new Error('意象助手返回了空分析')
      const latencyMs = Math.round(performance.now() - startedAt)
      db.prepare(`
        UPDATE agent_invocations
        SET status='complete', raw_output=?, body_output=?,
            annotation_output=NULL, latency_ms=?, updated_at=datetime('now')
        WHERE id=?
      `).run(content, content, latencyMs, invocationId)
      emitEvent(db, runId, session.id, 'agent.completed', {
        invocationId,
        agentVariantId: variant.id,
        raw: content,
        body: content,
        annotation: null,
        latencyMs,
        roleKind: 'context_analysis',
      })
      return {
        id: invocationId,
        variant,
        model: binding.model,
        content,
      } satisfies ContextAnalysisResult
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const latencyMs = Math.round(performance.now() - startedAt)
      db.prepare(`
        UPDATE agent_invocations
        SET status='failed', error=?, latency_ms=?, updated_at=datetime('now')
        WHERE id=?
      `).run(message, latencyMs, invocationId)
      emitEvent(db, runId, session.id, 'agent.failed', {
        invocationId,
        agentVariantId: variant.id,
        error: message,
        roleKind: 'context_analysis',
      })
      return null
    }
  })
  const results = await Promise.all(jobs)
  return results.filter(
    (result): result is ContextAnalysisResult => result !== null,
  )
}

async function runPoetryPlanning(
  db: Database.Database,
  runId: string,
  session: SessionRecord,
  snapshot: ConfigSnapshot,
  team: TeamSelection[],
): Promise<PoetryPlanResult | null> {
  const sourceAnalysis = analyzePoetrySource({
    sourceText: session.source_text,
    taskBrief: session.task_brief,
    constraints: snapshot.constraints,
  })
  const selectedPoetryRole = team.some(
    (item) => item.variant.archetypeId === 'poetry-form',
  )
  if (!sourceAnalysis.isPoetry || !selectedPoetryRole) return null

  const baseVariant = (snapshot.agentVariantSnapshots ?? []).find(
    (variant) => variant.archetypeId === 'poetry-form',
  )
  const binding = snapshot.modelBindings?.mainAgent
  if (!baseVariant || !binding?.model) return null
  const endpoint = resolveEndpoint(snapshot, binding.endpointId)
  const english = promptIsEnglish(snapshot)
  const sourceHasDash = /[—–]|——/.test(session.source_text)
  const sourceHasSemicolon = /[;；]/.test(session.source_text)
  const punctuationInstruction = english
    ? `Source punctuation audit: dash=${sourceHasDash ? 'present' : 'absent'}, semicolon=${sourceHasSemicolon ? 'present' : 'absent'}.
Do not recommend or introduce a dash or semicolon when it is absent from the source. For a continuing poetic line, prefer a comma, an open line ending, or enjambment.`
    : `原文标点检查：破折号=${sourceHasDash ? '存在' : '不存在'}，分号=${sourceHasSemicolon ? '存在' : '不存在'}。
原文不存在某类标点时，不得建议或新增该类破折号或分号；诗行尚未收束时优先使用逗号、开放行末或跨行延续。`
  const rolePrompt = english
    ? `You are the Prosody and Rhyme Planner for a difficult Chinese-to-English poetry translation.
Do not translate the complete poem. Produce a concise, executable planning document for independent translators: identify form, stanza and line structure, syntactic continuation across line breaks, rhyme positions, rhyme scheme, acceptable exact or near-rhyme policy, rhythm priorities, and likely trade-offs.
Do not prescribe one mandatory set of ending words. Preserve room for genuinely different candidate translations. Never add unsupported meaning merely to force rhyme. A line break is not automatically a full stop: preserve continuation and enjambment when the source continues.
${punctuationInstruction}
Lyric singability, melody fitting, and syllable-to-note alignment are outside the current product scope.
Write freely. Optional human notes may follow a standalone "---" line.`
    : `你是高难诗歌翻译的“诗体与韵律规划助手”。
不要直接翻译全诗。请为多个独立译者形成简洁、可执行的规划：识别诗体、分节、诗行、跨行句法延续、韵位、韵式、普通话或平水韵规则、节奏优先级与可能的取舍。
不要预先锁死唯一一组韵脚字，应保留多个候选译法的真实差异；不得为了押韵添加原文没有的含义。换行不自动等于句号：原文仍然延续时，应保留逗号、开放行或跨行延续。
${punctuationInstruction}
歌词可唱性、旋律适配和音符级音节对齐不在当前产品范围内。
自由输出；可在独立一行“---”之后添加仅供用户查看的注释。`
  const plannerVariant = {
    ...baseVariant,
    id:
      snapshot.direction === 'zh_to_en'
        ? 'prosody-rhyme-planner.zh-to-en'
        : 'prosody-rhyme-planner.en-to-zh',
    archetypeId: 'prosody-rhyme-planner',
    catalogName: english
      ? 'Prosody and Rhyme Planner'
      : '诗体与韵律规划助手',
    catalogDescription: english
      ? 'Plans lineation, syntactic continuation, rhyme positions, rhyme scheme, and rhythm before candidate translation.'
      : '在候选翻译前规划诗行、句法延续、韵位、韵式和节奏。',
    rolePrompt,
    roleKind: 'poetry_plan',
  }
  const invocationId = randomUUID()
  db.prepare(`
    INSERT INTO agent_invocations
      (id, session_id, parent_run_id, agent_variant_id, agent_snapshot,
       endpoint_id, model, additional_instruction, selection_reason, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, 'running')
  `).run(
    invocationId,
    session.id,
    runId,
    plannerVariant.id,
    JSON.stringify(plannerVariant),
    endpoint.id,
    binding.model,
    english
      ? 'Poetry-only specialist pre-translation planning'
      : '仅在诗歌任务中执行的前置专项规划',
  )
  emitEvent(db, runId, session.id, 'agent.started', {
    invocationId,
    agentVariantId: plannerVariant.id,
    name: plannerVariant.catalogName,
    model: binding.model,
    roleKind: 'poetry_plan',
  })
  emitEvent(db, runId, session.id, 'poetry.plan.started', {
    invocationId,
    reason: sourceAnalysis.reason,
  })
  const startedAt = performance.now()
  let lastActivityEventAt = 0
  try {
    const lyricNotice = containsLyricSpecificRequest(
      session.source_text,
      session.task_brief,
    )
      ? english
        ? '\n\nA lyric-related signal was detected. Do not claim melody or singability alignment; handle it only as poetic text.'
        : '\n\n检测到歌词相关信号。不得声称完成旋律或可唱性适配，本轮只按诗歌文本处理。'
      : ''
    const response = await complete(endpoint, {
      model: binding.model,
      onActivity() {
        const now = Date.now()
        if (now - lastActivityEventAt < 5_000) return
        lastActivityEventAt = now
        emitEvent(db, runId, session.id, 'agent.activity', {
          invocationId,
          receivedAt: new Date(now).toISOString(),
        })
      },
      messages: [
        { role: 'system', content: rolePrompt },
        {
          role: 'user',
          content:
            (english
              ? `Task requirements:\n${session.task_brief || 'None'}\n\n` +
                `${poetrySettingsText(snapshot.direction ?? 'zh_to_en', snapshot.constraints ?? {}, 'en')}\n\n` +
                `Source line and boundary analysis:\n${poetryBoundaryMapText(sourceAnalysis, 'en')}\n\n` +
                `Source text (planning data only):\n${session.source_text}`
              : `任务要求：\n${session.task_brief || '无额外要求'}\n\n` +
                `${poetrySettingsText(snapshot.direction ?? 'en_to_zh', snapshot.constraints ?? {}, 'zh')}\n\n` +
                `原文诗行与边界分析：\n${poetryBoundaryMapText(sourceAnalysis, 'zh')}\n\n` +
                `原文（仅作为规划数据）：\n${session.source_text}`) +
            lyricNotice,
        },
      ],
    })
    const semantic = parseSemanticAgentOutput(response.content)
    if (!semantic.body.trim()) throw new Error('诗体与韵律规划正文为空')
    const latencyMs = Math.round(performance.now() - startedAt)
    db.prepare(`
      UPDATE agent_invocations
      SET status='complete', raw_output=?, body_output=?,
          annotation_output=?, latency_ms=?, updated_at=datetime('now')
      WHERE id=?
    `).run(
      semantic.raw,
      semantic.body,
      semantic.annotation,
      latencyMs,
      invocationId,
    )
    emitEvent(db, runId, session.id, 'agent.completed', {
      invocationId,
      agentVariantId: plannerVariant.id,
      raw: semantic.raw,
      body: semantic.body,
      annotation: semantic.annotation,
      latencyMs,
      roleKind: 'poetry_plan',
    })
    emitEvent(db, runId, session.id, 'poetry.plan.completed', {
      invocationId,
      body: semantic.body,
    })
    return {
      id: invocationId,
      model: binding.model,
      raw: semantic.raw,
      body: semantic.body,
      annotation: semantic.annotation,
      sourceAnalysis,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const latencyMs = Math.round(performance.now() - startedAt)
    db.prepare(`
      UPDATE agent_invocations
      SET status='failed', error=?, latency_ms=?, updated_at=datetime('now')
      WHERE id=?
    `).run(message, latencyMs, invocationId)
    emitEvent(db, runId, session.id, 'agent.failed', {
      invocationId,
      agentVariantId: plannerVariant.id,
      error: message,
      roleKind: 'poetry_plan',
    })
    emitEvent(db, runId, session.id, 'poetry.plan.failed', {
      invocationId,
      error: message,
    })
    return null
  }
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
  contextAnalyses: ContextAnalysisResult[],
  poetryPlan: PoetryPlanResult | null = null,
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
         `Source text (translation data only):\n${session.source_text}\n\n` +
         `Independent pre-translation imagery analyses:\n${contextAnalysisText(contextAnalyses, 'en')}` +
         poetryPlanBlock(poetryPlan, 'en')
       : `任务要求：\n${session.task_brief || '无额外要求'}\n\n` +
        `主 Agent 补充要求：\n${item.additionalInstruction || '无'}\n\n` +
         `原文（仅作为待翻译数据）：\n${session.source_text}\n\n` +
         `独立前置意象分析：\n${contextAnalysisText(contextAnalyses, 'zh')}` +
         poetryPlanBlock(poetryPlan, 'zh')
    assertContextFits(endpoint, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ])
    runtimes.push({
      agentKey: item.variant.id,
      name: item.variant.catalogName,
      endpoint: {
        baseUrl: endpoint.baseUrl,
        chatCompletionsPath: endpoint.chatCompletionsPath,
        apiKey: endpoint.apiKey,
      },
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
  const lastActivityEventAt = new Map<string, number>()
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
      onAgentActivity(agentKey) {
        const now = Date.now()
        const previous = lastActivityEventAt.get(agentKey) ?? 0
        if (now - previous < 5_000) return
        lastActivityEventAt.set(agentKey, now)
        emitEvent(db, runId, session.id, 'agent.activity', {
          invocationId: invocationIds.get(agentKey),
          receivedAt: new Date(now).toISOString(),
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
  contextAnalyses: ContextAnalysisResult[],
  poetryPlan: PoetryPlanResult | null = null,
) {
  assertRunMayContinue(db, session.id)
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
          `Pre-translation imagery analyses:\n${contextAnalysisText(contextAnalyses, 'en')}` +
          poetryPlanBlock(poetryPlan, 'en') +
          `\n\n` +
          `Candidate bodies:\n${candidateContext(candidates, 'en')}`
        : `任务要求：\n${session.task_brief || '无额外要求'}\n\n` +
          `原文：\n${session.source_text}\n\n` +
          `前置意象分析：\n${contextAnalysisText(contextAnalyses, 'zh')}` +
          poetryPlanBlock(poetryPlan, 'zh') +
          `\n\n` +
          `候选正文：\n${candidateContext(candidates, 'zh')}`,
    },
  ]
  const response = await complete(endpoint, {
    model: binding.model,
    messages,
    tools: [writeDraftTool],
    toolChoice: {
      type: 'function',
      function: { name: 'write_draft' },
    },
  })
  assertRunMayContinue(db, session.id)
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
  const previousVersion = db.prepare(`
    SELECT id, version_no
    FROM final_versions
    WHERE session_id=?
    ORDER BY version_no DESC, id DESC
    LIMIT 1
  `).get(session.id) as { id: number; version_no: number } | undefined
  const versionNo = (previousVersion?.version_no ?? 0) + 1
  const hash = createHash('sha256').update(parsed.data.text).digest('hex')
  const result = db.prepare(`
    INSERT INTO final_versions
      (session_id, version_no, text, source, parent_version_id, content_hash)
    VALUES (?, ?, ?, 'main_draft', ?, ?)
  `).run(
    session.id,
    versionNo,
    parsed.data.text,
    previousVersion?.id ?? null,
    hash,
  )
  const versionId = Number(result.lastInsertRowid)
  emitEvent(db, runId, session.id, 'version.created', {
    versionId,
    versionNo,
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
    toolChoice: {
      type: 'function',
      function: { name: 'submit_final' },
    },
  })
  assertRunMayContinue(db, session.id)
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
  ensureRunControl(db, session.id)
  db.prepare(`
    UPDATE session_run_controls
    SET candidates_stale=0, updated_at=datetime('now')
    WHERE session_id=?
  `).run(session.id)
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
  contextAnalyses: ContextAnalysisResult[],
  poetryPlan: PoetryPlanResult | null = null,
  reuseCompletedStages = true,
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
  const storedStages = reuseCompletedStages
    ? db.prepare(`
        SELECT stage, raw_output
        FROM stage_outputs
        WHERE session_id=? AND status='complete' AND raw_output IS NOT NULL
      `).all(session.id) as Array<{ stage: Stage; raw_output: string }>
    : []
  for (const stored of storedStages) {
    prior[stored.stage] = parseSemanticAgentOutput(stored.raw_output).body
  }
  db.prepare(
    "UPDATE sessions SET state='coordinating', updated_at=datetime('now') WHERE id=?",
  ).run(session.id)
  for (const stage of ['review', 'filter', 'orchestrate', 'assemble'] as Stage[]) {
    assertRunMayContinue(db, session.id)
    if (prior[stage]?.trim()) {
      emitEvent(db, runId, session.id, 'stage.resumed', { stage })
      continue
    }
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
               `Pre-translation imagery analyses:\n${contextAnalysisText(contextAnalyses, 'en')}` +
               poetryPlanBlock(poetryPlan, 'en') +
               `\n\n` +
               `Candidate bodies:\n${candidateContext(candidates, 'en')}\n\n` +
              `Prior stage bodies:\n${Object.entries(prior)
                .map(([name, body]) => `${name}:\n${body}`)
                .join('\n\n')}`
            : `任务要求：\n${session.task_brief || '无'}\n\n` +
              `原文：\n${session.source_text}\n\n` +
               `前置意象分析：\n${contextAnalysisText(contextAnalyses, 'zh')}` +
               poetryPlanBlock(poetryPlan, 'zh') +
               `\n\n` +
               `候选正文：\n${candidateContext(candidates, 'zh')}\n\n` +
              `前置阶段正文：\n${Object.entries(prior)
                .map(([name, body]) => `${name}:\n${body}`)
                .join('\n\n')}`,
        },
      ],
    })
    assertRunMayContinue(db, session.id)
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
  const previousVersion = db.prepare(`
    SELECT id, version_no FROM final_versions
    WHERE session_id=?
    ORDER BY version_no DESC, id DESC LIMIT 1
  `).get(session.id) as { id: number; version_no: number } | undefined
  const versionNo = (previousVersion?.version_no ?? 0) + 1
  const hash = createHash('sha256').update(finalText).digest('hex')
  const result = db.prepare(`
    INSERT INTO final_versions
      (session_id, version_no, text, source, parent_version_id, content_hash)
    VALUES (?, ?, ?, 'assemble', ?, ?)
  `).run(
    session.id,
    versionNo,
    finalText,
    previousVersion?.id ?? null,
    hash,
  )
  const versionId = Number(result.lastInsertRowid)
  db.prepare(
    "UPDATE sessions SET final_version_id=?, state='assembled', updated_at=datetime('now') WHERE id=?",
  ).run(versionId, session.id)
  emitEvent(db, runId, session.id, 'version.created', {
    versionId,
    versionNo,
    source: 'assemble',
  })
  ensureRunControl(db, session.id)
  db.prepare(`
    UPDATE session_run_controls
    SET candidates_stale=0, updated_at=datetime('now')
    WHERE session_id=?
  `).run(session.id)
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
    const checkpoint = loadCheckpointOutputs(db, session, snapshot)
    let contextAnalyses = checkpoint.contextAnalyses
    let candidates = checkpoint.candidates
    let poetryPlan = checkpoint.poetryPlan
    let team: TeamSelection[] = []
    if (candidates.length >= 2) {
      emitEvent(db, runId, session.id, 'run.resumed', {
        checkpoint: 'candidates_complete',
        candidateInvocationIds: candidates.map((candidate) => candidate.id),
      })
    } else {
      if (contextAnalyses.length > 0) {
        emitEvent(db, runId, session.id, 'run.resumed', {
          checkpoint: 'context_analysis_complete',
          analysisInvocationIds: contextAnalyses.map((analysis) => analysis.id),
        })
      } else {
        contextAnalyses = await runImageryPrepass(
          db,
          runId,
          session,
          snapshot,
        )
      }
      assertRunMayContinue(db, session.id)
      team = await selectTeam(
        db,
        runId,
        session,
        snapshot,
        contextAnalyses,
      )
      assertRunMayContinue(db, session.id)
      const completedArchetypes = new Set(
        candidates.map((candidate) => candidate.variant.archetypeId),
      )
      team = team.filter(
        (item) => !completedArchetypes.has(item.variant.archetypeId),
      )
      if (!poetryPlan) {
        poetryPlan = await runPoetryPlanning(
          db,
          runId,
          session,
          snapshot,
          team,
        )
      } else {
        emitEvent(db, runId, session.id, 'run.resumed', {
          checkpoint: 'poetry_plan_complete',
          poetryPlanInvocationId: poetryPlan.id,
        })
      }
      assertRunMayContinue(db, session.id)
      if (team.length > 0) {
        candidates = candidates.concat(
          await callTeam(
            db,
            runId,
            session,
            snapshot,
            team,
            contextAnalyses,
            poetryPlan,
          ),
        )
      }
    }
    if (candidates.length < 2) {
      const usedArchetypes = new Set(
        candidates.map((candidate) => candidate.variant.archetypeId),
      )
      const supplement = (snapshot.agentVariantSnapshots ?? []).find(
        (variant) => variant.archetypeId !== 'cultural-context' &&
          !usedArchetypes.has(variant.archetypeId) &&
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
          }], contextAnalyses, poetryPlan),
        )
      }
    }
    if (candidates.length < 2) {
      throw new Error('少于两个不同 Agent 原型成功，不能建立第一版成稿')
    }
    db.prepare(
      "UPDATE sessions SET state='translated', updated_at=datetime('now') WHERE id=?",
    ).run(session.id)
    assertRunMayContinue(db, session.id)
    const reviewMode =
      snapshot.orchestrationPolicy?.reviewMode ?? 'main_editor'
    if (reviewMode === 'four_stage') {
      await runFourStages(
        db,
        runId,
        session,
        snapshot,
        candidates,
        contextAnalyses,
        poetryPlan,
      )
    } else {
      await createMainDraft(
        db,
        runId,
        session,
        snapshot,
        candidates,
        contextAnalyses,
        poetryPlan,
      )
    }
    db.prepare(`
      UPDATE orchestration_runs
      SET status='complete', phase='complete', completed_at=datetime('now')
      WHERE id=?
    `).run(runId)
    emitEvent(db, runId, session.id, 'session.completed')
  } catch (error) {
    try {
      const snapshot = JSON.parse(session.config_snapshot) as ConfigSnapshot
      const checkpoint = loadCheckpointOutputs(db, session, snapshot)
      db.prepare(`
        UPDATE sessions
        SET state=?, updated_at=datetime('now')
        WHERE id=? AND final_version_id IS NULL
      `).run(
        checkpoint.candidates.length >= 2 ? 'translated' : 'draft',
        session.id,
      )
    } catch {
      // Recovery state is best-effort; the run error remains the source of truth.
    }
    if (error instanceof RunPausedError) {
      db.prepare(`
        UPDATE orchestration_runs
        SET status='interrupted', phase='paused', error=NULL,
            completed_at=datetime('now')
        WHERE id=?
      `).run(runId)
      emitEvent(db, runId, session.id, 'run.paused', {
        checkpoint: 'before_next_stage',
      })
      return
    }
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

export function requestVNextPause(
  db: Database.Database,
  sessionId: string,
): { pauseRequested: true } {
  const active = db.prepare(`
    SELECT id FROM orchestration_runs
    WHERE session_id=? AND status IN ('queued','running')
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(sessionId) as { id: string } | undefined
  if (!active) throw new Error('no_active_run')
  ensureRunControl(db, sessionId)
  db.prepare(`
    UPDATE session_run_controls
    SET pause_requested=1, updated_at=datetime('now')
    WHERE session_id=?
  `).run(sessionId)
  emitEvent(db, active.id, sessionId, 'run.pause.requested')
  return { pauseRequested: true }
}

async function executeDraftRegeneration(
  db: Database.Database,
  runId: string,
  session: SessionRecord,
) {
  try {
    db.prepare(`
      UPDATE orchestration_runs
      SET status='running', phase='draft', started_at=datetime('now')
      WHERE id=?
    `).run(runId)
    const snapshot = JSON.parse(session.config_snapshot) as ConfigSnapshot
    if (snapshot.version !== 3) throw new Error('not_vnext_session')
    const { candidates, contextAnalyses, poetryPlan } = loadCheckpointOutputs(
      db,
      session,
      snapshot,
    )
    if (candidates.length < 2) {
      throw new Error('少于两个最新成功候选，不能重刷证据化初稿')
    }
    emitEvent(db, runId, session.id, 'draft.regeneration.started', {
      candidateInvocationIds: candidates.map((candidate) => candidate.id),
    })
    const reviewMode =
      snapshot.orchestrationPolicy?.reviewMode ?? 'main_editor'
    if (reviewMode === 'four_stage') {
      await runFourStages(
        db,
        runId,
        session,
        snapshot,
        candidates,
        contextAnalyses,
        poetryPlan,
        false,
      )
    } else {
      await createMainDraft(
        db,
        runId,
        session,
        snapshot,
        candidates,
        contextAnalyses,
        poetryPlan,
      )
    }
    db.prepare(`
      UPDATE orchestration_runs
      SET status='complete', phase='complete', completed_at=datetime('now')
      WHERE id=?
    `).run(runId)
    emitEvent(db, runId, session.id, 'draft.regenerated')
    emitEvent(db, runId, session.id, 'session.completed')
  } catch (error) {
    if (error instanceof RunPausedError) {
      db.prepare(`
        UPDATE orchestration_runs
        SET status='interrupted', phase='paused', error=NULL,
            completed_at=datetime('now')
        WHERE id=?
      `).run(runId)
      emitEvent(db, runId, session.id, 'run.paused', {
        checkpoint: 'draft_regeneration',
      })
      return
    }
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

export function startVNextDraftRegeneration(
  db: Database.Database,
  sessionId: string,
): { runId: string } {
  const active = db.prepare(`
    SELECT 1 FROM orchestration_runs
    WHERE session_id=? AND status IN ('queued','running') LIMIT 1
  `).get(sessionId)
  if (active) throw new Error('session_run_still_active')
  const session = db.prepare(
    'SELECT * FROM sessions WHERE id=?',
  ).get(sessionId) as SessionRecord | undefined
  if (!session) throw new Error('session_not_found')
  if (!['translated', 'assembled', 'refining'].includes(session.state)) {
    throw new Error(`invalid_session_state:${session.state}`)
  }
  ensureRunControl(db, sessionId)
  db.prepare(`
    UPDATE session_run_controls
    SET pause_requested=0, updated_at=datetime('now')
    WHERE session_id=?
  `).run(sessionId)
  const runId = randomUUID()
  db.prepare(`
    INSERT INTO orchestration_runs (id, session_id, kind, status, phase)
    VALUES (?, ?, 'draft_regeneration', 'queued', 'draft')
  `).run(runId, sessionId)
  const promise = executeDraftRegeneration(db, runId, session)
  running.set(runId, promise)
  void promise
  return { runId }
}

export function restartVNextSession(
  db: Database.Database,
  sessionId: string,
): { sessionId: string; runId: string } {
  const source = db.prepare(
    'SELECT * FROM sessions WHERE id=?',
  ).get(sessionId) as (SessionRecord & {
    direction?: string
    review_mode?: string
    preset_revision_id?: string | null
  }) | undefined
  if (!source) throw new Error('session_not_found')
  const newSessionId = randomUUID()
  db.prepare(`
    INSERT INTO sessions
      (id, source_text, source_lang, target_lang, state, config_snapshot,
       direction, task_brief, review_mode, preset_revision_id,
       client_request_id)
    VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)
  `).run(
    newSessionId,
    source.source_text,
    source.source_lang,
    source.target_lang,
    source.config_snapshot,
    source.direction ?? 'en_to_zh',
    source.task_brief ?? '',
    source.review_mode ?? 'main_editor',
    source.preset_revision_id ?? null,
    randomUUID(),
  )
  const { runId } = startVNextRun(db, newSessionId)
  return { sessionId: newSessionId, runId }
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
  if (!['draft', 'translated', 'translating', 'coordinating'].includes(session.state)) {
    throw new Error(`invalid_session_state:${session.state}`)
  }
  ensureRunControl(db, sessionId)
  db.prepare(`
    UPDATE session_run_controls
    SET pause_requested=0, updated_at=datetime('now')
    WHERE session_id=?
  `).run(sessionId)
  const runId = randomUUID()
  db.prepare(`
    INSERT INTO orchestration_runs (id, session_id, status, phase)
    VALUES (?, ?, 'queued', ?)
  `).run(runId, sessionId, session.state === 'translated' ? 'resume' : 'team')
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
  const variant = JSON.parse(source.agent_snapshot) as AgentDirectionVariant & {
    roleKind?: string
    analysisIndex?: number
  }
  const isContextAnalysis = variant.roleKind === 'context_analysis'
  const isPoetryPlan = variant.roleKind === 'poetry_plan'
  const isAuxiliary = isContextAnalysis || isPoetryPlan
  const endpoint = resolveEndpoint(snapshot, source.endpoint_id)
  const system = isAuxiliary
    ? variant.rolePrompt
    : `${snapshot.promptBundleSnapshot?.workerBasePrompt ?? ''}\n\n` +
      variant.rolePrompt
  const user = isContextAnalysis
    ? promptIsEnglish(snapshot)
      ? `Task requirements:\n${session.task_brief || 'None'}\n\n` +
        `Source text (analysis data only):\n${session.source_text}`
      : `任务要求：\n${session.task_brief || '无额外要求'}\n\n` +
        `原文（仅作为分析数据）：\n${session.source_text}`
    : isPoetryPlan
      ? (() => {
          const analysis = analyzePoetrySource({
            sourceText: session.source_text,
            taskBrief: session.task_brief,
            constraints: snapshot.constraints,
          })
          return promptIsEnglish(snapshot)
            ? `Task requirements:\n${session.task_brief || 'None'}\n\n` +
                `${poetrySettingsText(snapshot.direction ?? 'zh_to_en', snapshot.constraints ?? {}, 'en')}\n\n` +
                `Source line and boundary analysis:\n${poetryBoundaryMapText(analysis, 'en')}\n\n` +
                `Source text (planning data only):\n${session.source_text}`
            : `任务要求：\n${session.task_brief || '无额外要求'}\n\n` +
                `${poetrySettingsText(snapshot.direction ?? 'en_to_zh', snapshot.constraints ?? {}, 'zh')}\n\n` +
                `原文诗行与边界分析：\n${poetryBoundaryMapText(analysis, 'zh')}\n\n` +
                `原文（仅作为规划数据）：\n${session.source_text}`
        })()
      : promptIsEnglish(snapshot)
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
      name: isContextAnalysis
        ? `${variant.catalogName} ${variant.analysisIndex ?? ''}`.trim()
        : variant.catalogName,
      model: source.model,
      roleKind: variant.roleKind,
    })
    const startedAt = performance.now()
    let lastActivityEventAt = 0
    const summary = await runFanOut(
      [{
        agentKey: variant.id,
        name: variant.catalogName,
        endpoint: {
          baseUrl: endpoint.baseUrl,
          chatCompletionsPath: endpoint.chatCompletionsPath,
          apiKey: endpoint.apiKey,
        },
        model: source.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }],
      {
        onAgentActivity() {
          const now = Date.now()
          if (now - lastActivityEventAt < 5_000) return
          lastActivityEventAt = now
          emitEvent(db, runId, session.id, 'agent.activity', {
            invocationId: newInvocationId,
            receivedAt: new Date(now).toISOString(),
          })
        },
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
    const semantic = isContextAnalysis
      ? {
          raw: result.content ?? '',
          body: result.content ?? '',
          annotation: null,
        }
      : parseSemanticAgentOutput(result.content ?? '')
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
      roleKind: variant.roleKind,
    })
    if (!isAuxiliary) {
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
    }
    const completed = db.prepare(`
      SELECT agent_snapshot
      FROM agent_invocations
      WHERE session_id=? AND status='complete'
    `).all(session.id) as Array<{ agent_snapshot: string }>
    const archetypes = new Set(
      completed.flatMap((item) => {
        try {
          const parsed = JSON.parse(item.agent_snapshot) as AgentDirectionVariant & {
            roleKind?: string
          }
          return parsed.archetypeId && !parsed.roleKind
            ? [parsed.archetypeId]
            : []
        } catch {
          return []
        }
      }),
    )
    db.prepare(`
      UPDATE sessions
      SET state=?, updated_at=datetime('now')
      WHERE id=?
    `).run(
      session.final_version_id != null
        ? 'assembled'
        : archetypes.size >= 2
          ? 'translated'
          : 'draft',
      session.id,
    )
    ensureRunControl(db, session.id)
    db.prepare(`
      UPDATE session_run_controls
      SET candidates_stale=1, updated_at=datetime('now')
      WHERE session_id=?
    `).run(session.id)
    emitEvent(db, runId, session.id, 'candidates.updated', {
      invocationId: newInvocationId,
      finalVersionIsStale: session.final_version_id != null,
    })
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
  configMode: 'frozen' | 'current' = 'frozen',
  allowParallel = false,
): {
  runId: string
  invocationId: string
  afterEventId: number
} {
  const session = db.prepare(
    'SELECT * FROM sessions WHERE id=?',
  ).get(sessionId) as SessionRecord | undefined
  if (!session) throw new Error('session_not_found')
  const frozenSnapshot = JSON.parse(session.config_snapshot) as ConfigSnapshot
  let snapshot = frozenSnapshot
  if (frozenSnapshot.version !== 3) throw new Error('not_vnext_session')
  const frozenSource = db.prepare(`
    SELECT * FROM agent_invocations
    WHERE id=? AND session_id=?
  `).get(invocationId, sessionId) as InvocationRetryRow | undefined
  if (!frozenSource) throw new Error('invocation_not_found')
  if (!['complete', 'failed', 'interrupted'].includes(frozenSource.status)) {
    throw new Error(`invocation_not_retryable:${frozenSource.status}`)
  }
  let source = frozenSource
  if (configMode === 'current') {
    const currentRepos = createVNextRepositories(db)
    const variant = currentRepos.agents.getVariant(frozenSource.agent_variant_id)
    if (!variant || !variant.enabled) throw new Error('current_agent_unavailable')
    if (variant.direction !== frozenSnapshot.direction) {
      throw new Error('current_agent_direction_mismatch')
    }
    const endpoints = createRepositories(db).endpoints.list()
    const profile = createWorkspaceModelProfilesRepo(db).get(
      frozenSnapshot.direction ?? 'en_to_zh',
    )
    const promptBundle = currentRepos.directionPrompts.getLatest(
      frozenSnapshot.direction ?? 'en_to_zh',
    )
    snapshot = {
      ...frozenSnapshot,
      promptBundleSnapshot:
        promptBundle ?? frozenSnapshot.promptBundleSnapshot,
      agentVariantSnapshots: [variant],
      endpointSnapshots: endpoints.map((endpoint) => ({
        id: endpoint.id,
        name: endpoint.name,
        baseUrl: endpoint.base_url,
        chatCompletionsPath:
          endpoint.chat_completions_path ?? '/v1/chat/completions',
        apiKey: encryptSecret(endpoint.api_key),
        hasApiKey: Boolean(endpoint.api_key),
        contextWindow: endpoint.context_window ?? null,
      })),
      modelBindings: {
        ...frozenSnapshot.modelBindings!,
        defaultWorker:
          profile?.defaultWorker.endpointId && profile.defaultWorker.model
            ? profile.defaultWorker
            : frozenSnapshot.modelBindings!.defaultWorker,
      },
    }
    const resolved = resolveVariantBinding(snapshot, variant)
    source = {
      ...frozenSource,
      agent_snapshot: JSON.stringify(variant),
      endpoint_id: resolved.endpoint.id,
      model: resolved.binding.model,
    }
  }
  const active = db.prepare(`
    SELECT 1 FROM orchestration_runs
    WHERE session_id=? AND status IN ('queued','running')
    LIMIT 1
  `).get(sessionId)
  if (active && !allowParallel) throw new Error('session_run_still_active')
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
         endpoint_id, model, additional_instruction, selection_reason, status,
         replaces_invocation_id, binding_source, binding_snapshot_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
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
      source.id,
      configMode,
      JSON.stringify({
        endpointId: source.endpoint_id,
        model: source.model,
        contextWindow:
          resolveEndpoint(snapshot, source.endpoint_id).contextWindow,
      }),
    )
    emitEvent(db, runId, sessionId, 'tool.called', {
      name: 'retry_agent',
      invocationId: source.id,
      newInvocationId,
      configMode,
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

export function startVNextFailedRetries(
  db: Database.Database,
  sessionId: string,
  configMode: 'frozen' | 'current',
) {
  const failed = db.prepare(`
    SELECT i.id
    FROM agent_invocations i
    WHERE i.session_id=?
      AND i.status IN ('failed','interrupted')
      AND NOT EXISTS (
        SELECT 1 FROM agent_invocations newer
        WHERE newer.replaces_invocation_id=i.id
      )
    ORDER BY i.created_at, i.id
  `).all(sessionId) as Array<{ id: string }>
  if (!failed.length) throw new Error('no_failed_invocations')
  return failed.map((item) =>
    startVNextInvocationRetry(
      db,
      sessionId,
      item.id,
      configMode,
      true,
    ),
  )
}
