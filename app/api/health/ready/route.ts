export const runtime = 'nodejs'

import { getDb } from '@/src/lib/db'
import { migrate, getAppliedVersion } from '@/src/lib/db/migrate'

export async function GET() {
  const diagnosticId = crypto.randomUUID()
  const startupNonce = process.env.AGENTIC_DESKTOP_STARTUP_NONCE ?? null
  try {
    const db = getDb()
    migrate(db)
    const probe = db.prepare('SELECT 1 AS ok').get() as { ok: number }
    if (probe.ok !== 1) throw new Error('database_probe_failed')
    return Response.json({
      ready: true,
      migrationVersion: getAppliedVersion(db),
      diagnosticId,
      startupNonce,
    })
  } catch (error) {
    return Response.json(
      {
        ready: false,
        error: error instanceof Error ? error.message : String(error),
        diagnosticId,
        startupNonce,
      },
      { status: 503 },
    )
  }
}
