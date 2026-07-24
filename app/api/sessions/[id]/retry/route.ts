export const runtime = 'nodejs'

import { z } from 'zod'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { startVNextInvocationRetry } from '@/src/lib/orchestration/vnext-runner'

const retrySchema = z.object({
  invocationId: z.string().uuid(),
})

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const parsed = retrySchema.safeParse(
    await request.json().catch(() => null),
  )
  if (!parsed.success) {
    return Response.json({ error: 'invalid_body' }, { status: 400 })
  }
  const db = getDb()
  migrate(db)
  try {
    return Response.json(
      startVNextInvocationRetry(
        db,
        (await params).id,
        parsed.data.invocationId,
      ),
      { status: 202 },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status =
      message === 'session_not_found' || message === 'invocation_not_found'
        ? 404
        : message === 'session_run_still_active'
          ? 409
          : 400
    return Response.json({ error: message }, { status })
  }
}
