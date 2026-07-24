import type Database from 'better-sqlite3'
import type {
  AgentArchetype,
  AgentDirectionVariant,
  BuiltinDirection,
  DirectionPromptBundle,
  TranslationDirection,
  WorkflowPreset,
  WorkflowPresetContract,
  WorkflowPresetRevision,
  WorkspaceDraft,
} from '../contracts/vnext'

interface AgentArchetypeRow {
  id: string
  slug: string
  display_name_zh: string
  category: AgentArchetype['category']
  tags_json: string
  is_builtin: number
}

interface AgentVariantRow {
  id: string
  archetype_id: string
  direction: TranslationDirection
  catalog_name: string
  catalog_description: string
  role_prompt: string
  prompt_language: 'zh' | 'en'
  prompt_version: number
  enabled: number
  endpoint_override_id: number | null
  model_override: string | null
  sort_order: number
}

interface PromptBundleRow {
  direction: TranslationDirection
  version: number
  prompt_language: 'zh' | 'en'
  main_agent_prompt: string
  worker_base_prompt: string
  review_prompt: string
  filter_prompt: string
  orchestrate_prompt: string
  assemble_prompt: string
  editing_prompt: string
  tool_descriptions: string
}

interface WorkspaceDraftRow {
  direction: BuiltinDirection
  source_text: string
  task_brief: string
  selected_preset_revision_id: string | null
  allowed_agent_variant_ids: string
  review_mode: WorkspaceDraft['reviewMode']
  updated_at: string
}

interface WorkflowPresetRow {
  id: string
  name: string
  description: string
  direction: TranslationDirection
  current_revision_no: number
  deleted_at: string | null
  created_at: string
  updated_at: string
}

interface WorkflowPresetRevisionRow {
  id: string
  preset_id: string
  revision_no: number
  contract_json: string
  created_at: string
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function mapArchetype(row: AgentArchetypeRow): AgentArchetype {
  return {
    id: row.id,
    slug: row.slug,
    displayNameZh: row.display_name_zh,
    category: row.category,
    tags: parseJson<string[]>(row.tags_json, []),
    isBuiltin: row.is_builtin === 1,
  }
}

function mapVariant(row: AgentVariantRow): AgentDirectionVariant {
  return {
    id: row.id,
    archetypeId: row.archetype_id,
    direction: row.direction,
    catalogName: row.catalog_name,
    catalogDescription: row.catalog_description,
    rolePrompt: row.role_prompt,
    promptLanguage: row.prompt_language,
    promptVersion: row.prompt_version,
    enabled: row.enabled === 1,
    endpointOverrideId: row.endpoint_override_id,
    modelOverride: row.model_override,
    sortOrder: row.sort_order,
  }
}

function mapBundle(row: PromptBundleRow): DirectionPromptBundle {
  return {
    direction: row.direction,
    version: row.version,
    promptLanguage: row.prompt_language,
    mainAgentSystemPrompt: row.main_agent_prompt,
    workerBasePrompt: row.worker_base_prompt,
    reviewPrompt: row.review_prompt,
    filterPrompt: row.filter_prompt,
    orchestratePrompt: row.orchestrate_prompt,
    assemblePrompt: row.assemble_prompt,
    editingPrompt: row.editing_prompt,
    toolDescriptions: parseJson<Record<string, string>>(row.tool_descriptions, {}),
  }
}

function mapDraft(row: WorkspaceDraftRow): WorkspaceDraft {
  return {
    direction: row.direction,
    sourceText: row.source_text,
    taskBrief: row.task_brief,
    selectedPresetRevisionId: row.selected_preset_revision_id,
    allowedAgentVariantIds: parseJson<string[]>(row.allowed_agent_variant_ids, []),
    reviewMode: row.review_mode,
    updatedAt: row.updated_at,
  }
}

function mapPreset(row: WorkflowPresetRow): WorkflowPreset {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    direction: row.direction,
    currentRevisionNo: row.current_revision_no,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapRevision(row: WorkflowPresetRevisionRow): WorkflowPresetRevision {
  return {
    id: row.id,
    presetId: row.preset_id,
    revisionNo: row.revision_no,
    contract: parseJson<WorkflowPresetContract>(row.contract_json, {} as WorkflowPresetContract),
    createdAt: row.created_at,
  }
}

export function createAgentCatalogueRepo(db: Database.Database) {
  const listArchetypesStmt = db.prepare('SELECT * FROM agent_archetypes ORDER BY is_builtin DESC, created_at, id')
  const getArchetypeStmt = db.prepare('SELECT * FROM agent_archetypes WHERE id = ?')
  const listVariantsStmt = db.prepare(
    'SELECT * FROM agent_direction_variants WHERE direction = ? ORDER BY sort_order, id',
  )
  const listEnabledVariantsStmt = db.prepare(
    'SELECT * FROM agent_direction_variants WHERE direction = ? AND enabled = 1 ORDER BY sort_order, id',
  )
  const getVariantStmt = db.prepare('SELECT * FROM agent_direction_variants WHERE id = ?')
  const updateVariantStmt = db.prepare(`
    UPDATE agent_direction_variants SET
      catalog_name=@catalog_name,
      catalog_description=@catalog_description,
      role_prompt=@role_prompt,
      enabled=@enabled,
      endpoint_override_id=@endpoint_override_id,
      model_override=@model_override,
      sort_order=@sort_order,
      updated_at=datetime('now')
    WHERE id=@id
  `)
  const insertArchetypeStmt = db.prepare(`
    INSERT INTO agent_archetypes
      (id, slug, display_name_zh, category, tags_json, is_builtin)
    VALUES
      (@id, @slug, @display_name_zh, @category, @tags_json, 0)
  `)
  const insertVariantStmt = db.prepare(`
    INSERT INTO agent_direction_variants
      (id, archetype_id, direction, catalog_name, catalog_description,
       role_prompt, prompt_language, prompt_version, enabled,
       endpoint_override_id, model_override, sort_order)
    VALUES
      (@id, @archetype_id, @direction, @catalog_name, @catalog_description,
       @role_prompt, @prompt_language, 1, @enabled,
       @endpoint_override_id, @model_override, @sort_order)
  `)
  const deleteArchetypeStmt = db.prepare(
    'DELETE FROM agent_archetypes WHERE id = ? AND is_builtin = 0',
  )

  return {
    listArchetypes: () => (listArchetypesStmt.all() as AgentArchetypeRow[]).map(mapArchetype),
    getArchetype: (id: string) => {
      const row = getArchetypeStmt.get(id) as AgentArchetypeRow | undefined
      return row ? mapArchetype(row) : null
    },
    listVariants: (direction: TranslationDirection, includeDisabled = true) => {
      const rows = (includeDisabled ? listVariantsStmt : listEnabledVariantsStmt).all(
        direction,
      ) as AgentVariantRow[]
      return rows.map(mapVariant)
    },
    getVariant: (id: string) => {
      const row = getVariantStmt.get(id) as AgentVariantRow | undefined
      return row ? mapVariant(row) : null
    },
    updateVariant: (variant: AgentDirectionVariant) =>
      updateVariantStmt.run({
        id: variant.id,
        catalog_name: variant.catalogName,
        catalog_description: variant.catalogDescription,
        role_prompt: variant.rolePrompt,
        enabled: variant.enabled ? 1 : 0,
        endpoint_override_id: variant.endpointOverrideId,
        model_override: variant.modelOverride,
        sort_order: variant.sortOrder,
      }),
    createCustom: (archetype: AgentArchetype, variants: AgentDirectionVariant[]) =>
      db.transaction(() => {
        insertArchetypeStmt.run({
          id: archetype.id,
          slug: archetype.slug,
          display_name_zh: archetype.displayNameZh,
          category: archetype.category,
          tags_json: JSON.stringify(archetype.tags),
        })
        for (const variant of variants) {
          insertVariantStmt.run({
            id: variant.id,
            archetype_id: archetype.id,
            direction: variant.direction,
            catalog_name: variant.catalogName,
            catalog_description: variant.catalogDescription,
            role_prompt: variant.rolePrompt,
            prompt_language: variant.promptLanguage,
            enabled: variant.enabled ? 1 : 0,
            endpoint_override_id: variant.endpointOverrideId,
            model_override: variant.modelOverride,
            sort_order: variant.sortOrder,
          })
        }
      })(),
    deleteCustom: (id: string) => deleteArchetypeStmt.run(id),
  }
}

export function createDirectionPromptRepo(db: Database.Database) {
  const getLatestStmt = db.prepare(
    'SELECT * FROM direction_prompt_bundles WHERE direction = ? ORDER BY version DESC LIMIT 1',
  )
  const getVersionStmt = db.prepare(
    'SELECT * FROM direction_prompt_bundles WHERE direction = ? AND version = ?',
  )
  const insertCustomStmt = db.prepare(`
    INSERT INTO direction_prompt_bundles
      (direction, version, prompt_language, main_agent_prompt,
       worker_base_prompt, review_prompt, filter_prompt, orchestrate_prompt,
       assemble_prompt, editing_prompt, tool_descriptions, is_builtin)
    VALUES
      ('custom', @version, @prompt_language, @main_agent_prompt,
       @worker_base_prompt, @review_prompt, @filter_prompt, @orchestrate_prompt,
       @assemble_prompt, @editing_prompt, @tool_descriptions, 0)
  `)

  return {
    getLatest: (direction: TranslationDirection) => {
      const row = getLatestStmt.get(direction) as PromptBundleRow | undefined
      return row ? mapBundle(row) : null
    },
    getVersion: (direction: TranslationDirection, version: number) => {
      const row = getVersionStmt.get(direction, version) as PromptBundleRow | undefined
      return row ? mapBundle(row) : null
    },
    createCustom: (
      bundle: Omit<DirectionPromptBundle, 'direction' | 'version'>,
    ) => {
      const latest = getLatestStmt.get('custom') as PromptBundleRow | undefined
      const version = (latest?.version ?? 0) + 1
      insertCustomStmt.run({
        version,
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
      return mapBundle(
        getVersionStmt.get('custom', version) as PromptBundleRow,
      )
    },
  }
}

export function createWorkspaceDraftsRepo(db: Database.Database) {
  const getStmt = db.prepare('SELECT * FROM workspace_drafts WHERE direction = ?')
  const upsertStmt = db.prepare(`
    INSERT INTO workspace_drafts
      (direction, source_text, task_brief, selected_preset_revision_id,
       allowed_agent_variant_ids, review_mode, updated_at)
    VALUES
      (@direction, @source_text, @task_brief, @selected_preset_revision_id,
       @allowed_agent_variant_ids, @review_mode, datetime('now'))
    ON CONFLICT(direction) DO UPDATE SET
      source_text=excluded.source_text,
      task_brief=excluded.task_brief,
      selected_preset_revision_id=excluded.selected_preset_revision_id,
      allowed_agent_variant_ids=excluded.allowed_agent_variant_ids,
      review_mode=excluded.review_mode,
      updated_at=datetime('now')
  `)
  const clearStmt = db.prepare(`
    UPDATE workspace_drafts SET source_text='', task_brief='',
      selected_preset_revision_id=NULL, allowed_agent_variant_ids='[]',
      review_mode='main_editor', updated_at=datetime('now')
    WHERE direction=?
  `)

  return {
    get: (direction: BuiltinDirection) => {
      const row = getStmt.get(direction) as WorkspaceDraftRow | undefined
      return row ? mapDraft(row) : null
    },
    upsert: (draft: Omit<WorkspaceDraft, 'updatedAt'>) =>
      upsertStmt.run({
        direction: draft.direction,
        source_text: draft.sourceText,
        task_brief: draft.taskBrief,
        selected_preset_revision_id: draft.selectedPresetRevisionId,
        allowed_agent_variant_ids: JSON.stringify(draft.allowedAgentVariantIds),
        review_mode: draft.reviewMode,
      }),
    clear: (direction: BuiltinDirection) => clearStmt.run(direction),
  }
}

export function createWorkflowPresetsRepo(db: Database.Database) {
  const listStmt = db.prepare(`
    SELECT * FROM workflow_presets
    WHERE (@include_deleted = 1 OR deleted_at IS NULL)
      AND (@direction = '' OR direction = @direction)
    ORDER BY updated_at DESC, id
  `)
  const getStmt = db.prepare('SELECT * FROM workflow_presets WHERE id = ?')
  const insertStmt = db.prepare(`
    INSERT INTO workflow_presets
      (id, name, description, direction, current_revision_no)
    VALUES (@id, @name, @description, @direction, 1)
  `)
  const updateMetaStmt = db.prepare(`
    UPDATE workflow_presets SET
      name=@name, description=@description, updated_at=datetime('now')
    WHERE id=@id
  `)
  const setCurrentRevisionStmt = db.prepare(`
    UPDATE workflow_presets SET
      current_revision_no=@revision_no, updated_at=datetime('now')
    WHERE id=@id
  `)
  const softDeleteStmt = db.prepare(
    "UPDATE workflow_presets SET deleted_at=datetime('now'), updated_at=datetime('now') WHERE id=?",
  )
  const restoreStmt = db.prepare(
    "UPDATE workflow_presets SET deleted_at=NULL, updated_at=datetime('now') WHERE id=?",
  )
  const listRevisionsStmt = db.prepare(
    'SELECT * FROM workflow_preset_revisions WHERE preset_id = ? ORDER BY revision_no DESC',
  )
  const getRevisionStmt = db.prepare(
    'SELECT * FROM workflow_preset_revisions WHERE id = ?',
  )
  const getRevisionByNoStmt = db.prepare(
    'SELECT * FROM workflow_preset_revisions WHERE preset_id = ? AND revision_no = ?',
  )
  const insertRevisionStmt = db.prepare(`
    INSERT INTO workflow_preset_revisions
      (id, preset_id, revision_no, contract_json)
    VALUES (@id, @preset_id, @revision_no, @contract_json)
  `)

  return {
    list: (direction?: TranslationDirection, includeDeleted = false) =>
      (
        listStmt.all({
          direction: direction ?? '',
          include_deleted: includeDeleted ? 1 : 0,
        }) as WorkflowPresetRow[]
      ).map(mapPreset),
    get: (id: string) => {
      const row = getStmt.get(id) as WorkflowPresetRow | undefined
      return row ? mapPreset(row) : null
    },
    create: (
      preset: Pick<WorkflowPreset, 'id' | 'name' | 'description' | 'direction'>,
      revision: WorkflowPresetRevision,
    ) =>
      db.transaction(() => {
        insertStmt.run({
          id: preset.id,
          name: preset.name,
          description: preset.description,
          direction: preset.direction,
        })
        insertRevisionStmt.run({
          id: revision.id,
          preset_id: preset.id,
          revision_no: 1,
          contract_json: JSON.stringify(revision.contract),
        })
      })(),
    updateMeta: (id: string, name: string, description: string) =>
      updateMetaStmt.run({ id, name, description }),
    addRevision: (revision: WorkflowPresetRevision) =>
      db.transaction(() => {
        insertRevisionStmt.run({
          id: revision.id,
          preset_id: revision.presetId,
          revision_no: revision.revisionNo,
          contract_json: JSON.stringify(revision.contract),
        })
        setCurrentRevisionStmt.run({
          id: revision.presetId,
          revision_no: revision.revisionNo,
        })
      })(),
    listRevisions: (presetId: string) =>
      (listRevisionsStmt.all(presetId) as WorkflowPresetRevisionRow[]).map(mapRevision),
    getRevision: (id: string) => {
      const row = getRevisionStmt.get(id) as WorkflowPresetRevisionRow | undefined
      return row ? mapRevision(row) : null
    },
    getRevisionByNo: (presetId: string, revisionNo: number) => {
      const row = getRevisionByNoStmt.get(
        presetId,
        revisionNo,
      ) as WorkflowPresetRevisionRow | undefined
      return row ? mapRevision(row) : null
    },
    setCurrentRevision: (id: string, revisionNo: number) =>
      setCurrentRevisionStmt.run({ id, revision_no: revisionNo }),
    softDelete: (id: string) => softDeleteStmt.run(id),
    restore: (id: string) => restoreStmt.run(id),
  }
}

export function createVNextRepositories(db: Database.Database) {
  return {
    agents: createAgentCatalogueRepo(db),
    directionPrompts: createDirectionPromptRepo(db),
    workspaceDrafts: createWorkspaceDraftsRepo(db),
    workflowPresets: createWorkflowPresetsRepo(db),
  }
}
