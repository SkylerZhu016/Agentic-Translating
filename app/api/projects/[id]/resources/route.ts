import { NextResponse } from 'next/server'
import {
  projectResourceCreateSchema,
  projectResourceListQuerySchema,
} from '@/src/lib/contracts/project-schemas'
import {
  handleProjectRoute,
  parseJson,
  parseParams,
  parseQuery,
  projectIdParamsSchema,
  projectRepositories,
} from '../../_shared'

export const runtime = 'nodejs'

export const GET = (
  request: Request,
  context: { params: Promise<{ id: string }> },
) =>
  handleProjectRoute(async () => {
    const params = await parseParams(context.params, projectIdParamsSchema)
    if (!params.success) return params.response
    const query = parseQuery(request, projectResourceListQuerySchema)
    if (!query.success) return query.response
    const resources = projectRepositories().resources.list(
      params.data.id,
      query.data,
    )
    return NextResponse.json({ resources })
  })

export const POST = (
  request: Request,
  context: { params: Promise<{ id: string }> },
) =>
  handleProjectRoute(async () => {
    const params = await parseParams(context.params, projectIdParamsSchema)
    if (!params.success) return params.response
    const body = await parseJson(request, projectResourceCreateSchema)
    if (!body.success) return body.response
    const { resource, currentRevision: revision } =
      projectRepositories().resources.create(params.data.id, body.data)
    return NextResponse.json({ resource, revision }, { status: 201 })
  })
