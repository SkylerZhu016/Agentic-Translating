import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { migrate } from '../../src/lib/db/migrate'
import { createRepositories } from '../../src/lib/db/repositories'
import {
  createOnboardingRepository,
  OnboardingDataError,
} from '../../src/lib/onboarding/repository'
import {
  getOnboardingStatus,
  updateOnboardingStatus,
} from '../../src/lib/onboarding/service'
import type { EndpointCapabilityProfile } from '../../src/lib/onboarding/contracts'

const openDatabases: Database.Database[] = []

function createDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  openDatabases.push(db)
  return db
}

function applyMigrationFiles(db: Database.Database, from: number, to: number) {
  const directory = path.join(process.cwd(), 'src', 'lib', 'db', 'migrations')
  const files = fs.readdirSync(directory).sort()
  for (const file of files) {
    const version = Number(file.match(/^(\d+)_/)?.[1])
    if (!Number.isInteger(version) || version < from || version > to) continue
    const sql = fs.readFileSync(path.join(directory, file), 'utf8')
    db.transaction(() => db.exec(sql))()
  }
}

function profile(endpointId: number): EndpointCapabilityProfile {
  return {
    endpointId,
    checkedAt: '2026-08-09T05:00:00.000Z',
    expiresAt: '2026-08-10T05:00:00.000Z',
    models: { supported: true, count: 2, error: null },
    chat: { supported: true, error: null },
    streaming: { supported: true, error: null },
    usage: { supported: false, error: 'usage_not_returned' },
    tools: { supported: true, error: null },
    reasoningContent: { supported: false, error: 'not_probed' },
    firstByteMs: 12,
    testedModel: 'model-a',
    diagnosticId: '6e09085c-51ca-46e5-95f6-e208122fc12a',
  }
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) db.close()
})

describe('migration 0010 onboarding and endpoint capability profiles', () => {
  it('creates the singleton state and capability tables on a fresh database', () => {
    const db = createDb()
    migrate(db)

    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string
      }>
    ).map((row) => row.name)
    expect(names).toContain('onboarding_state')
    expect(names).toContain('endpoint_capability_profiles')
    expect(
      (db.prepare('SELECT schema_version FROM onboarding_state WHERE id=1').get() as {
        schema_version: number
      }).schema_version,
    ).toBe(1)
  })

  it('upgrades a migration-8 database without changing existing data', () => {
    const db = createDb()
    applyMigrationFiles(db, 1, 8)
    db.prepare(
      "INSERT INTO endpoints (name, base_url, api_key) VALUES ('legacy','https://legacy.test','secret')",
    ).run()
    db.prepare(
      "INSERT INTO sessions (id, source_text, config_snapshot) VALUES ('legacy-session','text','{}')",
    ).run()

    applyMigrationFiles(db, 10, 10)

    expect(
      (db.prepare('SELECT name FROM endpoints WHERE id=1').get() as { name: string })
        .name,
    ).toBe('legacy')
    expect(
      (db.prepare("SELECT source_text FROM sessions WHERE id='legacy-session'").get() as {
        source_text: string
      }).source_text,
    ).toBe('text')
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM onboarding_state').get() as {
        count: number
      }).count,
    ).toBe(1)
  })
})

describe('onboarding repository and status service', () => {
  it('returns first-run guidance for an empty configuration', () => {
    const db = createDb()
    migrate(db)

    expect(getOnboardingStatus(db)).toEqual({
      state: {
        schemaVersion: 1,
        completedAt: null,
        dismissedAt: null,
        lastDoctorRunAt: null,
        selectedEndpointId: null,
        generatedPresetRevisionIds: [],
      },
      hasRunnableConfig: false,
      recommendedAction: 'start',
    })
  })

  it('recommends a non-blocking check for an existing runnable configuration', () => {
    const db = createDb()
    migrate(db)
    const repos = createRepositories(db)
    const endpointId = Number(
      repos.endpoints.insert({
        name: 'existing',
        base_url: 'https://existing.test',
        api_key: 'secret',
      }).lastInsertRowid,
    )
    repos.translatorAgents.insert({
      name: 'worker',
      endpoint_id: endpointId,
      model: 'model-a',
      prompt_override: null,
      sort_order: 0,
    })

    const status = getOnboardingStatus(db)
    expect(status.hasRunnableConfig).toBe(true)
    expect(status.recommendedAction).toBe('check_existing')
  })

  it('persists partial state updates and validates endpoint references', () => {
    const db = createDb()
    migrate(db)
    const endpointId = Number(
      createRepositories(db).endpoints.insert({
        name: 'selected',
        base_url: 'https://selected.test',
        api_key: '',
      }).lastInsertRowid,
    )

    const updated = updateOnboardingStatus(db, {
      dismissedAt: '2026-08-09T05:00:00.000Z',
      selectedEndpointId: endpointId,
      generatedPresetRevisionIds: ['preset-revision-1'],
    })
    expect(updated.state.dismissedAt).toBe('2026-08-09T05:00:00.000Z')
    expect(updated.state.selectedEndpointId).toBe(endpointId)
    expect(updated.state.generatedPresetRevisionIds).toEqual([
      'preset-revision-1',
    ])
    expect(updated.recommendedAction).toBe('none')
    expect(() =>
      updateOnboardingStatus(db, { selectedEndpointId: 999 }),
    ).toThrow('endpoint_not_found')
  })

  it('round-trips validated profiles, cascades them, and never stores endpoint keys', () => {
    const db = createDb()
    migrate(db)
    const endpointId = Number(
      createRepositories(db).endpoints.insert({
        name: 'provider',
        base_url: 'https://provider.test',
        api_key: 'do-not-leak',
      }).lastInsertRowid,
    )
    const repository = createOnboardingRepository(db)
    const stored = repository.saveCapabilityProfile(profile(endpointId))

    expect(stored).toEqual(profile(endpointId))
    const encoded = (
      db.prepare(
        'SELECT profile_json FROM endpoint_capability_profiles WHERE endpoint_id=?',
      ).get(endpointId) as { profile_json: string }
    ).profile_json
    expect(encoded).not.toContain('do-not-leak')

    createRepositories(db).endpoints.delete(endpointId)
    expect(repository.getCapabilityProfile(endpointId)).toBeNull()
  })

  it('raises a diagnosable error instead of discarding malformed JSON', () => {
    const db = createDb()
    migrate(db)
    db.prepare(`
      UPDATE onboarding_state
      SET generated_preset_revision_ids_json = 'not-json'
      WHERE id = 1
    `).run()

    expect(() => createOnboardingRepository(db).getState()).toThrow(
      OnboardingDataError,
    )
  })
})
