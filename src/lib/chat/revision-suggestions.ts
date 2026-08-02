import {
  chatCompletion,
  isAsyncIterable,
  type ChatCompletionResponse,
} from '../llm/client'
import { semanticBody } from '../protocol/semantic-output'

export const REVISION_SUGGESTION_MAX_TOKENS = 65_536

export interface RevisionSuggestionInput {
  endpoint: {
    baseUrl: string
    chatCompletionsPath?: string
    apiKey: string
  }
  model: string
  promptLanguage: 'zh' | 'en'
  sourceText: string
  taskBrief: string
  currentTranslation: string
  userRequest: string
}

export interface RevisionSuggestionResult {
  feedback: string
  targetReaderReport: string
  bilingualReport: string
}

async function completeText(
  input: RevisionSuggestionInput,
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  const response = await chatCompletion(input.endpoint, {
    model: input.model,
    messages,
    stream: false,
    maxTokens: REVISION_SUGGESTION_MAX_TOKENS,
  })
  if (isAsyncIterable(response)) {
    throw new Error('Revision suggestion call unexpectedly returned a stream')
  }
  return semanticBody((response as ChatCompletionResponse).content).trim()
}

function targetReaderMessages(input: RevisionSuggestionInput) {
  if (input.promptLanguage === 'zh') {
    return [
      {
        role: 'system',
        content:
          '你是一名独立的中文成品读者。你看不到原文，也不负责直接改写。请根据用户的简单感受通读当前译文，最多指出三处最影响阅读的准确原句。关注搭配、指代、节奏、语气、画面连续性和明显翻译腔。每一处都要逐字引用当前译文，说明普通读者为什么会卡住，以及希望达到什么阅读效果。刻意陌生、反常或重复的表达可能来自原文；证据不足时标为需要回看，不要擅自判错。没有值得修改的问题时明确说停止。只输出简洁自然语言意见。',
      },
      {
        role: 'user',
        content:
          `用户的感受：\n${input.userRequest}\n\n` +
          `当前完整译文：\n${input.currentTranslation}`,
      },
    ]
  }
  return [
    {
      role: 'system',
      content:
        'You are an independent reader of finished English. You cannot see the source and you do not rewrite the translation. Read the current translation in light of the user\'s simple reaction. Identify at most three exact current sentences or phrases that most obstruct idiomatic reading, reference, rhythm, register, image continuity, or voice. Quote each span character-for-character, explain in ordinary reader language why it causes friction, and state the reading effect that should be restored. Mark deliberate strangeness or repetition as needing source verification when evidence is insufficient. If there is no worthwhile change, say to stop. Output concise natural-language feedback only.',
    },
    {
      role: 'user',
      content:
        `User reaction:\n${input.userRequest}\n\n` +
        `Current complete translation:\n${input.currentTranslation}`,
    },
  ]
}

function bilingualMessages(input: RevisionSuggestionInput) {
  if (input.promptLanguage === 'zh') {
    return [
      {
        role: 'system',
        content:
          '你是一名与目标语读者隔离工作的双语核验者。请对照完整原文、任务要求和当前译文，最多定位三处会改变事实、施受关系、逻辑、专名、数量、结构、意象关系或声音功能的问题。逐字引用当前译文中的准确片段，说明原文真正需要保留的功能和修改边界。自然度本身也是有效问题，但不得把原文刻意的陌生、重复、含混或修辞抹平。不要直接给出整篇重译，也不要把偏好写成确定错误。没有可核验问题时明确说停止。只输出简洁自然语言意见。',
      },
      {
        role: 'user',
        content:
          `用户的感受：\n${input.userRequest}\n\n` +
          `任务要求：\n${input.taskBrief || '无'}\n\n` +
          `完整原文：\n${input.sourceText}\n\n` +
          `当前完整译文：\n${input.currentTranslation}`,
      },
    ]
  }
  return [
    {
      role: 'system',
      content:
        'You are a bilingual verifier working independently from the target-language reader. Compare the complete source, task brief, and current translation. Identify at most three exact current spans that change facts, agency, logic, established names, quantity, structure, image relations, or the source\'s rhetorical and tonal function. Quote each current span character-for-character, describe the source function that must survive, and bound the safe repair. Target-language friction is valid evidence, while deliberate strangeness, repetition, openness, and rhetoric must not be flattened. Do not rewrite the whole text and do not turn preference into a factual error. If there is no verifiable problem, say to stop. Output concise natural-language feedback only.',
    },
    {
      role: 'user',
      content:
        `User reaction:\n${input.userRequest}\n\n` +
        `Task brief:\n${input.taskBrief || 'None'}\n\n` +
        `Complete source:\n${input.sourceText}\n\n` +
        `Current complete translation:\n${input.currentTranslation}`,
    },
  ]
}

function arbiterMessages(
  input: RevisionSuggestionInput,
  targetReaderReport: string,
  bilingualReport: string,
) {
  if (input.promptLanguage === 'zh') {
    return [
      {
        role: 'system',
        content:
          '你负责把两份隔离意见整理成一条普通用户能理解并直接发送给编辑 Agent 的短消息。逐条核对意见是否引用了当前译文中真实存在的准确片段。最多保留三处高影响问题；优先保留两份报告互补且有明确边界的问题。使用日常表达，例如“这句读着有点绕”“这里像是把谁做了什么说反了”。说明希望更通顺、文雅、清楚或更贴近原意，但不要替用户写专业术语，不要提供整篇答案。若两份报告都没有可靠问题，输出“这一轮先不要修改”。只输出最终短消息。',
      },
      {
        role: 'user',
        content:
          `用户原始感受：\n${input.userRequest}\n\n` +
          `当前完整译文：\n${input.currentTranslation}\n\n` +
          `目标语读者意见：\n${targetReaderReport || '无'}\n\n` +
          `双语核验意见：\n${bilingualReport || '无'}`,
      },
    ]
  }
  return [
    {
      role: 'system',
      content:
        'Turn the two independent reports into one short message that an ordinary user could understand and send directly to the editing agent. Verify that every quoted span exists exactly in the current translation. Keep at most three high-impact, bounded problems and prefer complementary findings. Use everyday language such as “this line feels stiff” or “this seems to say who did what the wrong way.” State the desired reading effect without specialist jargon and without supplying a complete replacement translation. If neither report identifies a reliable problem, output “Do not change this version in this round.” Output the final short message only.',
    },
    {
      role: 'user',
      content:
        `Original user reaction:\n${input.userRequest}\n\n` +
        `Current complete translation:\n${input.currentTranslation}\n\n` +
        `Target-language reader report:\n${targetReaderReport || 'None'}\n\n` +
        `Bilingual verifier report:\n${bilingualReport || 'None'}`,
    },
  ]
}

export async function generateRevisionSuggestion(
  input: RevisionSuggestionInput,
): Promise<RevisionSuggestionResult> {
  const [targetReaderReport, bilingualReport] = await Promise.all([
    completeText(input, targetReaderMessages(input)),
    completeText(input, bilingualMessages(input)),
  ])
  const feedback = await completeText(
    input,
    arbiterMessages(input, targetReaderReport, bilingualReport),
  )
  return { feedback, targetReaderReport, bilingualReport }
}
