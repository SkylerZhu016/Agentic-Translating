export const runtime = 'nodejs'

import { z } from 'zod'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { createRepositories } from '@/src/lib/db/repositories'
import {
  chatCompletion,
  isAsyncIterable,
  LLMError,
} from '@/src/lib/llm/client'
import { currentRuntimeEndpoint } from '@/src/lib/services/runtime-endpoint-credentials'
import {
  logSafeDiagnostic,
  publicDiagnosticError,
} from '@/src/lib/security/diagnostic-error'

const bodySchema = z.object({ model: z.string().min(1) })

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const id = Number((await params).id)
  const body = bodySchema.safeParse(await request.json().catch(() => null))
  if (!Number.isInteger(id) || id < 1 || !body.success) {
    return Response.json({ error: 'invalid_body' }, { status: 400 })
  }
  const db = getDb()
  migrate(db)
  const endpoint = createRepositories(db).endpoints.getById(id)
  if (!endpoint) return Response.json({ error: 'endpoint_not_found' }, { status: 404 })
  const started = performance.now()
  try {
    const result = await chatCompletion(
      {
        baseUrl: endpoint.base_url,
        chatCompletionsPath:
          endpoint.chat_completions_path ?? '/v1/chat/completions',
        apiKey: endpoint.api_key,
        resolveRuntimeEndpoint: () => currentRuntimeEndpoint(db, id),
      },
      {
        model: body.data.model,
        messages: [
          {
            role: 'user',
            content: 'Reply with exactly: OK',
          },
        ],
        stream: false,
        timeoutMs: 20_000,
      },
    )
    if (isAsyncIterable(result)) throw new Error('unexpected_stream')
    return Response.json({
      ok: true,
      latencyMs: Math.round(performance.now() - started),
      response: result.content,
    })
  } catch (error) {
    const diagnostic = publicDiagnosticError('endpoint_test_failed')
    // Reduce the exception to an allowlisted structural code before logging.
    // Upstream bodies/messages can reflect Authorization, URLs, and prompts.
    const safeCause = error instanceof LLMError
      ? { code: error.code }
      : { code: 'unexpected_error' }
    logSafeDiagnostic({
      scope: 'endpoint.test',
      diagnosticId: diagnostic.diagnosticId,
      cause: safeCause,
    })
    return Response.json(
      {
        ...diagnostic,
        phase: 'chat_completions',
        elapsedMs: Math.round(performance.now() - started),
      },
      { status: 502 },
    )
  }
}
