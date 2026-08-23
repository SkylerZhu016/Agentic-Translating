export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { startVNextDraftRegeneration } from '@/src/lib/orchestration/vnext-runner'
import { sessionPreflightErrorDto } from '@/src/lib/services/session-preflight'
import { z } from 'zod'

const bodySchema = z.object({
  configMode: z.enum(['frozen', 'current']).default('frozen'),
  candidateAnnotationMode: z
    .enum(['body_only', 'body_and_annotation'])
    .optional(),
})

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const db = getDb()
  migrate(db)
  try {
    const parsed = bodySchema.safeParse(
      await request.json().catch(() => ({})),
    )
    if (!parsed.success) {
      return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
    }
    return NextResponse.json(
      startVNextDraftRegeneration(
        db,
        id,
        parsed.data.candidateAnnotationMode,
        parsed.data.configMode,
      ),
      { status: 202 },
    )
  } catch (error) {
    const preflightError = sessionPreflightErrorDto(error)
    if (preflightError) {
      return NextResponse.json(preflightError.body, {
        status: preflightError.status,
      })
    }
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json(
      { error: message },
      {
        status:
          message === 'session_not_found'
            ? 404
            : message === 'session_run_still_active' ||
                message.startsWith('invalid_session_state:')
              ? 409
              : 400,
      },
    )
  }
}
