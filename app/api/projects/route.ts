import { NextResponse } from 'next/server'
import {
  projectCreateSchema,
  projectListQuerySchema,
} from '@/src/lib/contracts/project-schemas'
import {
  handleProjectRoute,
  parseJson,
  parseQuery,
  projectRepositories,
} from './_shared'

export const runtime = 'nodejs'

export const GET = (request: Request) =>
  handleProjectRoute(() => {
    const query = parseQuery(request, projectListQuerySchema)
    if (!query.success) return query.response
    return NextResponse.json({
      projects: projectRepositories().projects.list(query.data),
    })
  })

export const POST = (request: Request) =>
  handleProjectRoute(async () => {
    const body = await parseJson(request, projectCreateSchema)
    if (!body.success) return body.response
    const project = projectRepositories().projects.create(body.data)
    return NextResponse.json({ project }, { status: 201 })
  })
