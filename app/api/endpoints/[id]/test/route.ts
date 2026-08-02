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
    const diagnosticId = crypto.randomUUID()
    return Response.json(
      {
        error: error instanceof Error ? error.message : String(error),
        diagnosticId,
        phase: 'chat_completions',
        elapsedMs: Math.round(performance.now() - started),
        model: body.data.model,
        ...(error instanceof LLMError
          ? {
              code: error.code,
              status: error.status ?? null,
              retryable: error.retryable,
            }
          : {}),
      },
      { status: 502 },
    )
  }
}
