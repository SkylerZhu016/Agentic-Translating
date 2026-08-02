import type { AgentDirectionVariant } from '../../contracts/vnext'

export type BuiltinVariantDefinition = Omit<
  AgentDirectionVariant,
  | 'promptVersion'
  | 'enabled'
  | 'endpointOverrideId'
  | 'modelOverride'
  | 'sortOrder'
>

export const SEMANTIC_BOUNDARY_ZH = `# 输出
先给出一份完整、可直接使用的译文正文。请使用自由文本，不要使用 JSON、表格或固定字段，也不要用分析、提纲或审校意见代替译文。

# 注释
需要补充术语选择、歧义判断、形式取舍或查证事项时，在译文正文之后另起一行写“---”，再写注释。注释必须以这条独立横线分隔，并且位于整份回复最后。所有供人查看的解释都放在最后一条独立“---”之后；系统会把最后一条独立“---”视为正文与注释的边界。没有必要说明时可以省略注释和分隔线。`

export const SEMANTIC_BOUNDARY_EN = `# Output
Begin with one complete translation that can be used as-is. Write in free form. Do not use JSON, tables, fixed fields, an outline, or a review in place of the translation.

# Annotation
When terminology choices, ambiguity, formal trade-offs, or research questions need explanation, place a standalone line containing "---" after the translation and write the annotation below it. The annotation must be separated by this line and must come at the end of the response. Put every human-facing explanation after the final standalone "---"; the system treats the final standalone "---" as the boundary between body and annotation. Omit both the annotation and divider when no explanation is useful.`

export const STAGE_BOUNDARY_ZH = `# 输出与注释
先自由输出本阶段完整、可供下一阶段直接使用的正文，不要使用 JSON、表格或固定字段。需要补充只供人查看的说明时，在阶段正文后另起一行写“---”，再写注释。注释必须位于整份回复最后，所有人类说明都放在最后一条独立“---”之后。系统会把最后一条独立“---”视为边界；没有必要说明时可以省略注释和分隔线。`

export const STAGE_BOUNDARY_EN = `# Output and annotation
Write the complete free-form stage body first so the next stage can use it directly. Do not use JSON, tables, or fixed fields. When an explanation is useful only to a human reader, place a standalone line containing "---" after the stage body and write the annotation below it. The annotation must remain at the end of the response, with every human-facing note after the final standalone "---". The system treats that final standalone line as the boundary. Omit the annotation and divider when they add no value.`

export const DASH_POLICY_ZH = `# 标点约束
原文没有破折号或分号时，不要为了文采、停顿、节奏或衔接自行增加。原文存在相应标点时，只在语义和结构对应的位置保留，不要扩散到其他句子。此处的破折号包括中文破折号、em dash 与 en dash；复合词内部正常使用的连字符不受影响。`

export const DASH_POLICY_EN = `# Punctuation constraint
When the source has no corresponding dash or semicolon, do not add one for literary tone, pause, rhythm, or linkage. When the source uses one, retain it only where meaning and structure support it and do not spread it to other sentences. This covers Chinese dashes, em dashes, and en dashes. Ordinary hyphens inside compound words remain available.`

export const QUALITY_DISCIPLINE_ZH = `# 通用质量准则
先恢复每句话的语义骨架，再组织目标语。核对实际主语、动作施受、修饰范围、指代、否定、时态体貌、情态、确定程度，以及并列、转折、因果、目的和递进关系。原文明确表达的信息应完整保留；中文语法需要补出的主语和连接可以加入，评价、心理、频率、程度、因果、动作和结论需要有原文依据。

专名、人物关系、术语、数字、单位和计算口径需要保守处理。遇到可以成立的歧义时，正文采用最有依据且能维持原文开放度的表达；必要说明放入最后的注释。完成后逐意群回查原文，并独立朗读译文，确认目标语读者无需回译原文也能理解句法和逻辑。`

export const QUALITY_DISCIPLINE_EN = `# Shared quality criteria
Recover each sentence's semantic structure before shaping the target language. Check the actual subject, agency, modification scope, reference, negation, tense and aspect, modality, degree of certainty, and the relations of coordination, contrast, cause, purpose, and progression. Preserve every source-supported claim. Add grammatical subjects or links when English requires them, while keeping evaluation, psychology, frequency, degree, causation, action, and conclusions accountable to the source.

Handle proper nouns, relationships, terminology, numbers, units, and quantitative scope conservatively. When ambiguity remains defensible, choose wording that keeps the source's openness where possible and place necessary explanation in the final annotation. Back-check each unit against the source, then read the translation independently to ensure an English reader can follow its grammar and logic without reconstructing the Chinese.`

export const POETRY_LINEATION_ZH = `# 诗行与形式
诗歌任务需要先确认诗行、分节、跨行延续、停顿和原有标点。原文已经分行时，译文应保留相应的结构意识；连续排版的古典诗词应根据原有句读恢复诗行。句法仍在下一行延续时，不要擅自在当前行末使用句号。押韵、格律和字数服从用户给出的优先级，不能依靠新增意象或改变核心含义完成形式要求。`

export const POETRY_LINEATION_EN = `# Lineation and form
For poetry, identify lines, stanzas, enjambment, pauses, and source punctuation before drafting. Preserve the structural force of existing line breaks, and recover verse lines from the punctuation of continuously typeset classical Chinese poetry. Do not add a full stop at the end of a line whose syntax continues into the next. Follow the user's priority for rhyme, meter, and line length without adding images or changing core meaning to satisfy form.`

export function withCandidateProtocol(
  rolePrompt: string,
  direction: 'en_to_zh' | 'zh_to_en',
  options: { poetry?: boolean } = {},
): string {
  const poetry = options.poetry
    ? direction === 'en_to_zh'
      ? POETRY_LINEATION_ZH
      : POETRY_LINEATION_EN
    : ''
  const boundary =
    direction === 'en_to_zh' ? SEMANTIC_BOUNDARY_ZH : SEMANTIC_BOUNDARY_EN

  return [rolePrompt, poetry, boundary].filter(Boolean).join('\n\n')
}
