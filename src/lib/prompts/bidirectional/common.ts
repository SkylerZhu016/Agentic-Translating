import type { AgentDirectionVariant } from '../../contracts/vnext'
import { SEMANTIC_JSON_PROTOCOL_MARKER } from '../../protocol/semantic-output'

export type BuiltinVariantDefinition = Omit<
  AgentDirectionVariant,
  | 'promptVersion'
  | 'enabled'
  | 'endpointOverrideId'
  | 'modelOverride'
  | 'sortOrder'
>

const JSON_ENVELOPE_ZH = `${SEMANTIC_JSON_PROTOCOL_MARKER}
整份最终回复使用一个裸 JSON 对象，恰好包含 "body" 和 "annotation" 两个字段。先写 body，再写 annotation。body 必须是包含实际正文的非空字符串，annotation 必须是字符串或 null。需要说明时写简洁、可核验的术语选择、歧义判断、取舍或查证事项，其他情况填写 null。

正文和说明的内容可以使用自然语言自由组织，JSON 仅确定两者的边界。正文中的换行写为 \\n，双引号和反斜杠按 JSON 规则转义。返回形如 {"body":"完整正文","annotation":null} 的对象。对象外只允许空白，代码围栏、开场说明、额外字段和横线分隔符均会导致格式校验失败。

模型思考由独立 reasoning 通道传送。body 与 annotation 均只包含最终交付内容，模型自己的思考过程留在独立通道。原文本身含有 <think>/<analysis> 等字面标签时，按翻译任务要求保留这些源文内容。`

const JSON_ENVELOPE_EN = `${SEMANTIC_JSON_PROTOCOL_MARKER}
Return exactly one bare JSON object with exactly two fields, "body" and "annotation". Write body first, then annotation. body must be a non-empty string containing the actual stage text. annotation must be a string or null. Use a concise, verifiable note for terminology choices, ambiguity, trade-offs, or research questions when useful, and null otherwise.

Write the contents freely in natural language: JSON defines only the boundary between body and annotation. Encode line breaks as \\n and escape quotation marks and backslashes according to JSON syntax. Return an object such as {"body":"Complete stage text","annotation":null}. Only whitespace is allowed outside the object. Code fences, introductory prose, extra fields, and divider lines fail format validation.

Model reasoning belongs to the separate reasoning channel. Both body and annotation contain final deliverables only. Keep the model's own thinking traces in that separate channel. When the source itself contains literal tags such as <think>/<analysis>, preserve that source content as the translation task requires.`

export const SEMANTIC_BOUNDARY_ZH = `# 输出
body 保存一份完整、可直接使用的译文正文，保留译文的段落和诗行。分析、提纲和审校意见放在各自的任务阶段中。

# 注释
annotation 保存给人查看的必要说明，默认与下游正文隔离。用户明确选择继承注释时，系统才把该字段作为额外参考传递给后续阶段。

${JSON_ENVELOPE_ZH}`

export const SEMANTIC_BOUNDARY_EN = `# Output
Use body for one complete translation ready for use, preserving its paragraphs and verse lines. Analysis, outlines, and review reports belong to their respective task stages.

# Annotation
Use annotation for useful human-facing notes, isolated from the downstream body by default. The system passes that field as additional reference only when the user explicitly enables annotation inheritance.

${JSON_ENVELOPE_EN}`

export const STAGE_BOUNDARY_ZH = `# 输出与注释
body 保存本阶段完整、可供下一阶段直接使用的自然语言正文。审查阶段保存审查证据，筛选阶段保存选稿决策，编排阶段保存完整工作译稿，前置分析阶段保存分析发现。annotation 只保存给人查看的简短译注或决策摘要，默认与下游正文隔离。

${JSON_ENVELOPE_ZH}`

export const STAGE_BOUNDARY_EN = `# Output and annotation
Use body for the complete natural-language stage text that the next stage will use: review evidence for review, selection decisions for filtering, a complete working translation for orchestration, and findings for pre-translation analysis. Use annotation only for brief human-facing translator notes or decision summaries, isolated from the downstream body by default.

${JSON_ENVELOPE_EN}`

export const DASH_POLICY_ZH = `# 标点约束
破折号和分号须有具体的句法、语气或诗性作用。普通衔接优先用句法完成，保留原文有意义的停顿，目标语确有相同表达需要时可以调整标点。逐处说明其作用，避免把破折号当作通用连接方式。复合词内部的连字符按词法正常使用。`

export const DASH_POLICY_EN = `# Punctuation constraint
Use dashes and semicolons for a concrete syntactic, rhetorical, or poetic function. Prefer syntax for ordinary linkage, preserve meaningful source pauses, and allow justified target-language punctuation. Check each mark's function rather than using dashes as a default connector. Ordinary compound-word hyphens remain available.`

export const PUNCTUATION_RHYTHM_ZH = `# 标点跟随原文节奏
先判断从属、并列、转折和语气关系，再组织标点。紧密相连的意群优先通过自然句法承接，减少人为反复切成三段的逗号停顿。保留有作用的短句、突转、重复和停顿，连贯表达也要保持原文的力度。诗歌中的名词片语、省略、意象并置和问答跳跃可以成立，按整段或完整诗句判断可读性，逐行补成完整主谓句会改变原有节奏。标点按语义和朗读作用审读，逗号数量本身不构成错误。`

export const PUNCTUATION_FLOOR_EN = `# Punctuation rhythm and the grammar floor
Read clause relations and rhetorical movement before choosing marks. Join closely related units through idiomatic syntax, reducing artificial, repeated three-part comma breaks. Preserve purposeful short sentences, pauses, repetitions, and turns of voice. In ordinary prose, repair real comma splices through grammar or a meaningful sentence boundary. In poetry, readable nominal phrases, ellipsis, image juxtaposition, and question-answer turns are valid: assess the complete verse unit without requiring a full subject-predicate sentence on every line. Judge punctuation by meaning and cadence, never by comma counts.`

export const QUALITY_DISCIPLINE_ZH = `# 通用质量准则
先恢复每句话的语义骨架，再组织目标语。核对实际主语、动作施受、修饰范围、指代、否定、时态体貌、情态、确定程度，以及并列、转折、因果、目的和递进关系。原文明确表达的信息应完整保留；中文语法需要补出的主语和连接可以加入，评价、心理、频率、程度、因果、动作和结论需要有原文依据。

专名、人物关系、术语、数字、单位和计算口径需要保守处理。遇到可以成立的歧义时，正文采用最有依据且能维持原文开放度的表达；必要说明放入最后的注释。完成后逐意群回查原文，并独立朗读译文，确认目标语读者无需回译原文也能理解句法和逻辑。`

export const QUALITY_DISCIPLINE_EN = `# Shared quality criteria
Recover each sentence's semantic structure before shaping the target language. Check the actual subject, agency, modification scope, reference, negation, tense and aspect, modality, degree of certainty, and the relations of coordination, contrast, cause, purpose, and progression. Preserve every source-supported claim. Add grammatical subjects or links when English requires them, while keeping evaluation, psychology, frequency, degree, causation, action, and conclusions accountable to the source.

Handle proper nouns, relationships, terminology, numbers, units, and quantitative scope conservatively. When ambiguity remains defensible, choose wording that keeps the source's openness where possible and place necessary explanation in the final annotation. Back-check each unit against the source, then read the translation independently to ensure an English reader can follow its grammar and logic without reconstructing the Chinese.`

export const POETRY_LINEATION_ZH = `# 诗行与形式
诗歌先落实用户明确指定的译文行数，再辨认实际诗句、分节和跨行延续。物理换行和逗号只提供线索，一条物理行可以包含多个诗句。通常一个源诗句对应一行译文，密度需要时可用两行，同一首诗尽量保持一对一或一对二的映射节奏。行内可容纳两个连贯意群，若源物理行包含两个诗句，对应译文行也可承载更多意群。这些是软节奏偏好，不能据分句或标点计数判错。保持意象次序、对照和句法延续，句法通向下一行时保持行末开放。准确性与用户要求的押韵优先于表面整齐，其他形式要求遵守用户给出的顺序，形式调整须保全核心含义。`

export const POETRY_LINEATION_EN = `# Lineation and form
For poetry, satisfy any explicit hard output line count first, then identify actual verse units, stanzas, and enjambment. Physical source line breaks and commas are clues, not unit counts: one physical line can contain several verse units. Usually carry one verse unit into one target line, using two when density requires it, and keep that mapping rhythm consistent across the poem where the source permits. A target line can hold two coherent sense groups, or more when its source physical line contains multiple verse units. These are rhythmic preferences, not clause-count limits. Preserve image order, parallel movement, and syntactic continuation, leaving a line open when its syntax continues. Accuracy and requested rhyme take priority over visual neatness. Follow the user's hierarchy for other formal goals while preserving core meaning.`

export const SOURCE_LED_STYLE_ZH = `# 主体与回指承接
补主语和代词时保留原文的视角及指称范围。上下文已确定的参与者可以明确表达，原文留开放的主体则保留其范围，避免限定成特定他人并赋予其未说出的心理。回指在初读时含混，且上下文确能确定对象时，可用简明的原文所支持的名词澄清。清楚可读的诗性省略继续保留。

${PUNCTUATION_RHYTHM_ZH}

${DASH_POLICY_ZH}

${POETRY_LINEATION_ZH}`

export const SOURCE_LED_STYLE_EN = `# Subject and reference continuity
When supplying subjects or pronouns, preserve the source viewpoint and referential scope. Identify participants when context resolves them and retain openness where the source leaves it, without assigning another person's unspoken mental state. Clarify an obscure pronoun or abstract possessive with a concise source-supported noun when context identifies it, while retaining clear poetic ellipsis.

${PUNCTUATION_FLOOR_EN}

${DASH_POLICY_EN}

${POETRY_LINEATION_EN}`

export const RHYME_CHECK_EN = `# Rhyme check (activate only when the task is rhyming poetry)
When rhyme is required, judge it by English pronunciation, not spelling. List the stressed vowel (and any following consonants) of every line-ending word, then decide which lines rhyme:
- Perfect rhyme: identical stressed vowel plus identical following sounds (e.g., fray/day/bay/way; night/light).
- Near rhyme / slant rhyme is acceptable when perfect rhyme would distort meaning: a matching stressed vowel with a different tail, or a different vowel with a matching tail (e.g., move /muːv/ and love /lʌv/ share final /v/, not the stressed vowel). Prefer a defensible near rhyme over an invented phrase.
- Words whose endings differ in both vowel and consonant structure do NOT rhyme (e.g., night / woodcutter / silence are not rhymes).
Common schemes: AAAA (monorhyme), AABB (couplets), ABAB (alternating), ABBA (enclosed), XAXA (odd lines free). Mark each line's rhyming word and state the scheme actually used.
Rhyme is a formal goal subordinate to meaning: never add imagery the source lacks, change agency, distort meaning, or drop information to force a rhyme. When rhyme conflicts with fidelity, resolve in this order: first change the scheme (full rhyme to partial, motif, or alternating rhyme; e.g., keep an established opening couplet or echo one rhyme position later); if the conflict persists, keep the rhyme positions that already work and let the remaining lines follow meaning first — do not force the count. Partial or motif rhyme is a legitimate scheme choice and must not be marked as a defect for failing to complete every position.
Realize rhyme in a "phrasing first, scheme second" order: draft each verse unit for semantic accuracy and structural correspondence, letting line endings take their most faithful words without pre-committing to a scheme; then mark the sounds of the settled endings, find the rhyme pairs that already hold, and enumerate viable schemes (AAAA, AABB, ABAB, ABBA, AABA, AXBX, XAXA), preferring the one that changes the fewest settled endings at the least semantic cost; fill only the positions the scheme requires, with words that are simultaneously faithful; when a position cannot be filled without semantic damage, drop it (mark X, downgrading the scheme to partial or motif rhyme) rather than revising settled lines backward to force rhyme. Resolve unclear relations across the verse unit through grammar, voice, or prepositions rather than vague wording.`

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
