export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { onboardingUpdateSchema } from '@/src/lib/onboarding/contracts'
import {
  getOnboardingStatus,
  OnboardingReferenceError,
  updateOnboardingStatus,
} from '@/src/lib/onboarding/service'

function ensureDb() {
  const db = getDb()
  migrate(db)
  return db
}

export async function GET() {
  try {
    return NextResponse.json(getOnboardingStatus(ensureDb()))
  } catch {
    return NextResponse.json(
      { error: 'Failed to read onboarding status' },
      { status: 500 },
    )
  }
}

export async function PUT(request: Request) {
  const body = await request.json().catch(() => null)
  if (body == null) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = onboardingUpdateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 },
    )
  }

  try {
    return NextResponse.json(updateOnboardingStatus(ensureDb(), parsed.data))
  } catch (error) {
    if (
      error instanceof OnboardingReferenceError &&
      error.code === 'endpoint_not_found'
    ) {
      return NextResponse.json({ error: 'Endpoint not found' }, { status: 404 })
    }
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.flatten() },
        { status: 400 },
      )
    }
    return NextResponse.json(
      { error: 'Failed to update onboarding status' },
      { status: 500 },
    )
  }
}
