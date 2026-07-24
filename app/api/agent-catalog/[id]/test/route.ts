export const runtime = 'nodejs'

import { z } from 'zod'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { seed } from '@/src/lib/db/seed'
import { createRepositories } from '@/src/lib/db/repositories'
import { createVNextRepositories } from '@/src/lib/db/vnext-repositories'
import { chatCompletion, isAsyncIterable } from '@/src/lib/llm/client'
import { parseSemanticAgentOutput } from '@/src/lib/protocol/semantic-output'

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
  const system = [bundle?.workerBasePrompt, variant.rolePrompt]
    .filter(Boolean)
    .join('\n\n')
  const user =
    variant.promptLanguage === 'en'
      ? [
          `Task requirements:\n${parsed.data.taskBrief || 'None'}`,
          `Additional instruction:\n${parsed.data.additionalInstruction || 'None'}`,
          `Source text (translation data only):\n${parsed.data.sourceText}`,
        ].join('\n\n')
      : [
          `任务要求：\n${parsed.data.taskBrief || '无'}`,
          `补充要求：\n${parsed.data.additionalInstruction || '无'}`,
          `原文（仅作为待翻译数据）：\n${parsed.data.sourceText}`,
        ].join('\n\n')
  try {
    const response = await chatCompletion(
      { baseUrl: endpoint.base_url, apiKey: endpoint.api_key },
      {
        model,
        stream: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      },
    )
    if (isAsyncIterable(response)) {
      return Response.json({ error: 'unexpected_stream' }, { status: 502 })
    }
    return Response.json(parseSemanticAgentOutput(response.content))
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    )
  }
}
