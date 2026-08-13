export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { createRepositories } from '@/src/lib/db/repositories'
import { endpointUpdateSchema } from '@/src/lib/contracts/schemas'
import type {
  EndpointActiveReferenceSummary,
  EndpointHistoricalReferenceSummary,
  EndpointReferenceSummary,
} from '@/src/lib/contracts/endpoint-references'
import { toPublicEndpointDto } from '@/src/lib/security/public-dto'

function ensureDb() {
  const db = getDb()
  migrate(db)
  return { db, repos: createRepositories(db) }
}

const ENDPOINT_ID_KEYS = new Set([
  'endpointId',
  'endpoint_id',
  'chatEndpointId',
  'chat_endpoint_id',
])

const ENDPOINT_CONTAINER_KEYS = new Set([
  'endpoint',
  'endpoints',
  'endpointSnapshot',
  'endpointSnapshots',
  'endpoint_snapshot',
  'endpoint_snapshots',
])

function jsonReferencesEndpoint(
  value: unknown,
  endpointId: number,
  containerKey: string | null = null,
): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => jsonReferencesEndpoint(item, endpointId, containerKey))
  }
  if (value == null || typeof value !== 'object') return false

  for (const [key, child] of Object.entries(value)) {
    if (ENDPOINT_ID_KEYS.has(key) && child === endpointId) return true
    if (key === 'id' && ENDPOINT_CONTAINER_KEYS.has(containerKey ?? '') && child === endpointId) {
      return true
    }
    if (jsonReferencesEndpoint(child, endpointId, key)) return true
  }
  return false
}

function findJsonReferences(
  rows: Array<{ id: string; payload: string }>,
  endpointId: number,
): string[] {
  const references: string[] = []
  for (const row of rows) {
    try {
      if (jsonReferencesEndpoint(JSON.parse(row.payload), endpointId)) {
        references.push(row.id)
      }
    } catch {
      // A malformed historical snapshot is preserved and handled by its own
      // reader; it must never make endpoint deletion leak the stored payload.
    }
  }
  return references
}

function countBindingsInRows(
  rows: Array<Record<string, number | null>>,
  columns: readonly string[],
  endpointId: number,
): number {
  let count = 0
  for (const row of rows) {
    for (const column of columns) {
      if (row[column] === endpointId) count += 1
    }
  }
  return count
}

const MODEL_PROFILE_COLUMNS = [
  'default_worker_json',
  'main_agent_json',
  'review_agent_json',
  'filter_agent_json',
  'orchestrate_agent_json',
  'assemble_agent_json',
  'editing_agent_json',
] as const

function countWorkspaceModelProfileReferences(
  db: ReturnType<typeof getDb>,
  endpointId: number,
): number {
  const rows = db.prepare(`
    SELECT ${MODEL_PROFILE_COLUMNS.join(', ')}
    FROM workspace_model_profiles
  `).all() as Array<Record<string, string | null>>
  let count = 0
  for (const row of rows) {
    for (const column of MODEL_PROFILE_COLUMNS) {
      const encoded = row[column]
      if (!encoded) continue
      try {
        const binding = JSON.parse(encoded) as Record<string, unknown>
        if (binding.endpointId === endpointId) count += 1
      } catch {
        // Malformed unrelated profile data is left for its own validator.
      }
    }
  }
  return count
}

function collectEndpointReferences(
  db: ReturnType<typeof getDb>,
  endpointId: number,
): { references: EndpointReferenceSummary; usedBySessions: string[] } {
  const coordinatorRows = db.prepare(`
    SELECT endpoint_id, chat_endpoint_id FROM coordinator_config
  `).all() as Array<Record<string, number | null>>
  const presetCoordinatorRows = db.prepare(`
    SELECT endpoint_id, chat_endpoint_id FROM config_preset_coordinator
  `).all() as Array<Record<string, number | null>>

  const active: EndpointActiveReferenceSummary = {
    legacyAgents: Number(db.prepare(
      'SELECT COUNT(*) FROM translator_agents WHERE endpoint_id = ?',
    ).pluck().get(endpointId)),
    vnextAgentOverrides: Number(db.prepare(
      'SELECT COUNT(*) FROM agent_direction_variants WHERE endpoint_override_id = ?',
    ).pluck().get(endpointId)),
    coordinatorBindings: countBindingsInRows(
      coordinatorRows,
      ['endpoint_id', 'chat_endpoint_id'],
      endpointId,
    ),
    legacyPresetAgents: Number(db.prepare(
      'SELECT COUNT(*) FROM config_preset_agents WHERE endpoint_id = ?',
    ).pluck().get(endpointId)),
    legacyPresetCoordinatorBindings: countBindingsInRows(
      presetCoordinatorRows,
      ['endpoint_id', 'chat_endpoint_id'],
      endpointId,
    ),
    modelProfileBindings: countWorkspaceModelProfileReferences(db, endpointId),
    onboardingSelection: Number(db.prepare(
      'SELECT COUNT(*) FROM onboarding_state WHERE selected_endpoint_id = ?',
    ).pluck().get(endpointId)),
    capabilityProfiles: Number(db.prepare(
      'SELECT COUNT(*) FROM endpoint_capability_profiles WHERE endpoint_id = ?',
    ).pluck().get(endpointId)),
  }

  const usedBySessions = findJsonReferences(
    db.prepare('SELECT id, config_snapshot AS payload FROM sessions').all() as Array<{
      id: string
      payload: string
    }>,
    endpointId,
  )
  const workflowPresetRevisions = findJsonReferences(
    db.prepare(`
      SELECT id, contract_json AS payload FROM workflow_preset_revisions
    `).all() as Array<{ id: string; payload: string }>,
    endpointId,
  )
  const batchJobs = findJsonReferences(
    db.prepare('SELECT id, preset_snapshot AS payload FROM batch_jobs').all() as Array<{
      id: string
      payload: string
    }>,
    endpointId,
  )

  const historical: EndpointHistoricalReferenceSummary = {
    sessions: usedBySessions.length,
    workflowPresetRevisions: workflowPresetRevisions.length,
    batchJobs: batchJobs.length,
    agentInvocations: Number(db.prepare(
      'SELECT COUNT(*) FROM agent_invocations WHERE endpoint_id = ?',
    ).pluck().get(endpointId)),
    llmCalls: Number(db.prepare(
      'SELECT COUNT(*) FROM llm_call_records WHERE endpoint_id = ?',
    ).pluck().get(endpointId)),
  }

  return {
    references: {
      active,
      historical,
      totalActive: Object.values(active).reduce((sum, count) => sum + count, 0),
      totalHistorical: Object.values(historical).reduce((sum, count) => sum + count, 0),
    },
    usedBySessions,
  }
}

function clearWorkspaceModelProfileReferences(
  db: ReturnType<typeof getDb>,
  endpointId: number,
) {
  const rows = db.prepare(`
    SELECT direction, ${MODEL_PROFILE_COLUMNS.join(', ')}
    FROM workspace_model_profiles
  `).all() as Array<Record<string, string | null>>
  const update = db.prepare(`
    UPDATE workspace_model_profiles
    SET ${MODEL_PROFILE_COLUMNS.map((column) => `${column}=@${column}`).join(', ')},
        updated_at=datetime('now')
    WHERE direction=@direction
  `)

  for (const row of rows) {
    let changed = false
    const next: Record<string, string> = { direction: row.direction! }
    for (const column of MODEL_PROFILE_COLUMNS) {
      const encoded = row[column]
      if (!encoded) {
        next[column] = JSON.stringify({
          endpointId: null,
          model: '',
          contextWindow: null,
        })
        continue
      }
      try {
        const binding = JSON.parse(encoded) as Record<string, unknown>
        if (binding.endpointId === endpointId) {
          binding.endpointId = null
          next[column] = JSON.stringify(binding)
          changed = true
        } else {
          next[column] = encoded
        }
      } catch {
        // Malformed unrelated profile data is left for its own validator.
        next[column] = encoded
      }
    }
    if (changed) update.run(next)
  }
}

function forceDeleteEndpoint(
  db: ReturnType<typeof getDb>,
  endpointId: number,
) {
  db.transaction(() => {
    // Preserve every legacy and vNext Agent definition. Only the deleted
    // provider binding is removed so the user can rebind it later.
    db.prepare('UPDATE translator_agents SET endpoint_id = NULL WHERE endpoint_id = ?')
      .run(endpointId)
    db.prepare(`
      UPDATE coordinator_config
      SET endpoint_id = CASE WHEN endpoint_id = ? THEN NULL ELSE endpoint_id END,
          chat_endpoint_id = CASE
            WHEN chat_endpoint_id = ? THEN NULL ELSE chat_endpoint_id END,
          updated_at = datetime('now')
      WHERE endpoint_id = ? OR chat_endpoint_id = ?
    `).run(endpointId, endpointId, endpointId, endpointId)

    db.prepare('UPDATE config_preset_agents SET endpoint_id = NULL WHERE endpoint_id = ?')
      .run(endpointId)
    db.prepare(`
      UPDATE config_preset_coordinator
      SET endpoint_id = CASE WHEN endpoint_id = ? THEN NULL ELSE endpoint_id END,
          chat_endpoint_id = CASE
            WHEN chat_endpoint_id = ? THEN NULL ELSE chat_endpoint_id END
      WHERE endpoint_id = ? OR chat_endpoint_id = ?
    `).run(endpointId, endpointId, endpointId, endpointId)

    db.prepare(`
      UPDATE agent_direction_variants
      SET endpoint_override_id = NULL,
          updated_at = datetime('now')
      WHERE endpoint_override_id = ?
    `).run(endpointId)
    clearWorkspaceModelProfileReferences(db, endpointId)

    // FK enforcement remains enabled: profile rows cascade and onboarding's
    // selected endpoint is nulled as part of this same atomic transaction.
    db.prepare('DELETE FROM endpoints WHERE id = ?').run(endpointId)
  })()
}

// PUT /api/endpoints/[id] — update
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: idStr } = await params
    const id = Number(idStr)
    if (!Number.isFinite(id) || id < 1) {
      return NextResponse.json({ error: 'Invalid endpoint id' }, { status: 400 })
    }

    const body = await req.json().catch(() => null)
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

    const parsed = endpointUpdateSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 },
      )
    }

    const { db, repos } = ensureDb()
    const existing = repos.endpoints.getById(id)
    if (!existing) {
      return NextResponse.json({ error: 'Endpoint not found' }, { status: 404 })
    }

    repos.endpoints.update({
      id,
      name: parsed.data.name ?? existing.name,
      base_url: parsed.data.base_url ?? existing.base_url,
      chat_completions_path:
        parsed.data.chat_completions_path ??
        existing.chat_completions_path ??
        '/v1/chat/completions',
      api_key:
        parsed.data.api_key == null || parsed.data.api_key === ''
          ? existing.api_key
          : parsed.data.api_key,
      context_window:
        parsed.data.context_window === undefined
          ? existing.context_window ?? null
          : parsed.data.context_window,
    })

    // A capability profile describes the exact endpoint configuration that
    // was probed. Any edit (including key/path changes) invalidates it.
    db.prepare(
      'DELETE FROM endpoint_capability_profiles WHERE endpoint_id = ?',
    ).run(id)

    const updated = repos.endpoints.getById(id)
    return NextResponse.json(updated ? toPublicEndpointDto(updated) : null)
  } catch (e) {
    return NextResponse.json({ error: 'Failed to update endpoint' }, { status: 500 })
  }
}

// DELETE /api/endpoints/[id] — impact check, then optional atomic unbind/delete
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: idStr } = await params
    const id = Number(idStr)
    if (!Number.isFinite(id) || id < 1) {
      return NextResponse.json({ error: 'Invalid endpoint id' }, { status: 400 })
    }

    const { db, repos } = ensureDb()
    const existing = repos.endpoints.getById(id)
    if (!existing) {
      return NextResponse.json({ error: 'Endpoint not found' }, { status: 404 })
    }

    // A first-pass DELETE is a read-only impact check. The browser presents
    // this privacy-safe summary before it asks for an atomic force delete.
    const force = req.nextUrl.searchParams.get('force') === '1'
    const { references, usedBySessions } = collectEndpointReferences(db, id)

    if (!force && references.totalActive + references.totalHistorical > 0) {
      return NextResponse.json(
        {
          error: 'endpoint_references_exist',
          references,
          usedBySessions,
        },
        { status: 409 },
      )
    }

    // Force deletion atomically unbinds live configuration while frozen
    // session/workflow snapshots remain self-contained historical evidence.
    if (force) {
      forceDeleteEndpoint(db, id)
    } else {
      repos.endpoints.delete(id)
    }
    return NextResponse.json({ success: true })
  } catch (e) {
    return NextResponse.json({ error: 'Failed to delete endpoint' }, { status: 500 })
  }
}
