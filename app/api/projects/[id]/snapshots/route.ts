import { NextResponse } from 'next/server'
import {
  handleProjectRoute,
  parseParams,
  projectIdParamsSchema,
  projectRepositories,
} from '../../_shared'

export const runtime = 'nodejs'

export const GET = (
  _request: Request,
  context: { params: Promise<{ id: string }> },
) =>
  handleProjectRoute(async () => {
    const params = await parseParams(context.params, projectIdParamsSchema)
    if (!params.success) return params.response
    const snapshots = projectRepositories().snapshots.list(params.data.id)
    return NextResponse.json({ snapshots })
  })
