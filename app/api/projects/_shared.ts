import { NextResponse } from 'next/server'
import { z, type ZodError, type ZodType } from 'zod'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import {
  createProjectRepositories,
  ProjectRepositoryError,
  type ProjectRepositoryErrorCode,
} from '@/src/lib/db/project-repositories'

export const projectIdParamsSchema = z
  .object({ id: z.string().uuid() })
  .strict()

export const projectResourceParamsSchema = z
  .object({
    id: z.string().uuid(),
    resourceId: z.string().uuid(),
  })
  .strict()

type ParseResult<T> =
  | { success: true; data: T }
  | { success: false; response: NextResponse }

const repositoryErrorStatuses: Record<ProjectRepositoryErrorCode, number> = {
  project_not_found: 404,
  resource_not_found: 404,
  revision_not_found: 404,
  snapshot_not_found: 404,
  suggestion_not_found: 404,
  session_not_found: 404,
  project_archived: 409,
  stale_project_version: 409,
  stale_resource_revision: 409,
  revision_not_suggested: 409,
  suggestion_not_pending: 409,
  suggestion_already_materialized: 409,
  idempotency_conflict: 409,
  context_already_frozen: 409,
  snapshot_membership_mismatch: 409,
  token_estimate_mismatch: 400,
  direction_mismatch: 400,
  scope_direction_mismatch: 400,
  secret_content_rejected: 400,
  source_reference_invalid: 400,
  validation_failed: 400,
  invalid_stored_json: 500,
  snapshot_integrity_error: 500,
}

export function projectRepositories() {
  const db = getDb()
  migrate(db)
  return createProjectRepositories(db)
}

export function validationFailed(error: ZodError): NextResponse {
  return NextResponse.json(
    { error: 'validation_failed', details: error.flatten() },
    { status: 400 },
  )
}

export function parseUnknown<T>(
  value: unknown,
  schema: ZodType<T>,
): ParseResult<T> {
  const parsed = schema.safeParse(value)
  return parsed.success
    ? { success: true, data: parsed.data }
    : { success: false, response: validationFailed(parsed.error) }
}

export async function parseJson<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<ParseResult<T>> {
  return parseUnknown(await request.json().catch(() => null), schema)
}

export function parseQuery<T>(
  request: Request,
  schema: ZodType<T>,
): ParseResult<T> {
  return parseUnknown(
    Object.fromEntries(new URL(request.url).searchParams.entries()),
    schema,
  )
}

export async function parseParams<T>(
  params: Promise<unknown>,
  schema: ZodType<T>,
): Promise<ParseResult<T>> {
  return parseUnknown(await params, schema)
}

export function notFound(error: 'project_not_found' | 'resource_not_found') {
  return NextResponse.json({ error }, { status: 404 })
}

export async function handleProjectRoute(
  operation: () => Response | Promise<Response>,
): Promise<Response> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof ProjectRepositoryError) {
      if (error.code === 'validation_failed') {
        return NextResponse.json(
          {
            error: error.code,
            details: { formErrors: [error.message], fieldErrors: {} },
          },
          { status: repositoryErrorStatuses[error.code] },
        )
      }
      return NextResponse.json(
        { error: error.code },
        { status: repositoryErrorStatuses[error.code] },
      )
    }
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
