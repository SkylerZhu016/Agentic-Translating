import type Database from 'better-sqlite3'
import { createRepositories } from './repositories'
import {
  BUILTIN_AGENT_ARCHETYPES,
  BUILTIN_AGENT_VARIANTS,
  BUILTIN_DIRECTION_BUNDLES,
} from '../prompts/bidirectional'

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name),
  )
}

function seedVNext(db: Database.Database): void {
  if (!tableExists(db, 'agent_archetypes')) return

  const insertArchetype = db.prepare(`
    INSERT INTO agent_archetypes
      (id, slug, display_name_zh, category, tags_json, is_builtin, updated_at)
    VALUES
      (@id, @slug, @display_name_zh, @category, @tags_json, 1, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      display_name_zh=excluded.display_name_zh,
      category=excluded.category,
      tags_json=excluded.tags_json,
      is_builtin=1,
      updated_at=datetime('now')
  `)

  const insertVariant = db.prepare(`
    INSERT INTO agent_direction_variants
      (id, archetype_id, direction, catalog_name, catalog_description,
       role_prompt, prompt_language, prompt_version, enabled,
       endpoint_override_id, model_override, sort_order, updated_at)
    VALUES
      (@id, @archetype_id, @direction, @catalog_name, @catalog_description,
       @role_prompt, @prompt_language, @prompt_version, @enabled,
       @endpoint_override_id, @model_override, @sort_order, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      catalog_name=excluded.catalog_name,
      catalog_description=excluded.catalog_description,
      role_prompt=CASE
        WHEN excluded.prompt_version > agent_direction_variants.prompt_version
        THEN excluded.role_prompt ELSE agent_direction_variants.role_prompt END,
      prompt_language=excluded.prompt_language,
      prompt_version=MAX(agent_direction_variants.prompt_version, excluded.prompt_version),
      sort_order=excluded.sort_order,
      updated_at=datetime('now')
  `)

  const insertBundle = db.prepare(`
    INSERT OR IGNORE INTO direction_prompt_bundles
      (direction, version, prompt_language, main_agent_prompt,
       worker_base_prompt, review_prompt, filter_prompt, orchestrate_prompt,
       assemble_prompt, editing_prompt, tool_descriptions, is_builtin)
    VALUES
      (@direction, @version, @prompt_language, @main_agent_prompt,
       @worker_base_prompt, @review_prompt, @filter_prompt, @orchestrate_prompt,
       @assemble_prompt, @editing_prompt, @tool_descriptions, 1)
  `)

  db.transaction(() => {
    for (const archetype of BUILTIN_AGENT_ARCHETYPES) {
      insertArchetype.run({
        id: archetype.id,
        slug: archetype.slug,
        display_name_zh: archetype.displayNameZh,
        category: archetype.category,
        tags_json: JSON.stringify(archetype.tags),
      })
    }

    for (const variant of BUILTIN_AGENT_VARIANTS) {
      insertVariant.run({
        id: variant.id,
        archetype_id: variant.archetypeId,
        direction: variant.direction,
        catalog_name: variant.catalogName,
        catalog_description: variant.catalogDescription,
        role_prompt: variant.rolePrompt,
        prompt_language: variant.promptLanguage,
        prompt_version: variant.promptVersion,
        enabled: variant.enabled ? 1 : 0,
        endpoint_override_id: variant.endpointOverrideId,
        model_override: variant.modelOverride,
        sort_order: variant.sortOrder,
      })
    }

    for (const bundle of BUILTIN_DIRECTION_BUNDLES) {
      insertBundle.run({
        direction: bundle.direction,
        version: bundle.version,
        prompt_language: bundle.promptLanguage,
        main_agent_prompt: bundle.mainAgentSystemPrompt,
        worker_base_prompt: bundle.workerBasePrompt,
        review_prompt: bundle.reviewPrompt,
        filter_prompt: bundle.filterPrompt,
        orchestrate_prompt: bundle.orchestratePrompt,
        assemble_prompt: bundle.assemblePrompt,
        editing_prompt: bundle.editingPrompt,
        tool_descriptions: JSON.stringify(bundle.toolDescriptions),
      })
    }

    db.prepare(
      "INSERT OR IGNORE INTO workspace_drafts (direction) VALUES ('en_to_zh'), ('zh_to_en')",
    ).run()
    db.prepare(
      "INSERT OR IGNORE INTO settings (key, value) VALUES ('workspace_direction', 'en_to_zh')",
    ).run()
    db.prepare(
      "INSERT OR IGNORE INTO settings (key, value) VALUES ('suppress_direction_switch_warning', '0')",
    ).run()
    db.prepare(`
      INSERT INTO seed_versions (key, version, updated_at)
      VALUES ('vnext_builtin_agents', 10, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET version=excluded.version, updated_at=datetime('now')
    `).run()
  })()
}

/**
 * Seed the database with built-in Chinese prompt templates and default settings.
 *
 * Idempotent: checks for existing is_builtin=1 rows before inserting.
 * Designed to run on first startup (after migrate).
 */
export function seed(db: Database.Database): void {
  const repos = createRepositories(db)
  seedVNext(db)

  // Check if already seeded
  const existing = repos.promptTemplates.list().filter(r => r.is_builtin === 1)
  if (existing.length > 0) return

  // ── 1. Translator default ──────────────────────────────────────
  repos.promptTemplates.insert({
    kind: 'translator',
    name: '默认翻译',
    is_builtin: 1,
    content: `你是一位精通{{source_lang}}和{{target_lang}}的资深翻译家。你的翻译追求忠实、流畅、得体。

【任务】
将以下{{source_lang}}原文翻译为{{target_lang}}，严格遵循以下要求。

【原文】
{{source_text}}

{{extra_instructions}}

【翻译要求】

1. **忠实原意**：准确把握原文的语义、情感和信息，不得增删或曲解。每个句子、每个段落的核心意思都须在译文中得到完整传达。

2. **流畅自然**：译文应符合{{target_lang}}的表达习惯和语感，读来自然通顺。避免生硬的直译或翻译腔。对文化特定表达，可用目的语中功能对等的说法替换，但须保持整体意蕴一致。

3. **风格适配**：根据原文的文体特征（正式/口语、叙事/议论/抒情等），选择恰当的译文语体和措辞。原文中的修辞手法（比喻、排比、双关等）应尽量在译文中再现或找到等效表达。

4. **保留结构**：维持原文的段落划分和行文逻辑顺序。如有特殊排版格式，在译文中保留。

5. **自由输出**：你可以自由输出译文正文。如需添加注释或理由，请在正文后用一行 \`---\`（markdown 水平分割线）分隔，然后写注释。

你可以自由输出。如需添加注释/理由，请在正文后用一行 \`---\`（markdown 水平分割线）分隔，然后写注释。下游审查者只看正文不看注释，注释仅供人类归档参考。`,
  })

  // ── 2. Review ──────────────────────────────────────────────────
  repos.promptTemplates.insert({
    kind: 'review',
    name: '审查',
    is_builtin: 1,
    content: `你是一位严谨的翻译审校专家。请逐一评核以下每份译稿。

【原文】
{{source_text}}

【目标语言】{{target_lang}}

【待审译稿】
{{translations}}

【评核维度】

对每份译稿，从以下三个维度进行审视：

1. **忠实度**：译文是否准确传达了原文的语义和信息？有无遗漏、曲解、增译或偏离？关键术语和核心意思是否到位？
2. **流畅度**：译文是否自然通顺，符合{{target_lang}}的表达习惯？有无生硬、拗口或翻译腔？
3. **风格适配**：译文的语体、措辞、语气是否与原文文体匹配？修辞手法是否得到合理再现？整体审美是否达标？

请自由输出你的审查意见。如需添加注释/理由分析，请在正文后使用 \`---\` 分隔。

你可以自由输出。如需添加注释/理由，请在正文后用一行 \`---\`（markdown 水平分割线）分隔，然后写注释。下游审查者只看正文不看注释，注释仅供人类归档参考。`,
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

1. 优先保留质量上乘的译稿——忠实达意、表达流畅、风格与原文匹配。
2. 若某译稿在某个维度（忠实度/流畅度/风格）上明显优于其他译稿，即使在其他方面略有不足也可保留（多样性优先）。
3. 若多份译稿质量接近，优先保留风格各异者以供后续编排选择。
4. 若所有译稿均质量偏低，可全部淘汰，以便重译。
5. 淘汰原因须简要说明。

请自由输出筛选结果。如需添加注释/理由分析，请在正文后使用 \`---\` 分隔。

你可以自由输出。如需添加注释/理由，请在正文后用一行 \`---\`（markdown 水平分割线）分隔，然后写注释。下游审查者只看正文不看注释，注释仅供人类归档参考。`,
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

将原文按自然段落或意群划分为若干片段，为每个片段从入选译稿中挑选最佳翻译，并说明理由。

【编排原则】

1. **逐段择优**：每个片段独立选择最佳译文，不受其他片段干扰。
2. **可融合**：若某个片段的多个译稿各有可取之处，可融合其优点（但需明确说明融合策略）。
3. **整体和谐**：阐述整体编排思路——如何保证各片段拼接后风格统一、语体连贯。
4. **理由具体**：每个选段理由须具体到具体的词句或表达，而非笼统评价。

请自由输出编排方案。如需添加注释/理由分析，请在正文后使用 \`---\` 分隔。

你可以自由输出。如需添加注释/理由，请在正文后用一行 \`---\`（markdown 水平分割线）分隔，然后写注释。下游审查者只看正文不看注释，注释仅供人类归档参考。`,
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

1. **遵循编排**：按照编排方案的总体安排将各片段拼接，尊重编排时对每个片段的择优判断。
2. **衔接自然**：检查片段之间的过渡是否自然流畅——调整断句、衔接词或语气，使全文气韵贯通。
3. **风格统一**：确保全篇用词风格、语体、语气保持一致。若各片段因来源不同导致风格差异，进行微调使之和谐。
4. **整体通读**：将组装后的全文从头到尾通读，检查是否有不一致、不连贯之处，调整使阅读体验顺畅完整。
5. **最小改动**：只做必要的衔接与校验性调整，不擅自"优化"已有译文。

请自由输出最终译文。如需添加注释/理由分析，请在正文后使用 \`---\` 分隔。

你可以自由输出。如需添加注释/理由，请在正文后用一行 \`---\`（markdown 水平分割线）分隔，然后写注释。下游审查者只看正文不看注释，注释仅供人类归档参考。`,
  })

  // ── Default settings ──────────────────────────────────────────
  repos.settings.set({ key: 'suppress_flash_warning', value: '0' })
}
