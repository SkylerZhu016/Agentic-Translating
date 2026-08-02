export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { startVNextRun } from '@/src/lib/orchestration/vnext-runner'
import { z } from 'zod'

const bodySchema = z.object({
  configMode: z.enum(['frozen', 'current']).default('frozen'),
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
    const result = startVNextRun(db, id, parsed.data.configMode)
    return NextResponse.json(result, { status: result.reused ? 200 : 202 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === 'session_not_found') {
      return NextResponse.json({ error: message }, { status: 404 })
    }
    if (message.startsWith('invalid_session_state:')) {
      return NextResponse.json({ error: message }, { status: 409 })
    }
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
