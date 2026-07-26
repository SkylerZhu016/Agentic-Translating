export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { requestVNextPause } from '@/src/lib/orchestration/vnext-runner'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const body = await request.json().catch(() => null) as {
    action?: string
  } | null
  if (body?.action !== 'pause') {
    return NextResponse.json({ error: 'invalid_action' }, { status: 400 })
  }
  const db = getDb()
  migrate(db)
  try {
    return NextResponse.json(requestVNextPause(db, id), { status: 202 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json(
      { error: message },
      { status: message === 'no_active_run' ? 409 : 400 },
    )
  }
}
