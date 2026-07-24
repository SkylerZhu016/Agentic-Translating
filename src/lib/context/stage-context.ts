import type { Stage, TranslationResult, StageOutput, ChatMessage } from '../contracts/types'
import { semanticBody } from '../protocol/semantic-output'

export interface StageContextTranslationEntry {
  agent_id: string
  name: string
  model: string
  text: string
}

export interface StageContextJson {
  source: {
    text: string
    from: string
    to: string
  }
  translations: StageContextTranslationEntry[]
  prior_stages: {
    review?: { body: string }
    filter?: { body: string }
    orchestrate?: { body: string }
  }
  task_brief?: string
}

export interface StageContextResult {
  json: StageContextJson
  /** Retained for API compatibility. vNext never silently truncates. */
  truncated: false
}

export interface ChatContextMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

function parseAgentSnapshot(snapshot: string): { name: string; model: string } {
  try {
    const data = JSON.parse(snapshot)
    return {
      name: typeof data.name === 'string' ? data.name : 'unknown',
      model: typeof data.model === 'string' ? data.model : 'unknown',
    }
  } catch {
    return { name: 'unknown', model: 'unknown' }
  }
}

function stageOutputToIndexed(
  stages: StageOutput[],
): StageContextJson['prior_stages'] {
  const result: StageContextJson['prior_stages'] = {}
  for (const stage of stages) {
    if (
      stage.stage === 'review' ||
      stage.stage === 'filter' ||
      stage.stage === 'orchestrate'
    ) {
      result[stage.stage] = { body: semanticBody(stage.raw_output) }
    }
  }
  return result
}

/**
 * Build the full downstream stage context. The legacy budget argument is
 * intentionally ignored: vNext reports context overflow instead of deleting
 * candidate or stage text.
 */
export function buildStageContext(
  _stage: Stage,
  params: {
    sourceText: string
    sourceLang: string
    targetLang: string
    translations: TranslationResult[]
    priorStages: StageOutput[]
    taskBrief?: string
  },
  _legacyBudget?: number,
): StageContextResult {
  const json: StageContextJson = {
    source: {
      text: params.sourceText,
      from: params.sourceLang,
      to: params.targetLang,
    },
    translations: params.translations.map((translation) => {
      const agent = parseAgentSnapshot(translation.agent_snapshot)
      return {
        agent_id: translation.agent_key,
        name: agent.name,
        model: agent.model,
        text: semanticBody(translation.output_text),
      }
    }),
    prior_stages: stageOutputToIndexed(params.priorStages),
  }

  if (params.taskBrief?.trim()) json.task_brief = params.taskBrief
  return { json, truncated: false }
}

/**
 * Build editing context from the latest complete document and every stored
 * message. The legacy max-turns argument is ignored to prevent silent loss.
 */
export function buildChatContext(
  messages: ChatMessage[],
  currentText: string,
  _legacyMaxTurns?: number,
): ChatContextMessage[] {
  return [
    {
      role: 'system',
      content:
        `当前最新全文：\n${currentText}\n\n` +
        '可用编辑工具：replace_text（替换指定文本段）。任何修改都必须调用该工具。',
    },
    ...messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  ]
}
