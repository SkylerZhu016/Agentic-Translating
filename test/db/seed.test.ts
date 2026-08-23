import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../../src/lib/db/migrate'
import { seed } from '../../src/lib/db/seed'
import { createRepositories } from '../../src/lib/db/repositories'
import type { PromptTemplateRow } from '../../src/lib/db/repositories'
import {
  BUILTIN_AGENT_ARCHETYPES,
  BUILTIN_AGENT_VARIANTS,
} from '../../src/lib/prompts/bidirectional'

function createMemoryDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

const ALL_KINDS: PromptTemplateRow['kind'][] = [
  'translator', 'review', 'filter', 'orchestrate', 'assemble',
]

describe('seed — built-in prompt templates', () => {
  let db: Database.Database

  beforeEach(() => { db = createMemoryDb() })
  afterEach(() => { db.close() })

  it('inserts exactly 5 built-in templates on first call', () => {
    seed(db)
    const repos = createRepositories(db)
    const builtins = repos.promptTemplates.list().filter(r => r.is_builtin === 1)
    expect(builtins.length).toBe(5)
  })

  it('does not create a system workflow preset', () => {
    seed(db)
    const presets = db.prepare('SELECT * FROM config_presets WHERE is_builtin = 1').all() as { id: number; name: string; is_builtin: number }[]
    expect(presets).toHaveLength(0)
  })

  it('seeds exactly 10 archetypes and 20 direction variants', () => {
    seed(db)
    const archetypes = db.prepare('SELECT * FROM agent_archetypes').all()
    const variants = db.prepare(
      'SELECT direction, prompt_language FROM agent_direction_variants ORDER BY id',
    ).all() as Array<{ direction: string; prompt_language: string }>
    expect(archetypes).toHaveLength(10)
    expect(variants).toHaveLength(20)
    expect(variants.filter((item) => item.direction === 'en_to_zh')).toHaveLength(10)
    expect(variants.filter((item) => item.direction === 'zh_to_en')).toHaveLength(10)
    expect(
      variants
        .filter((item) => item.direction === 'en_to_zh')
        .every((item) => item.prompt_language === 'zh'),
    ).toBe(true)
    expect(
      variants
        .filter((item) => item.direction === 'zh_to_en')
        .every((item) => item.prompt_language === 'en'),
    ).toBe(true)
  })

  it('seeds independent direction prompt bundles without inventing user drafts', () => {
    seed(db)
    const bundles = db.prepare(
      'SELECT direction, prompt_language FROM direction_prompt_bundles ORDER BY direction',
    ).all()
    const drafts = db.prepare(
      'SELECT direction FROM workspace_drafts ORDER BY direction',
    ).all()
    expect(bundles).toEqual([
      { direction: 'en_to_zh', prompt_language: 'zh' },
      { direction: 'zh_to_en', prompt_language: 'en' },
    ])
    expect(drafts).toEqual([])
  })

  it('is idempotent — second seed call inserts no duplicates', () => {
    seed(db)
    seed(db)
    const repos = createRepositories(db)
    const builtins = repos.promptTemplates.list().filter(r => r.is_builtin === 1)
    expect(builtins.length).toBe(5)
  })

  it('official upgrades never modify a user-defined Agent', () => {
    seed(db)
    const archetypeId = 'user-agent-preservation-test'
    const variantId = `${archetypeId}.en_to_zh.1`
    db.prepare(`
      INSERT INTO agent_archetypes
        (id, slug, display_name_zh, category, tags_json, is_builtin)
      VALUES (?, ?, ?, 'expression', '["user"]', 0)
    `).run(archetypeId, archetypeId, '用户 Agent')
    db.prepare(`
      INSERT INTO agent_direction_variants
        (id, archetype_id, direction, catalog_name, catalog_description,
         role_prompt, prompt_language, prompt_version, enabled,
         endpoint_override_id, model_override, sort_order)
      VALUES (?, ?, 'en_to_zh', '用户 Agent', '用户说明',
              '用户自己的提示词', 'zh', 7, 0, NULL, 'user-model', 1234)
    `).run(variantId, archetypeId)
    const before = db.prepare(
      'SELECT * FROM agent_direction_variants WHERE id=?',
    ).get(variantId)

    seed(db)

    const after = db.prepare(
      'SELECT * FROM agent_direction_variants WHERE id=?',
    ).get(variantId)
    expect(after).toEqual(before)
  })

  it('does not claim or overwrite user rows that collide with official IDs', () => {
    const officialArchetype = BUILTIN_AGENT_ARCHETYPES[0]
    const officialVariant = BUILTIN_AGENT_VARIANTS.find(
      (variant) => variant.archetypeId === officialArchetype.id,
    )!
    db.prepare(`
      INSERT INTO agent_archetypes
        (id, slug, display_name_zh, category, tags_json, is_builtin)
      VALUES (?, ?, '用户碰撞 Agent', 'expression', '["private"]', 0)
    `).run(officialArchetype.id, 'user-owned-collision')
    db.prepare(`
      INSERT INTO agent_direction_variants
        (id, archetype_id, direction, catalog_name, catalog_description,
         role_prompt, prompt_language, prompt_version, enabled,
         endpoint_override_id, model_override, sort_order)
      VALUES (?, ?, ?, '用户碰撞变体', '不得被官方 seed 修改',
              '用户私有提示词', ?, 99, 0, NULL, 'private-model', 999)
    `).run(
      officialVariant.id,
      officialArchetype.id,
      officialVariant.direction,
      officialVariant.promptLanguage,
    )
    const beforeArchetype = db.prepare(
      'SELECT * FROM agent_archetypes WHERE id=?',
    ).get(officialArchetype.id)
    const beforeVariant = db.prepare(
      'SELECT * FROM agent_direction_variants WHERE id=?',
    ).get(officialVariant.id)

    seed(db)

    expect(db.prepare(
      'SELECT * FROM agent_archetypes WHERE id=?',
    ).get(officialArchetype.id)).toEqual(beforeArchetype)
    expect(db.prepare(
      'SELECT * FROM agent_direction_variants WHERE id=?',
    ).get(officialVariant.id)).toEqual(beforeVariant)
  })

  it('covers all 5 required kinds', () => {
    seed(db)
    const repos = createRepositories(db)
    const builtins = repos.promptTemplates.list().filter(r => r.is_builtin === 1)
    const kinds = builtins.map(r => r.kind).sort()
    expect(kinds).toEqual([...ALL_KINDS].sort())
  })

  it('each kind has exactly one built-in row', () => {
    seed(db)
    const repos = createRepositories(db)
    for (const kind of ALL_KINDS) {
      const rows = repos.promptTemplates.listByKind(kind).filter(r => r.is_builtin === 1)
      expect(rows.length, `kind=${kind} should have 1 built-in row`).toBe(1)
    }
  })

  it('all templates have non-empty name and content', () => {
    seed(db)
    const repos = createRepositories(db)
    const builtins = repos.promptTemplates.list().filter(r => r.is_builtin === 1)
    for (const t of builtins) {
      expect(t.name.length).toBeGreaterThan(0)
      expect(t.content.length).toBeGreaterThan(0)
    }
  })

  it('all templates are marked is_builtin=1', () => {
    seed(db)
    const repos = createRepositories(db)
    const all = repos.promptTemplates.list()
    const builtins = all.filter(r => r.is_builtin === 1)
    expect(builtins.length).toBe(5)
    for (const t of builtins) {
      expect(t.is_builtin).toBe(1)
    }
  })

  it('translator template contains all 4 required variables', () => {
    seed(db)
    const repos = createRepositories(db)
    const row = repos.promptTemplates.listByKind('translator')[0]
    expect(row).toBeDefined()
    expect(row.content).toContain('{{source_lang}}')
    expect(row.content).toContain('{{target_lang}}')
    expect(row.content).toContain('{{source_text}}')
    expect(row.content).toContain('{{extra_instructions}}')
  })

  it('review template instructs free-form output with --- separator', () => {
    seed(db)
    const repos = createRepositories(db)
    const row = repos.promptTemplates.listByKind('review')[0]
    expect(row).toBeDefined()
    // Free-form output convention: body + --- + notes
    expect(row.content).toContain('---')
    expect(row.content).toMatch(/自由输出|审查意见/)
  })

  it('filter template instructs free-form output with --- separator', () => {
    seed(db)
    const repos = createRepositories(db)
    const row = repos.promptTemplates.listByKind('filter')[0]
    expect(row).toBeDefined()
    expect(row.content).toContain('---')
    expect(row.content).toMatch(/自由输出|筛选/)
  })

  it('orchestrate template instructs free-form output with --- separator', () => {
    seed(db)
    const repos = createRepositories(db)
    const row = repos.promptTemplates.listByKind('orchestrate')[0]
    expect(row).toBeDefined()
    expect(row.content).toContain('---')
    expect(row.content).toMatch(/自由输出|编排/)
  })

  it('assemble template instructs free-form output with --- separator', () => {
    seed(db)
    const repos = createRepositories(db)
    const row = repos.promptTemplates.listByKind('assemble')[0]
    expect(row).toBeDefined()
    expect(row.content).toContain('---')
    expect(row.content).toMatch(/自由输出|最终译文/)
  })

  it('all four stage templates instruct free-form output (no strict JSON)', () => {
    seed(db)
    const repos = createRepositories(db)
    const stageKinds: PromptTemplateRow['kind'][] = ['review', 'filter', 'orchestrate', 'assemble']
    for (const kind of stageKinds) {
      const row = repos.promptTemplates.listByKind(kind)[0]
      // Each stage template must instruct free-form output (NOT strict JSON)
      expect(row.content, `kind=${kind} should NOT contain strict-JSON instruction`)
        .not.toMatch(/严格只输出/)
      // And must contain the free-form output clause
      expect(row.content, `kind=${kind} should contain free-form output clause`)
        .toMatch(/自由输出/)
    }
  })

  it('templates are model-agnostic — no vendor names mentioned', () => {
    seed(db)
    const repos = createRepositories(db)
    const builtins = repos.promptTemplates.list().filter(r => r.is_builtin === 1)
    const vendorPatterns = /\b(?:OpenAI|Gemini|Claude|Anthropic|DeepSeek|GPT|Llama|Mistral|Qwen|ERNIE|GLM|通义千问|文心一言|智谱|月之暗面)\b/i
    for (const t of builtins) {
      expect(t.content, `kind=${t.kind} should not mention vendor names`)
        .not.toMatch(vendorPatterns)
    }
  })

  it('templates are fully general — no poetry/hardcoded format terms', () => {
    seed(db)
    const repos = createRepositories(db)
    const builtins = repos.promptTemplates.list().filter(r => r.is_builtin === 1)
    // Must NOT contain: 五言, 七言, 诗歌, 平仄, 押韵, 格律, 音韵, 五字
    const poetryPatterns = /(?:五言|七言|诗歌|平仄|押韵|格律|音韵|五字|韵式|诗|词牌|律诗|绝句|古体|近体|新诗|现代诗)/i
    for (const t of builtins) {
      expect(t.content, `kind=${t.kind} should not contain poetry-specific terms`)
        .not.toMatch(poetryPatterns)
    }
  })
})

describe('seed — default settings', () => {
  let db: Database.Database

  beforeEach(() => { db = createMemoryDb() })
  afterEach(() => { db.close() })

  it('sets suppress_flash_warning to "0" on first seed', () => {
    seed(db)
    const repos = createRepositories(db)
    const setting = repos.settings.get('suppress_flash_warning')
    expect(setting).toBeDefined()
    expect(setting!.value).toBe('0')
  })

  it('does not overwrite existing settings on re-seed', () => {
    const repos = createRepositories(db)

    // First seed: inserts templates + sets suppress_flash_warning='0'
    seed(db)
    expect(repos.settings.get('suppress_flash_warning')!.value).toBe('0')

    // Change setting to '1' manually, simulating user change
    repos.settings.set({ key: 'suppress_flash_warning', value: '1' })

    // Re-seed: built-in templates already exist, so seed should skip entirely
    seed(db)

    // Verifying built-ins still at 5 (idempotent already tested above)
    // Setting should remain '1' because seed was skipped
    const after = repos.settings.get('suppress_flash_warning')
    expect(after!.value).toBe('1')
  })
})
