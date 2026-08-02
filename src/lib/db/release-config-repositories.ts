import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type {
  DirectionPromptBundle,
  ModelBinding,
  TranslationDirection,
} from '../contracts/vnext'

export interface WorkspaceModelProfile {
  direction: TranslationDirection
  defaultWorker: ModelBinding
  mainAgent: ModelBinding
  reviewAgent: ModelBinding
  filterAgent: ModelBinding
  orchestrateAgent: ModelBinding
  assembleAgent: ModelBinding
  editingAgent: ModelBinding
  updatedAt: string
}

export interface PromptBundleFamily {
  id: string
  name: string
  direction: TranslationDirection
  isBuiltin: boolean
  currentRevisionNo: number
  deletedAt: string | null
  currentRevision: {
    id: string
    revisionNo: number
    payload: DirectionPromptBundle
    createdAt: string
  }
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
}

export function createWorkspaceModelProfilesRepo(db: Database.Database) {
  return {
    get(direction: TranslationDirection): WorkspaceModelProfile | null {
      const row = db.prepare(
        'SELECT * FROM workspace_model_profiles WHERE direction=?',
      ).get(direction) as
        | {
            direction: TranslationDirection
            default_worker_json: string
            main_agent_json: string
            review_agent_json: string | null
            filter_agent_json: string | null
            orchestrate_agent_json: string | null
            assemble_agent_json: string | null
            editing_agent_json: string
            updated_at: string
          }
        | undefined
      if (!row) return null
      const mainAgent = parseJson<ModelBinding>(row.main_agent_json)
      return {
        direction: row.direction,
        defaultWorker: parseJson(row.default_worker_json),
        mainAgent,
        reviewAgent: row.review_agent_json
          ? parseJson(row.review_agent_json)
          : mainAgent,
        filterAgent: row.filter_agent_json
          ? parseJson(row.filter_agent_json)
          : mainAgent,
        orchestrateAgent: row.orchestrate_agent_json
          ? parseJson(row.orchestrate_agent_json)
          : mainAgent,
        assembleAgent: row.assemble_agent_json
          ? parseJson(row.assemble_agent_json)
          : mainAgent,
        editingAgent: parseJson(row.editing_agent_json),
        updatedAt: row.updated_at,
      }
    },
    upsert(profile: Omit<WorkspaceModelProfile, 'updatedAt'>) {
      db.prepare(`
        INSERT INTO workspace_model_profiles (
          direction, default_worker_json, main_agent_json,
          review_agent_json, filter_agent_json, orchestrate_agent_json,
          assemble_agent_json, editing_agent_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(direction) DO UPDATE SET
          default_worker_json=excluded.default_worker_json,
          main_agent_json=excluded.main_agent_json,
          review_agent_json=excluded.review_agent_json,
          filter_agent_json=excluded.filter_agent_json,
          orchestrate_agent_json=excluded.orchestrate_agent_json,
          assemble_agent_json=excluded.assemble_agent_json,
          editing_agent_json=excluded.editing_agent_json,
          updated_at=datetime('now')
      `).run(
        profile.direction,
        JSON.stringify(profile.defaultWorker),
        JSON.stringify(profile.mainAgent),
        JSON.stringify(profile.reviewAgent),
        JSON.stringify(profile.filterAgent),
        JSON.stringify(profile.orchestrateAgent),
        JSON.stringify(profile.assembleAgent),
        JSON.stringify(profile.editingAgent),
      )
      return this.get(profile.direction)!
    },
  }
}

function mapOfficialBundle(row: any): PromptBundleFamily {
  const payload: DirectionPromptBundle = {
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
    toolDescriptions: parseJson(row.tool_descriptions),
  }
  return {
    id: `official.${row.direction}`,
    name: row.direction === 'en_to_zh' ? '官方·英译中' : '官方·中译英',
    direction: row.direction,
    isBuiltin: true,
    currentRevisionNo: row.version,
    deletedAt: null,
    currentRevision: {
      id: `official.${row.direction}.v${row.version}`,
      revisionNo: row.version,
      payload,
      createdAt: row.created_at,
    },
  }
}

export function createPromptBundleFamiliesRepo(db: Database.Database) {
  const getCustom = (id: string): PromptBundleFamily | null => {
    const row = db.prepare(`
      SELECT f.*, r.id AS revision_id, r.payload_json, r.created_at AS revision_created_at
      FROM prompt_bundle_families f
      JOIN prompt_bundle_revisions r
        ON r.bundle_id=f.id AND r.revision_no=f.current_revision_no
      WHERE f.id=?
    `).get(id) as any
    if (!row) return null
    return {
      id: row.id,
      name: row.name,
      direction: row.direction,
      isBuiltin: row.is_builtin === 1,
      currentRevisionNo: row.current_revision_no,
      deletedAt: row.deleted_at,
      currentRevision: {
        id: row.revision_id,
        revisionNo: row.current_revision_no,
        payload: parseJson(row.payload_json),
        createdAt: row.revision_created_at,
      },
    }
  }

  return {
    list(direction?: TranslationDirection): PromptBundleFamily[] {
      const officialRows = db.prepare(`
        SELECT d.*
        FROM direction_prompt_bundles d
        JOIN (
          SELECT direction, MAX(version) AS version
          FROM direction_prompt_bundles
          WHERE is_builtin=1
          GROUP BY direction
        ) latest ON latest.direction=d.direction AND latest.version=d.version
        ORDER BY d.direction
      `).all() as any[]
      const customRows = db.prepare(`
        SELECT id FROM prompt_bundle_families
        WHERE deleted_at IS NULL
        ORDER BY updated_at DESC
      `).all() as Array<{ id: string }>
      return [
        ...officialRows.map(mapOfficialBundle),
        ...customRows.map((row) => getCustom(row.id)!),
      ].filter((bundle) => !direction || bundle.direction === direction)
    },
    get: getCustom,
    create(input: {
      name: string
      direction: TranslationDirection
      payload: DirectionPromptBundle
    }): PromptBundleFamily {
      const id = randomUUID()
      const revisionId = randomUUID()
      db.transaction(() => {
        db.prepare(`
          INSERT INTO prompt_bundle_families
            (id, name, direction, is_builtin, current_revision_no)
          VALUES (?, ?, ?, 0, 1)
        `).run(id, input.name, input.direction)
        db.prepare(`
          INSERT INTO prompt_bundle_revisions
            (id, bundle_id, revision_no, payload_json)
          VALUES (?, ?, 1, ?)
        `).run(revisionId, id, JSON.stringify(input.payload))
      })()
      return getCustom(id)!
    },
    createRevision(id: string, payload: DirectionPromptBundle) {
      const family = getCustom(id)
      if (!family || family.isBuiltin) return null
      const revisionNo = family.currentRevisionNo + 1
      db.transaction(() => {
        db.prepare(`
          INSERT INTO prompt_bundle_revisions
            (id, bundle_id, revision_no, payload_json)
          VALUES (?, ?, ?, ?)
        `).run(randomUUID(), id, revisionNo, JSON.stringify(payload))
        db.prepare(`
          UPDATE prompt_bundle_families
          SET current_revision_no=?, updated_at=datetime('now')
          WHERE id=? AND is_builtin=0
        `).run(revisionNo, id)
      })()
      return getCustom(id)
    },
    softDelete(id: string) {
      return db.prepare(`
        UPDATE prompt_bundle_families
        SET deleted_at=datetime('now'), updated_at=datetime('now')
        WHERE id=? AND is_builtin=0
      `).run(id)
    },
  }
}
