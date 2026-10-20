import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { readDesktopActivity } from './handlers'

export const runtime = 'nodejs'

export async function GET() {
  try {
    const db = getDb()
    migrate(db)
    return Response.json(
      { hasRunningWork: readDesktopActivity(db) },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch {
    return Response.json(
      { error: 'activity_unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}
