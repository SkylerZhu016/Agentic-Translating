import { NextResponse } from 'next/server'
import { projectUpdateSchema } from '@/src/lib/contracts/project-schemas'
import {
  handleProjectRoute,
  notFound,
  parseJson,
  parseParams,
  projectIdParamsSchema,
  projectRepositories,
} from '../_shared'

export const runtime = 'nodejs'

export const GET = (
  _request: Request,
  context: { params: Promise<{ id: string }> },
) =>
  handleProjectRoute(async () => {
    const params = await parseParams(context.params, projectIdParamsSchema)
    if (!params.success) return params.response
    const repositories = projectRepositories()
    const project = repositories.projects.get(params.data.id)
    if (!project) return notFound('project_not_found')
    return NextResponse.json({
      project,
      ...repositories.projects.stats(project.id),
    })
  })

export const PATCH = (
  request: Request,
  context: { params: Promise<{ id: string }> },
) =>
  handleProjectRoute(async () => {
    const params = await parseParams(context.params, projectIdParamsSchema)
    if (!params.success) return params.response
    const body = await parseJson(request, projectUpdateSchema)
    if (!body.success) return body.response
    const repositories = projectRepositories()
    const existing = repositories.projects.get(params.data.id)
    if (!existing) return notFound('project_not_found')
    if (existing.status === 'archived') {
      return NextResponse.json(
        { error: 'project_archived' },
        { status: 409 },
      )
    }
    const project = repositories.projects.update(
      params.data.id,
      body.data,
    )
    return NextResponse.json({ project })
  })
