export const runtime = 'nodejs'

import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { capabilityCheckRequestSchema } from '@/src/lib/onboarding/contracts'
import {
  EndpointCapabilityNotFoundError,
  runEndpointCapabilityCheck,
} from '@/src/lib/onboarding/capability-doctor'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const id = Number((await params).id)
  if (!Number.isInteger(id) || id < 1) {
    return Response.json({ error: 'invalid_endpoint_id' }, { status: 400 })
  }

  const rawBody = await request.text()
  let body: unknown = {}
  if (rawBody.trim()) {
    try {
      body = JSON.parse(rawBody)
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
  }
  const parsed = capabilityCheckRequestSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 },
    )
  }

  const db = getDb()
  migrate(db)
  try {
    const profile = await runEndpointCapabilityCheck(db, id, parsed.data)
    return Response.json(profile)
  } catch (error) {
    if (error instanceof EndpointCapabilityNotFoundError) {
      return Response.json({ error: 'endpoint_not_found' }, { status: 404 })
    }
    return Response.json(
      {
        error: 'capability_check_failed',
        diagnosticId: crypto.randomUUID(),
      },
      { status: 500 },
    )
  }
}
