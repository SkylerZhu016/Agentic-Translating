import {
  chatCompletion,
  isAsyncIterable,
  type ChatCompletionResponse,
} from '../llm/client'
import { semanticBody } from '../protocol/semantic-output'

export const REVISION_SUGGESTION_MAX_TOKENS = 131_072

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
  // 必须使用流式：推理模型在首个可见 token 前可能静默数十秒，
  // 非流式连接会被上游网关读超时切断（504），而推理仍继续计费。
  // 流式期间思维链分片由客户端丢弃，但分片活动会保持连接存活。
  const response = await chatCompletion(input.endpoint, {
    model: input.model,
    messages,
    stream: true,
    maxTokens: REVISION_SUGGESTION_MAX_TOKENS,
  })
  if (!isAsyncIterable(response)) {
    // 部分上游会以非流式 JSON 应答流式请求（客户端自动降级）。
    return semanticBody((response as ChatCompletionResponse).content).trim()
  }
  let content = ''
  for await (const event of response) {
    if (event.type === 'text') {
      content += event.content
    } else if (event.type === 'done') {
      content = event.content || content
    }
  }
  return semanticBody(content).trim()
}

function targetReaderMessages(input: RevisionSuggestionInput) {
  if (input.promptLanguage === 'zh') {
    return [
      {
        role: 'system',
        content:
          '你是一名独立的中文成品读者。你看不到原文，也不负责改写，只报告阅读卡顿。请根据用户的简单感受通读当前译文，最多报告三处最影响阅读的卡顿点，并逐字引用当前译文中的准确原句。每一处必须标注类型：【真语义问题】——指代不清、搭配明显错误、句子无法还原意图；或【疑似刻意表达】——不常见但有味道、可能是原文的陌生化手法。疑似刻意表达一律只标为待核验，绝不给出改法建议；除非用户感受明确抱怨该处，否则它不进入任何修改候选。对【真语义问题】说明普通读者为什么会卡住和希望达到的阅读效果；对【疑似刻意表达】说明应保留什么效果。没有值得报告的卡顿时明确说停止。只输出简洁自然语言意见。',
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
        'You are an independent reader of finished English. You cannot see the source and you do not rewrite the translation; you only report reading friction. Read the current translation in light of the user\'s simple reaction. Report at most three spots that most obstruct reading, quoting each span character-for-character. Label every spot: 【real semantic problem】— unclear reference, plainly wrong collocation, a sentence whose intent cannot be recovered; or 【likely deliberate device】— unusual but flavorful, possibly the source\'s deliberate strangeness. For likely-deliberate spots, mark them needs-verification only and never suggest a fix, and do not include them as change candidates unless the user explicitly complains about that spot. For real semantic problems, explain in ordinary reader language why it causes friction and the reading effect that should be restored; for likely-deliberate spots, state what effect must survive. If there is nothing worth reporting, say to stop. Output concise natural-language feedback only.',
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
          '你是一名与目标语读者隔离工作的双语核验者。第一步：先为原文每个分句写出主语—谓语—宾语骨架以及关键否定、数量、修饰归属，不参考译文。第二步：再逐句对照当前译文，任何施受、主语、否定、时态、数量或修饰归属的变化都必须标出。第三步：只把有原文直接证据的问题列入报告（最多三处），每个问题给出：a) 允许的修改边界（可以怎么写）；b) 禁止事项（不能怎么写，负面句式，例如“主语必须是 X，不能改成 Y”“不要新增动作、因果或抽象化”）。原文的异常搭配、悖论、重复、陌生化表达默认是刻意手法：除非能证明是误译，否则必须明确写“保留，不改”，绝不因“读着拗口”而建议改。不要直接给出整篇重译，也不要把偏好写成确定错误。没有可核验问题时明确说停止。只输出简洁自然语言意见。',
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
        'You are a bilingual verifier working independently from the target-language reader. Step 1: write out the subject-verb-object skeleton of every source clause, plus key negations, counts, and modification attachment, without consulting the translation. Step 2: check each target sentence against that skeleton; flag every shift in agency, subject, negation, tense, number, or attachment. Step 3: report at most three problems that have direct source evidence, and for each give: a) the permitted repair boundary (what may be written instead); and b) explicit prohibitions in negative form (e.g. "the subject must remain X, do not make it Y", "do not add motion, causation, or abstraction"). Treat the source\'s unusual collocations, paradoxes, repetitions, and deliberate strangeness as intentional by default: unless you can prove mistranslation, state explicitly "keep, do not change" and never recommend a change merely because the target reads stiffly. Do not rewrite the whole text and do not turn preference into a factual error. If there is no verifiable problem, say to stop. Output concise natural-language feedback only.',
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
          '你负责把两份隔离意见整理成一条普通用户能理解并直接发送给编辑 Agent 的短消息。默认输出“这一轮先不要修改”；只有当双语核验者明确确认了问题（给出了修改边界和禁止事项）时，才把这些确认项整理成反馈。目标语读者报告中的疑似刻意表达一律不得列入反馈，除非双语核验者确认它们是误译。目标语读者报告中的卡顿若未被双语核验者确认为可核验问题，不得列入。双语核验者明确写“保留，不改”的原文表达，反馈中必须写入“不要改……”的负面指令。双语核验报告中的禁止事项必须逐字保留在反馈里，用“不要……”“不能……”的负面句式原样写出，不得用你自己的话转述或简化，以免方向变模糊。最多保留三处。使用日常表达，例如“这句读着有点绕”“这里像是把谁做了什么说反了”。说明希望更通顺、文雅、清楚或更贴近原意，但不要替用户写专业术语，不要提供整篇答案。只输出最终短消息。',
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
        'Turn the two independent reports into one short message that an ordinary user could understand and send directly to the editing agent. Default output is "Do not change this version in this round"; include a change candidate only when the bilingual verifier explicitly confirmed it (with a repair boundary and prohibitions). Never include the target-language reader\'s likely-deliberate-device items unless the bilingual verifier confirmed them as mistranslations. Never include reader friction that the bilingual verifier did not confirm as a verifiable problem. When the bilingual verifier wrote "keep, do not change" for a source device, the feedback must carry an explicit negative instruction ("do not change…"). Preserve the bilingual verifier\'s prohibitions verbatim in the feedback, phrased as explicit negatives ("do not…", "must not…") — never paraphrase or soften them, since a vague restatement reverses direction. Keep at most three items. Use everyday language such as “this line feels stiff” or “this seems to say who did what the wrong way.” State the desired reading effect without specialist jargon and without supplying a complete replacement translation. Output the final short message only.',
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
