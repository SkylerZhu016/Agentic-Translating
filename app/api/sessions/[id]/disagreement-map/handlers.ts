import type Database from 'better-sqlite3'
import { NextResponse } from 'next/server'
import type { DisagreementCandidate } from '@/src/lib/contracts/disagreement-map'
import { createRepositories } from '@/src/lib/db/repositories'
import { buildDisagreementMap } from '@/src/lib/evidence/disagreement-map'

interface StoredInvocation {
  id: string
  agent_variant_id: string
  agent_snapshot: string
  model: string
  status: string
  body_output: string | null
  replaces_invocation_id: string | null
  created_at: string
  insertion_order: number
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function retryRoot(
  row: StoredInvocation,
  byId: Map<string, StoredInvocation>,
): string {
  let current = row
  const visited = new Set<string>()
  while (
    current.replaces_invocation_id &&
    !visited.has(current.id)
  ) {
    visited.add(current.id)
    const parent = byId.get(current.replaces_invocation_id)
    if (!parent) break
    current = parent
  }
  return current.id
}

function toCandidate(row: StoredInvocation): DisagreementCandidate | null {
  let snapshot: Record<string, unknown>
  try {
    const parsed = JSON.parse(row.agent_snapshot) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    snapshot = parsed as Record<string, unknown>
  } catch {
    return null
  }

  if (
    snapshot.roleKind === 'context_analysis' ||
    snapshot.roleKind === 'poetry_plan' ||
    snapshot.archetypeId === 'cultural-context' ||
    snapshot.id === 'cultural-context'
  ) {
    return null
  }

  const body = row.body_output
  if (!body?.trim()) return null

  return {
    invocationId: row.id,
    agentName:
      nonEmptyString(snapshot.catalogName) ?? row.agent_variant_id,
    model: nonEmptyString(snapshot.model) ?? row.model,
    body,
  }
}

export function createHandlers(db: Database.Database) {
  const repos = createRepositories(db)

  return {
    async GET(
      _request: Request,
      { params }: { params: Promise<{ id: string }> },
    ) {
      const { id } = await params
      const session = repos.sessions.getById(id)
      if (!session) {
        return NextResponse.json(
          { error: 'session_not_found' },
          { status: 404 },
        )
      }

      const rows = db.prepare(`
        SELECT id, agent_variant_id, agent_snapshot, model, status,
               body_output, replaces_invocation_id, created_at,
               rowid AS insertion_order
        FROM agent_invocations
        WHERE session_id = ?
        ORDER BY created_at, insertion_order
      `).all(id) as StoredInvocation[]

      const byId = new Map(rows.map((row) => [row.id, row]))
      const latestSuccessfulByChain = new Map<string, StoredInvocation>()
      for (const row of rows) {
        if (row.status === 'complete' && row.body_output?.trim()) {
          latestSuccessfulByChain.set(retryRoot(row, byId), row)
        }
      }

      const candidates = [...latestSuccessfulByChain.values()]
        .map(toCandidate)
        .filter((candidate): candidate is DisagreementCandidate => candidate != null)

      const pinnedVersion = session.final_version_id == null
        ? null
        : repos.finalVersions.getById(session.final_version_id)
      const finalText =
        pinnedVersion?.session_id === id ? pinnedVersion.text : undefined

      const map = buildDisagreementMap({
        sourceText: session.source_text,
        candidates,
        ...(finalText === undefined ? {} : { finalText }),
      })

      return NextResponse.json(map, {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
      })
    },
  }
}
