import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../../src/lib/db/migrate'
import { createWorkspaceModelProfilesRepo } from '../../src/lib/db/release-config-repositories'

describe('six-role workspace model profiles', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    migrate(db)
  })

  it('stores every execution role independently', () => {
    const repo = createWorkspaceModelProfilesRepo(db)
    const binding = (model: string, endpointId: number) => ({
      endpointId,
      model,
      contextWindow: endpointId * 10_000,
    })
    repo.upsert({
      direction: 'en_to_zh',
      defaultWorker: binding('worker', 1),
      mainAgent: binding('main', 2),
      reviewAgent: binding('review', 3),
      filterAgent: binding('filter', 4),
      orchestrateAgent: binding('orchestrate', 5),
      assembleAgent: binding('assemble', 6),
      editingAgent: binding('editing', 7),
    })

    expect(repo.get('en_to_zh')).toMatchObject({
      defaultWorker: { endpointId: 1, model: 'worker' },
      mainAgent: { endpointId: 2, model: 'main' },
      reviewAgent: { endpointId: 3, model: 'review' },
      filterAgent: { endpointId: 4, model: 'filter' },
      orchestrateAgent: { endpointId: 5, model: 'orchestrate' },
      assembleAgent: { endpointId: 6, model: 'assemble' },
      editingAgent: { endpointId: 7, model: 'editing' },
    })
    db.close()
  })

  it('migrates the former shared main binding into all four stages', () => {
    const row = db.prepare(`
      SELECT main_agent_json, review_agent_json, filter_agent_json,
             orchestrate_agent_json, assemble_agent_json
      FROM workspace_model_profiles
      WHERE direction='en_to_zh'
    `).get() as Record<string, string>

    expect(row.review_agent_json).toBe(row.main_agent_json)
    expect(row.filter_agent_json).toBe(row.main_agent_json)
    expect(row.orchestrate_agent_json).toBe(row.main_agent_json)
    expect(row.assemble_agent_json).toBe(row.main_agent_json)
    db.close()
  })
})
