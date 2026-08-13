import { NextResponse } from 'next/server'
import { projectResourceDecisionSchema } from '@/src/lib/contracts/project-schemas'
import {
  handleProjectRoute,
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
    const body = await parseJson(request, projectResourceDecisionSchema)
    if (!body.success) return body.response
    const result = projectRepositories().resources.reject(
      params.data.id,
      params.data.resourceId,
      body.data,
    )
    return NextResponse.json(result, { status: 201 })
  })
