import { NextResponse } from 'next/server'
import { projectResourceRevisionCreateSchema } from '@/src/lib/contracts/project-schemas'
import {
  handleProjectRoute,
  notFound,
  parseJson,
  parseParams,
  projectRepositories,
  projectResourceParamsSchema,
} from '../../../../_shared'

export const runtime = 'nodejs'

export const POST = (
  request: Request,
  context: { params: Promise<{ id: string; resourceId: string }> },
) =>
  handleProjectRoute(async () => {
    const params = await parseParams(context.params, projectResourceParamsSchema)
    if (!params.success) return params.response
    const body = await parseJson(request, projectResourceRevisionCreateSchema)
    if (!body.success) return body.response
    const repositories = projectRepositories()
    const revision = repositories.resources.addRevision(
      params.data.id,
      params.data.resourceId,
      body.data,
    )
    const result = repositories.resources.get(
      params.data.id,
      params.data.resourceId,
    )
    if (!result) return notFound('resource_not_found')
    return NextResponse.json(
      { resource: result.resource, revision },
      { status: 201 },
    )
  })
