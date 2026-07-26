export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { restartVNextSession } from '@/src/lib/orchestration/vnext-runner'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const db = getDb()
  migrate(db)
  try {
    return NextResponse.json(restartVNextSession(db, id), { status: 202 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json(
      { error: message },
      { status: message === 'session_not_found' ? 404 : 400 },
    )
  }
}
