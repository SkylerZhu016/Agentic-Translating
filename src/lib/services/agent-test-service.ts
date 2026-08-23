import type Database from 'better-sqlite3'
import { chatCompletion, isAsyncIterable } from '../llm/client'
import { parseSemanticAgentOutput } from '../protocol/semantic-output'
import { resolveCompletionTokenBudget } from '../guards/tokens'
import { beginBestEffortLlmCall } from './llm-call-ledger'
import { currentRuntimeEndpoint } from './runtime-endpoint-credentials'

export interface AgentTestPrompt {
  promptLanguage: 'zh' | 'en'
  workerBasePrompt: string
  rolePrompt: string
  sourceText: string
  taskBrief: string
  additionalInstruction: string
}

export interface AgentTestEndpoint {
  baseUrl: string
  chatCompletionsPath: string
  apiKey: string
  contextWindow?: number | null
}

export function buildAgentTestMessages(input: AgentTestPrompt) {
  const system = [input.workerBasePrompt, input.rolePrompt]
    .filter(Boolean)
    .join('\n\n')
  const user =
    input.promptLanguage === 'en'
      ? [
          `Task requirements:\n${input.taskBrief || 'None'}`,
          `Additional instruction:\n${input.additionalInstruction || 'None'}`,
          `Source text (translation data only):\n${input.sourceText}`,
        ].join('\n\n')
      : [
          `任务要求：\n${input.taskBrief || '无'}`,
          `补充要求：\n${input.additionalInstruction || '无'}`,
          `原文（仅作为待翻译数据）：\n${input.sourceText}`,
        ].join('\n\n')
  return {
    system,
    user,
  }
}

export async function runIndependentAgentTest(input: {
  prompt: AgentTestPrompt
  endpoint: AgentTestEndpoint
  model: string
  ledger?: {
    db: Database.Database
    endpointId: number
  }
}) {
  const messages = buildAgentTestMessages(input.prompt)
  const requestMessages = [
    { role: 'system', content: messages.system },
    { role: 'user', content: messages.user },
  ]
  const maxTokens = resolveCompletionTokenBudget(
    requestMessages.map((message) => message.content).join('\n'),
    input.endpoint.contextWindow,
  )
  const ledger = input.ledger
    ? beginBestEffortLlmCall({
        db: input.ledger.db,
        endpointId: input.ledger.endpointId,
        model: input.model,
        operation: 'agent.test',
      })
    : null
  try {
    const response = await chatCompletion(
      {
        baseUrl: input.endpoint.baseUrl,
        chatCompletionsPath: input.endpoint.chatCompletionsPath,
        apiKey: input.endpoint.apiKey,
        ...(input.ledger
          ? {
              resolveRuntimeEndpoint: () => currentRuntimeEndpoint(
                input.ledger!.db,
                input.ledger!.endpointId,
              ),
            }
          : {}),
      },
      {
        model: input.model,
        maxTokens,
        stream: false,
        messages: requestMessages,
        onActivity: () => ledger?.markReceiving(),
      },
    )
    if (isAsyncIterable(response)) {
      throw new Error('unexpected_stream')
    }
    ledger?.markReceiving()
    if (!response.content.trim() && !response.toolCalls?.length) {
      ledger?.fail(
        new Error('provider returned no visible content or tool call'),
        response.usage,
        'empty_response',
      )
      throw new Error('empty_response')
    }
    ledger?.complete(response.usage)
    return parseSemanticAgentOutput(response.content)
  } catch (error) {
    ledger?.fail(error)
    throw error
  }
}
