import { chatCompletion, isAsyncIterable } from '../llm/client'
import { parseSemanticAgentOutput } from '../protocol/semantic-output'
import { resolveCompletionTokenBudget } from '../guards/tokens'

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
}) {
  const messages = buildAgentTestMessages(input.prompt)
  const requestMessages = [
    { role: 'system', content: messages.system },
    { role: 'user', content: messages.user },
  ]
  const response = await chatCompletion(
    {
      baseUrl: input.endpoint.baseUrl,
      chatCompletionsPath: input.endpoint.chatCompletionsPath,
      apiKey: input.endpoint.apiKey,
    },
    {
      model: input.model,
      maxTokens: resolveCompletionTokenBudget(
        requestMessages.map((message) => message.content).join('\n'),
        input.endpoint.contextWindow,
      ),
      stream: false,
      messages: requestMessages,
    },
  )
  if (isAsyncIterable(response)) {
    throw new Error('unexpected_stream')
  }
  return parseSemanticAgentOutput(response.content)
}
