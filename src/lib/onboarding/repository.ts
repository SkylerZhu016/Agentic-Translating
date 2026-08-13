import type Database from 'better-sqlite3'
import {
  endpointCapabilityProfileSchema,
  generatedPresetRevisionIdsSchema,
  onboardingStateSchema,
  type EndpointCapabilityProfile,
  type OnboardingState,
  type OnboardingUpdate,
} from './contracts'

interface OnboardingStateRow {
  schema_version: number
  completed_at: string | null
  dismissed_at: string | null
  last_doctor_run_at: string | null
  selected_endpoint_id: number | null
  generated_preset_revision_ids_json: string
}

interface EndpointCapabilityProfileRow {
  endpoint_id: number
  profile_json: string
  checked_at: string
  expires_at: string
  tested_model: string
  diagnostic_id: string
}

export class OnboardingDataError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'OnboardingDataError'
  }
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value)
  } catch (cause) {
    throw new OnboardingDataError(`Invalid JSON stored for ${label}`, { cause })
  }
}

function mapOnboardingState(row: OnboardingStateRow): OnboardingState {
  try {
    return onboardingStateSchema.parse({
      schemaVersion: row.schema_version,
      completedAt: row.completed_at,
      dismissedAt: row.dismissed_at,
      lastDoctorRunAt: row.last_doctor_run_at,
      selectedEndpointId: row.selected_endpoint_id,
      generatedPresetRevisionIds: generatedPresetRevisionIdsSchema.parse(
        parseJson(
          row.generated_preset_revision_ids_json,
          'onboarding generated preset revision ids',
        ),
      ),
    })
  } catch (cause) {
    if (cause instanceof OnboardingDataError) throw cause
    throw new OnboardingDataError('Invalid onboarding state stored in database', {
      cause,
    })
  }
}

function mapCapabilityProfile(
  row: EndpointCapabilityProfileRow,
): EndpointCapabilityProfile {
  try {
    const profile = endpointCapabilityProfileSchema.parse(
      parseJson(row.profile_json, `endpoint ${row.endpoint_id} capability profile`),
    )
    if (
      profile.endpointId !== row.endpoint_id ||
      profile.checkedAt !== row.checked_at ||
      profile.expiresAt !== row.expires_at ||
      profile.testedModel !== row.tested_model ||
      profile.diagnosticId !== row.diagnostic_id
    ) {
      throw new Error('Capability profile columns do not match profile_json')
    }
    return profile
  } catch (cause) {
    if (cause instanceof OnboardingDataError) throw cause
    throw new OnboardingDataError(
      `Invalid capability profile stored for endpoint ${row.endpoint_id}`,
      { cause },
    )
  }
}

export function createOnboardingRepository(db: Database.Database) {
  const ensureStateStmt = db.prepare(`
    INSERT OR IGNORE INTO onboarding_state (id, schema_version)
    VALUES (1, 1)
  `)
  const getStateStmt = db.prepare(`
    SELECT schema_version, completed_at, dismissed_at, last_doctor_run_at,
           selected_endpoint_id, generated_preset_revision_ids_json
    FROM onboarding_state
    WHERE id = 1
  `)
  const updateStateStmt = db.prepare(`
    UPDATE onboarding_state
    SET schema_version = @schema_version,
        completed_at = @completed_at,
        dismissed_at = @dismissed_at,
        last_doctor_run_at = @last_doctor_run_at,
        selected_endpoint_id = @selected_endpoint_id,
        generated_preset_revision_ids_json = @generated_preset_revision_ids_json,
        updated_at = datetime('now')
    WHERE id = 1
  `)
  const getCapabilityStmt = db.prepare(`
    SELECT endpoint_id, profile_json, checked_at, expires_at, tested_model,
           diagnostic_id
    FROM endpoint_capability_profiles
    WHERE endpoint_id = ?
  `)
  const saveCapabilityStmt = db.prepare(`
    INSERT INTO endpoint_capability_profiles (
      endpoint_id, profile_json, checked_at, expires_at, tested_model,
      diagnostic_id, created_at, updated_at
    ) VALUES (
      @endpoint_id, @profile_json, @checked_at, @expires_at, @tested_model,
      @diagnostic_id, datetime('now'), datetime('now')
    )
    ON CONFLICT(endpoint_id) DO UPDATE SET
      profile_json = excluded.profile_json,
      checked_at = excluded.checked_at,
      expires_at = excluded.expires_at,
      tested_model = excluded.tested_model,
      diagnostic_id = excluded.diagnostic_id,
      updated_at = datetime('now')
  `)

  const getState = (): OnboardingState => {
    ensureStateStmt.run()
    const row = getStateStmt.get() as OnboardingStateRow | undefined
    if (!row) {
      throw new OnboardingDataError('Onboarding state row is missing')
    }
    return mapOnboardingState(row)
  }

  const getCapabilityProfile = (
    endpointId: number,
  ): EndpointCapabilityProfile | null => {
    const row = getCapabilityStmt.get(
      endpointId,
    ) as EndpointCapabilityProfileRow | undefined
    return row ? mapCapabilityProfile(row) : null
  }

  return {
    getState,

    updateState(update: OnboardingUpdate): OnboardingState {
      const current = getState()
      const next = onboardingStateSchema.parse({ ...current, ...update })
      updateStateStmt.run({
        schema_version: next.schemaVersion,
        completed_at: next.completedAt,
        dismissed_at: next.dismissedAt,
        last_doctor_run_at: next.lastDoctorRunAt,
        selected_endpoint_id: next.selectedEndpointId,
        generated_preset_revision_ids_json: JSON.stringify(
          generatedPresetRevisionIdsSchema.parse(
            next.generatedPresetRevisionIds,
          ),
        ),
      })
      return getState()
    },

    getCapabilityProfile,

    saveCapabilityProfile(
      input: EndpointCapabilityProfile,
    ): EndpointCapabilityProfile {
      const profile = endpointCapabilityProfileSchema.parse(input)
      saveCapabilityStmt.run({
        endpoint_id: profile.endpointId,
        profile_json: JSON.stringify(profile),
        checked_at: profile.checkedAt,
        expires_at: profile.expiresAt,
        tested_model: profile.testedModel,
        diagnostic_id: profile.diagnosticId,
      })
      const stored = getCapabilityProfile(profile.endpointId)
      if (!stored) {
        throw new OnboardingDataError(
          `Capability profile was not stored for endpoint ${profile.endpointId}`,
        )
      }
      return stored
    },
  }
}
