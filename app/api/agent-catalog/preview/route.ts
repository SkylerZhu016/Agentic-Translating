export const runtime = 'nodejs'

import { z } from 'zod'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { seed } from '@/src/lib/db/seed'
import { createRepositories } from '@/src/lib/db/repositories'
import { createVNextRepositories } from '@/src/lib/db/vnext-repositories'
import { runIndependentAgentTest } from '@/src/lib/services/agent-test-service'

const inputSchema = z.object({
  direction: z.enum(['en_to_zh', 'zh_to_en']),
  promptLanguage: z.enum(['zh', 'en']),
  rolePrompt: z.string().min(1),
  sourceText: z.string().min(1),
  taskBrief: z.string().default(''),
  additionalInstruction: z.string().default(''),
  endpointId: z.number().int().positive(),
  model: z.string().min(1),
})

export async function POST(request: Request) {
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
  const endpoint = repositories.endpoints.getById(parsed.data.endpointId)
  const bundle = vnext.directionPrompts.getLatest(parsed.data.direction)
  if (!endpoint || !bundle) {
    return Response.json(
      { error: 'endpoint_or_prompt_bundle_not_found' },
      { status: 404 },
    )
  }

  try {
    return Response.json(await runIndependentAgentTest({
      prompt: {
        promptLanguage: parsed.data.promptLanguage,
        workerBasePrompt: bundle.workerBasePrompt,
        rolePrompt: parsed.data.rolePrompt,
        sourceText: parsed.data.sourceText,
        taskBrief: parsed.data.taskBrief,
        additionalInstruction: parsed.data.additionalInstruction,
      },
      endpoint: {
        baseUrl: endpoint.base_url,
        chatCompletionsPath:
          endpoint.chat_completions_path ?? '/v1/chat/completions',
        apiKey: endpoint.api_key,
      },
      model: parsed.data.model,
    }))
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    )
  }
}
