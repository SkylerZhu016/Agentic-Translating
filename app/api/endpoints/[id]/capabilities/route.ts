export const runtime = 'nodejs'

import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { createOnboardingRepository } from '@/src/lib/onboarding/repository'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const id = Number((await params).id)
  if (!Number.isInteger(id) || id < 1) {
    return Response.json({ error: 'invalid_endpoint_id' }, { status: 400 })
  }

  const db = getDb()
  migrate(db)
  const endpoint = db.prepare('SELECT 1 FROM endpoints WHERE id = ?').get(id)
  if (!endpoint) {
    return Response.json({ error: 'endpoint_not_found' }, { status: 404 })
  }

  try {
    const profile = createOnboardingRepository(db).getCapabilityProfile(id)
    if (!profile) {
      return Response.json(
        { error: 'capability_profile_not_found' },
        { status: 404 },
      )
    }
    if (Date.parse(profile.expiresAt) <= Date.now()) {
      return Response.json(
        {
          error: 'capability_profile_expired',
          checkedAt: profile.checkedAt,
          expiresAt: profile.expiresAt,
        },
        { status: 410 },
      )
    }
    return Response.json(profile)
  } catch {
    return Response.json(
      {
        error: 'invalid_capability_profile',
        diagnosticId: crypto.randomUUID(),
      },
      { status: 500 },
    )
  }
}
