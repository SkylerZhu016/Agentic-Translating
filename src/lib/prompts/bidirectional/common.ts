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

export const PUNCTUATION_RHYTHM_ZH = `# 标点跟随原文节奏
标点不是装饰，也不为整齐服务。逐处对照原文的标点：原文使用分号、破折号、冒号或感叹号处，译文保留相应标点与停顿层级；原文没有的标点不得添加，也不得为形式整齐而升级或降级原文的标点层级。中文句界依靠语义、语气和自然停顿表达，读者不需要额外标点辅助即可读通；两个意思完整的句子靠语义和语气自然分开即可。`

export const PUNCTUATION_FLOOR_EN = `# Punctuation rhythm and the grammar floor
Punctuation follows the source's rhythm, not decoration. Where the source marks a boundary with a semicolon, dash, colon, or exclamation, keep the same mark at the same level; do not add style marks the source lacks (dashes, exclamation marks, parentheses). English grammar is the floor: two complete clauses must not be comma-spliced; a boundary marked by the source must stay visible with English-legal punctuation (period, semicolon, or conjunction). When the source is unpunctuated or comma-separated, choose the least intrusive English-legal mark that preserves the boundary: period, semicolon, or conjunction. Do not use a mark merely to decorate.`

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

export const RHYME_CHECK_EN = `# Rhyme check (activate only when the task is rhyming poetry)
When rhyme is required, judge it by English pronunciation, not spelling. List the stressed vowel (and any following consonants) of every line-ending word, then decide which lines rhyme:
- Perfect rhyme: identical stressed vowel plus identical following sounds (e.g., fray/day/bay/way; night/light).
- Near rhyme / slant rhyme is acceptable when perfect rhyme would distort meaning: matching stressed vowel with a different tail (e.g., move/love), or a similar vowel with a matching tail. Prefer a defensible near rhyme over an invented phrase.
- Words whose endings differ in both vowel and consonant structure do NOT rhyme (e.g., night / woodcutter / silence are not rhymes).
Common schemes: AAAA (monorhyme), AABB (couplets), ABAB (alternating), ABBA (enclosed), XAXA (odd lines free). Mark each line's rhyming word and state the scheme actually used.
Rhyme is a formal goal subordinate to meaning: never add imagery the source lacks, change agency, distort meaning, or drop information to force a rhyme. When rhyme conflicts with fidelity, resolve in this order: first change the scheme (full rhyme to partial, motif, or alternating rhyme; e.g., keep an established opening couplet or echo one rhyme position later); if the conflict persists, keep the rhyme positions that already work and let the remaining lines follow meaning first — do not force the count. Partial or motif rhyme is a legitimate scheme choice and must not be marked as a defect for failing to complete every position.
Realize rhyme in a "sentences first, scheme second" order: draft each line for semantic accuracy and structural correspondence, letting line endings take their most faithful words without pre-committing to a scheme; then mark the sounds of the settled endings, find the rhyme pairs that already hold, and enumerate viable schemes (AAAA, AABB, ABAB, ABBA, AABA, AXBX, XAXA), preferring the one that changes the fewest settled endings at the least semantic cost; fill only the positions the scheme requires, with words that are simultaneously faithful; when a position cannot be filled without semantic damage, drop it (mark X, downgrading the scheme to partial or motif rhyme) rather than revising settled lines backward to force rhyme. Resolve unclear relations inside a line through grammar, voice, or prepositions rather than vague wording.`

export const RHYME_CHECK_ZH = `# 押韵检查（仅当任务是押韵诗歌时启用）
需要押韵时，按普通话实际发音判定押韵，不按平水韵或古代读音判定。逐行列出每个句末字的拼音与韵母，再判断哪些行构成押韵关系：
- 韵母相同的字互相押韵（如 chōng/lóng/róng/zōng 同押 ong 韵；xīn/jīn/yīn/lín 同押 in 韵）。
- 前后鼻音韵尾可以通押：an/ang、en/eng、in/ing、un/ong 等成对鼻韵尾视为可押韵。
- 平水韵同部但普通话读音不相近的，不算押韵（平水韵与普通话发音体系不同，一律以普通话实际读音为准）。
- 声调不需要相同；押韵看韵母，不要求同调。
常见韵式按韵脚位置标记：AAAA（一韵到底）、AABB（随韵，两行一组）、ABAB（交叉韵）、ABBA（抱韵）、XAXA（奇数行自由，偶数行押韵）等。采用哪种韵式由译稿实际句末字决定，并在检查时明确标出每一行的韵脚字和韵式。
押韵是形式目标，优先级低于语义：不得为了押韵添加原文没有的意象、改变施受关系、扭曲原意或删减信息。当韵式与忠实表达冲突时按此顺序处理：先换韵式（完整韵改为部分韵、母题式韵或交错韵，如保留已成韵的首联或让某一韵位在后文回声呼应）；仍冲突则以意为先，保留已经成立的韵位，不强行凑齐。部分韵或母题式韵是合法的韵式选择，不得因未押全韵而判为缺陷。
落实押韵采用“先定句、后定韵”的顺序：先按语义准确与结构对应写出草稿，行末字取语义最准确的词，不预先锁死韵式；再标出已定行末字的发音，找出已成立的韵对，从已成立韵对出发枚举可行韵式（AAAA、AABB、ABAB、ABBA、AABA、AXBX、XAXA），优先选择改动行末字最少、语义损伤最小的韵式；只在韵式要求的韵位补韵，补韵词必须同时达意；某韵位无法无损补韵时放弃该韵位（标 X，韵式降级为部分韵或母题韵），不得反向修改已成立的句子凑韵。行内语义不清时用语法、语态、介词明确主宾关系，不用模糊说法掩盖。`

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
