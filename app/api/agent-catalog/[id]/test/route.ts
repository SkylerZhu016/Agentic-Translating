export const runtime = 'nodejs'

import { z } from 'zod'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { seed } from '@/src/lib/db/seed'
import { createRepositories } from '@/src/lib/db/repositories'
import { createVNextRepositories } from '@/src/lib/db/vnext-repositories'
import { runIndependentAgentTest } from '@/src/lib/services/agent-test-service'
import { publicDiagnosticError } from '@/src/lib/security/diagnostic-error'

const inputSchema = z.object({
  sourceText: z.string().min(1),
  taskBrief: z.string().default(''),
  additionalInstruction: z.string().default(''),
  endpointId: z.number().int().positive().nullable().optional(),
  model: z.string().min(1).optional(),
})

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const parsed = inputSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json(
      { error: 'validation_failed', details: parsed.error.flatten() },
      { status: 400 },
    )
  }
  const db = getDb()
  migrate(db)
  seed(db)
  const repositories = createRepositories(db)
  const vnext = createVNextRepositories(db)
  const variant = vnext.agents.getVariant((await params).id)
  if (!variant) return Response.json({ error: 'not_found' }, { status: 404 })
  const endpointId =
    parsed.data.endpointId ?? variant.endpointOverrideId ??
    repositories.endpoints.list()[0]?.id
  const endpoint = endpointId
    ? repositories.endpoints.getById(endpointId)
    : null
  const model = parsed.data.model ?? variant.modelOverride
  if (!endpoint || !model) {
    return Response.json(
      { error: 'endpoint_and_model_required' },
      { status: 400 },
    )
  }
  const bundle =
    variant.direction === 'en_to_zh' || variant.direction === 'zh_to_en'
      ? vnext.directionPrompts.getLatest(variant.direction)
      : null
  try {
    return Response.json(await runIndependentAgentTest({
      prompt: {
        promptLanguage: variant.promptLanguage,
        workerBasePrompt: bundle?.workerBasePrompt ?? '',
        rolePrompt: variant.rolePrompt,
        sourceText: parsed.data.sourceText,
        taskBrief: parsed.data.taskBrief,
        additionalInstruction: parsed.data.additionalInstruction,
      },
      endpoint: {
        baseUrl: endpoint.base_url,
        chatCompletionsPath:
          endpoint.chat_completions_path ?? '/v1/chat/completions',
        apiKey: endpoint.api_key,
        contextWindow: endpoint.context_window ?? null,
      },
      model,
      ledger: { db, endpointId },
    }))
  } catch {
    return Response.json(
      publicDiagnosticError('agent_test_failed'),
      { status: 502 },
    )
  }
}
