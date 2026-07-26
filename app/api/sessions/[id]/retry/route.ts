export const runtime = 'nodejs'

import { z } from 'zod'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import {
  startVNextFailedRetries,
  startVNextInvocationRetry,
} from '@/src/lib/orchestration/vnext-runner'

const retrySchema = z.union([
  z.object({
    invocationId: z.string().uuid(),
    configMode: z.enum(['frozen', 'current']).default('frozen'),
  }),
  z.object({
    target: z.discriminatedUnion('type', [
      z.object({ type: z.literal('invocations'), ids: z.array(z.string().uuid()).min(1) }),
      z.object({ type: z.literal('all_failed') }),
      z.object({
        type: z.literal('stage'),
        stage: z.enum(['review', 'filter', 'orchestrate', 'assemble']),
      }),
    ]),
    configMode: z.enum(['frozen', 'current']),
  }),
])

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
    const sessionId = (await params).id
    if ('invocationId' in parsed.data) {
      return Response.json(
        startVNextInvocationRetry(
          db,
          sessionId,
          parsed.data.invocationId,
          parsed.data.configMode,
        ),
        { status: 202 },
      )
    }
    if (parsed.data.target.type === 'stage') {
      return Response.json(
        {
          error: 'stage_retry_uses_session_run',
          message: '新版四阶段重试由会话运行器从失败节点续跑。',
        },
        { status: 409 },
      )
    }
    const ids =
      parsed.data.target.type === 'all_failed'
        ? null
        : parsed.data.target.ids
    const runs = ids
      ? ids.map((id, index) =>
          startVNextInvocationRetry(
            db,
            sessionId,
            id,
            parsed.data.configMode,
            index > 0,
          ),
        )
      : startVNextFailedRetries(db, sessionId, parsed.data.configMode)
    return Response.json({ runs }, { status: 202 })
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
