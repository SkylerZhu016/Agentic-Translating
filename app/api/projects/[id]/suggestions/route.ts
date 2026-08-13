import { NextResponse } from 'next/server'
import {
  projectSuggestionCreateSchema,
  projectSuggestionListQuerySchema,
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
    const query = parseQuery(request, projectSuggestionListQuerySchema)
    if (!query.success) return query.response
    const suggestions = projectRepositories().suggestions.list(
      params.data.id,
      query.data,
    )
    return NextResponse.json({ suggestions })
  })

export const POST = (
  request: Request,
  context: { params: Promise<{ id: string }> },
) =>
  handleProjectRoute(async () => {
    const params = await parseParams(context.params, projectIdParamsSchema)
    if (!params.success) return params.response
    const body = await parseJson(request, projectSuggestionCreateSchema)
    if (!body.success) return body.response
    const suggestion = projectRepositories().suggestions.create(
      params.data.id,
      body.data,
    )
    return NextResponse.json({ suggestion }, { status: 201 })
  })
