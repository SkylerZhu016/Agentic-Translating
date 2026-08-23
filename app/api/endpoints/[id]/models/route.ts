export const runtime = 'nodejs'

import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { createRepositories } from '@/src/lib/db/repositories'
import {
  discoverEndpointModels,
  ModelDiscoveryError,
} from '@/src/lib/llm/model-discovery'
import { currentRuntimeEndpoint } from '@/src/lib/services/runtime-endpoint-credentials'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const id = Number((await params).id)
  if (!Number.isInteger(id) || id < 1) {
    return Response.json({ error: '无效的端点 ID' }, { status: 400 })
  }

  const db = getDb()
  migrate(db)
  const endpoint = createRepositories(db).endpoints.getById(id)
  if (!endpoint) {
    return Response.json({ error: '端点不存在' }, { status: 404 })
  }

  try {
    const models = await discoverEndpointModels({
      baseUrl: endpoint.base_url,
      chatCompletionsPath: endpoint.chat_completions_path,
      apiKey: endpoint.api_key,
      resolveRuntimeEndpoint: () => currentRuntimeEndpoint(db, id),
    })
    return Response.json({
      endpointId: id,
      models,
      fetchedAt: new Date().toISOString(),
    })
  } catch (error) {
    const diagnosticId = crypto.randomUUID()
    return Response.json(
      {
        error:
          error instanceof ModelDiscoveryError
            ? error.message
            : '读取模型列表失败',
        diagnosticId,
      },
      { status: 502 },
    )
  }
}
