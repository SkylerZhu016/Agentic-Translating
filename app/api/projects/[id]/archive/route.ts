import { NextResponse } from 'next/server'
import { projectArchiveSchema } from '@/src/lib/contracts/project-schemas'
import {
  handleProjectRoute,
  parseJson,
  parseParams,
  projectIdParamsSchema,
  projectRepositories,
} from '../../_shared'

export const runtime = 'nodejs'

export const POST = (
  request: Request,
  context: { params: Promise<{ id: string }> },
) =>
  handleProjectRoute(async () => {
    const params = await parseParams(context.params, projectIdParamsSchema)
    if (!params.success) return params.response
    const body = await parseJson(request, projectArchiveSchema)
    if (!body.success) return body.response
    const project = projectRepositories().projects.archive(
      params.data.id,
      body.data,
    )
    return NextResponse.json({ project })
  })
