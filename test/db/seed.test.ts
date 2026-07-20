import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../../src/lib/db/migrate'
import { seed } from '../../src/lib/db/seed'
import { createRepositories } from '../../src/lib/db/repositories'
import type { PromptTemplateRow } from '../../src/lib/db/repositories'

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

  it('also seeds the default builtin preset on first call', () => {
    seed(db)
    const presets = db.prepare('SELECT * FROM config_presets WHERE is_builtin = 1').all() as { id: number; name: string; is_builtin: number }[]
    expect(presets.length).toBeGreaterThanOrEqual(1)
    expect(presets[0].name).toBe('默认预设')
    expect(presets[0].is_builtin).toBe(1)
  })

  it('is idempotent — second seed call inserts no duplicates', () => {
    seed(db)
    seed(db)
    const repos = createRepositories(db)
    const builtins = repos.promptTemplates.list().filter(r => r.is_builtin === 1)
    expect(builtins.length).toBe(5)
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
