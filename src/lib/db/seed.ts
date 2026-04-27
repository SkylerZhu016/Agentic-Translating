import type Database from 'better-sqlite3'
import { createRepositories } from './repositories'

/**
 * Seed the database with built-in Chinese prompt templates and default settings.
 *
 * Idempotent: checks for existing is_builtin=1 rows before inserting.
 * Designed to run on first startup (after migrate).
 */
export function seed(db: Database.Database): void {
  const repos = createRepositories(db)

  // Check if already seeded
  const existing = repos.promptTemplates.list().filter(r => r.is_builtin === 1)
  if (existing.length > 0) return

  // ── 1. Translator default ──────────────────────────────────────
  repos.promptTemplates.insert({
    kind: 'translator',
    name: '默认翻译（诗歌级）',
    is_builtin: 1,
    content: `你是一位精通中英双语的资深文学翻译家，专攻诗歌翻译。你的翻译追求"信、达、雅"的至高境界。

【任务】
将以下{{source_lang}}原文翻译为{{target_lang}}，严格遵循以下要求。

【原文】
{{source_text}}

{{extra_instructions}}

【翻译要求】

1. **忠实原意**：准确把握原文的语义、情感和意境，不得增删或曲解。每一行、每一个意象都须在译文中得到对应体现。

2. **意象再现**：原文中的比喻、象征、典故等文学意象，须以目的语读者能够感知的方式再现。若直译难解，可用目的语文化中功能对等的意象替换，但须保持整体意蕴一致。

3. **音韵节奏**：
   - 若目的语为中文五言：严格每句五字，不得增减。注意平仄交替，押韵自然（可押交韵 ABAB、抱韵 ABBA 或偶句韵 AABA），避免凑字、凑韵导致的生硬表达。
   - 若目的语为其他格律：按相应格律要求处理音节/字数、节奏和韵式。

4. **保留结构**：维持原文的行数、节数和段落划分。若原文有特殊的排版或留白，在译文中予以保留。

5. **译文纯粹**：只输出译文正文，不添加任何解释、注释、标题或额外说明。

开始翻译，只输出译文。`,
  })

  // ── 2. Review ──────────────────────────────────────────────────
  repos.promptTemplates.insert({
    kind: 'review',
    name: '审查（诗歌级）',
    is_builtin: 1,
    content: `你是一位严谨的翻译审校专家，精通中英文学翻译批评。请逐一评核以下每份译稿。

【原文】
{{source_text}}

【目标语言】{{target_lang}}

【待审译稿】
{{translations}}

【评核维度】

对每份译稿，从以下三个维度进行审视：

1. **意象忠实度**：译文是否准确传达了原文的意象、隐喻和情感内涵？有无遗漏、曲解或偏离？
2. **格律合规**：译文在字数/音节、节奏、韵式等方面是否严格符合{{target_lang}}的格律规范？若目标为五言，每句是否严格五字？平仄与押韵是否自然？
3. **语言自然度**：译文读来是否流畅自然，符合目的语的语言习惯和审美标准？有无生硬、凑字或翻译腔？

【输出格式】

**严格只输出以下 JSON 格式，不要添加任何说明文字、markdown 标记或其他内容：**

{
  "assessments": [
    {
      "agent_id": "代理标识（对应上述译稿编号）",
      "strengths": ["优点一", "优点二", "..."],
      "weaknesses": ["不足一", "不足二", "..."],
      "quality_score": 7,
      "keep": true
    }
  ]
}

请开始评核，严格只输出 JSON。`,
  })

  // ── 3. Filter ─────────────────────────────────────────────────
  repos.promptTemplates.insert({
    kind: 'filter',
    name: '筛选',
    is_builtin: 1,
    content: `你是一位严格的翻译选稿人。根据以下审查结果，选出可进入最终编排的译稿。

【原文】
{{source_text}}

【审查结果】
{{review_output}}

【筛选标准】

1. quality_score ≥ 5 的译稿基本可考虑入选。
2. 若某译稿在某个维度上明显优于其他译稿，即使总分略低也可保留（多样性优先）。
3. 若多份译稿质量接近，优先保留风格各异者以供后续编排选择。
4. 若所有译稿均质量偏低（均分 < 3），可全部淘汰（selected_agent_ids 为空数组），以便重译。
5. 淘汰原因须在 rationale 中简要说明。

【输出格式】

**严格只输出以下 JSON 格式，不要添加任何说明文字、markdown 标记或其他内容：**

{
  "selected_agent_ids": ["入选代理标识"],
  "rationale": "筛选理由（简要说明为何选这些、淘汰那些）",
  "rejected_agent_ids": ["淘汰代理标识"]
}

请开始筛选，严格只输出 JSON。`,
  })

  // ── 4. Orchestrate ───────────────────────────────────────────
  repos.promptTemplates.insert({
    kind: 'orchestrate',
    name: '编排',
    is_builtin: 1,
    content: `你是一位翻译编排专家，擅长从多份译稿中撷取精华，构建最优译文。

【原文】
{{source_text}}

【入选译稿】
{{selected_translations}}

【审查结果】
{{review_output}}

【筛选结果】
{{filter_output}}

【编排任务】

将原文按行或自然段落划分为若干片段（segments），为每个片段从入选译稿中挑选最佳翻译，并说明理由。

【编排原则】

1. **逐段择优**：每个片段独立选择最佳译文，不受其他片段干扰。
2. **可融合**：若某个片段的多个译稿各有可取之处，可融合其优点（但需明确说明融合策略）。
3. **整体和谐**：在"结构说明"（structure_notes）中阐述整体编排思路——如何保证各片段拼接后风格统一、气韵连贯。
4. **理由具体**：每个选段理由须具体到字词或意象层面，而非笼统评价。

【输出格式】

**严格只输出以下 JSON 格式，不要添加任何说明文字、markdown 标记或其他内容：**

{
  "structure_notes": "整体编排思路说明",
  "segment_assignments": [
    {
      "segment_index": 0,
      "source_agent_id": "所选代理标识",
      "source_segment": "该片段在所选译稿中的原文（直接复制，不修改）",
      "rationale": "选择此段的理由（具体到字词意象）"
    }
  ]
}

请开始编排，严格只输出 JSON。`,
  })

  // ── 5. Assemble ───────────────────────────────────────────────
  repos.promptTemplates.insert({
    kind: 'assemble',
    name: '组装',
    is_builtin: 1,
    content: `你是一位译文总成专家，负责将编排结果组装为流畅完整的最终译文。

【原文】
{{source_text}}

【编排结果】
{{orchestrate_output}}

【入选译稿】
{{selected_translations}}

【组装任务】

按照编排方案将各片段拼接为完整译文，并进行必要的润色调整。

【组装原则】

1. **忠实编排**：严格按照编排结果将各片段拼接，不得擅自更换来源或改写。
2. **衔接自然**：检查片段之间的过渡是否自然流畅——调整断句、衔接词或语气，使全文气韵贯通。
3. **风格统一**：确保全篇用词风格、语体、节奏保持一致。若各片段来自不同译稿导致风格差异，进行微调使之和谐。
4. **格律校验**：
   - 若目的语为中文五言：逐句确认每句严格五字；检查全篇平仄交替与押韵是否自然；不合规处微调。
   - 若为其他格律：按相应规范校验校正。
5. **最小改动**：只做必要的衔接与校验性调整，不擅自"优化"已有译文。

【输出格式】

**严格只输出以下 JSON 格式，不要添加任何说明文字、markdown 标记或其他内容：**

{
  "final_text": "完整最终译文",
  "notes": "组装过程中的调整说明（列明每处改动及理由）"
}

请开始组装，严格只输出 JSON。`,
  })

  // ── Default settings ──────────────────────────────────────────
  repos.settings.set({ key: 'suppress_flash_warning', value: '0' })
}
